/**
 * What a gate runs a tree against instead of the world: stubbed effects, a fake environment for the secrets a tree
 * reads, and the input a trigger's fire would be given. Nothing here reaches a network, a disk or a clock.
 */
import type { EffectInfo } from '@wilanis/compiler';
import type { LoadResult } from '@wilanis/core';
import {
  generate,
  hasVars,
  type Loaded,
  policyPath,
  type Resolves,
  resolvedHere,
  rng,
  Scope,
  schemaUrl,
  substitute,
  type TriggerDoc,
  type TriggerKindDoc,
  type Type,
} from '@wilanis/core';
import type { Handler, Report } from '@wilanis/engine';
import { Embedder } from './embed.js';

// ---- stubbing ---------------------------------------------------------------------------------------

const hash = (text: string) => {
  let hash_ = 2166136261;
  for (const char of text) {
    hash_ ^= char.charCodeAt(0);
    hash_ = Math.imul(hash_, 16777619);
  }
  return hash_ >>> 0;
};

/**
 * The type variables this call binds, through both channels: the `type` inputs the operation declares, and
 * the static inputs whose `resolves` says where the type is written down. The same core resolution the
 * checker and the compiler use, so a stubbed effect answers the type a real one would.
 */
function boundHere(info: EffectInfo, given: Record<string, unknown>, tree: Resolves) {
  const subst: Record<string, Type> = resolvedHere(info.op.accepts, given, tree);
  for (const [name, field] of Object.entries(info.op.accepts ?? {})) {
    if (!field.binds || field.type !== 'type' || typeof given[name] !== 'string') continue;
    try {
      subst[field.binds] = tree.type(given[name] as string);
    } catch {
      /* unknown */
    }
  }
  return subst;
}

/** What an effect answers at this call site: its return type with the variables this call binds filled in. */
function answerType(info: EffectInfo, given: Record<string, unknown>, tree: Resolves | undefined): Type | undefined {
  const returns = info.returns;
  if (!returns || !hasVars(returns) || !tree) return returns;
  return substitute(returns, boundHere(info, given, tree));
}

/** Where a replay cancels its run: the dotted path of one stubbed effect, and what aborts the run's signal. */
export interface CancelAt {
  path: string;
  abort: () => void;
}

/**
 * What a stubbed run is asked to do beyond answering: where to write each effect's answer and its type, and the
 * one effect at which the run is cancelled. One object, so a new way to bend a stub joins it rather than the
 * signature.
 */
export interface StubOptions {
  /** Every stubbed answer, by dotted node path: what fuzz records as a scenario's stubs. */
  record?: Record<string, unknown>;
  /** The type each stubbed answer was generated from, by dotted node path. */
  types?: Record<string, Type>;
  /** The effect that, when reached, aborts the run's signal and rejects as an aborted call does (RFC 0012). */
  cancelAt?: CancelAt;
}

/**
 * Every effectful native operation answers a generated value of its declared type, deterministic per seed and node
 * path -- except the one `cancelAt` names, which aborts the run and rejects with `cancelled at <path>`.
 */
export function stubEffects(seed: number, opts: StubOptions = {}) {
  return (info: EffectInfo): Handler =>
    async ({ in: input, ctx }) => {
      const key = ctx.nodePath.join('.');
      if (opts.cancelAt?.path === key) throw aborted(opts.cancelAt);
      return generated(seed, key, answerType(info, input, ctx.env.resolving as Resolves | undefined), opts);
    };
}

/** The value a stubbed effect answers at one node path, written down where the options ask for it. */
function generated(seed: number, key: string, type: Type | undefined, opts: StubOptions): unknown {
  const value = type ? generate(type, rng(seed ^ hash(key))) : undefined;
  if (opts.record) opts.record[key] = value;
  if (opts.types && type) opts.types[key] = type;
  return value;
}

/** Abort the run at a named effect, and the rejection an aborted call answers with. */
function aborted(at: CancelAt): Error {
  at.abort();
  const error = new Error(`cancelled at ${at.path}`);
  error.name = 'AbortError';
  return error;
}

/**
 * The embedder a loaded tree is run through: the real one, or -- where a seed is given -- one whose effects are
 * stubbed and whose secrets come from a fake environment, so nothing leaves the process.
 */
export function embedderFor(
  load: LoadResult,
  opts: {
    seed?: number;
    record?: Record<string, unknown>;
    types?: Record<string, Type>;
    /** The stubbed effect at which a replay cancels its run; only with a seed. */
    cancelAt?: CancelAt;
    profile?: string;
    env?: NodeJS.ProcessEnv;
    /** What every stamp of every run is read from; `Date.now` unless given, so a test can freeze time. */
    clock?: () => number;
  } = {},
): Embedder {
  const scope = new Scope(load.registry, load.resolve);
  const env = opts.env ?? (opts.seed !== undefined ? fakeEnv(scope) : process.env);
  return new Embedder(scope, load.plugins, {
    profile: opts.profile,
    stubEffects:
      opts.seed !== undefined
        ? stubEffects(opts.seed, { record: opts.record, types: opts.types, cancelAt: opts.cancelAt })
        : undefined,
    env,
    root: load.root,
    clock: opts.clock,
  });
}

/** An environment where every declared secret is present, for runs that never leave the process. */
function fakeEnv(scope: Scope): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of Object.values(scope.project?.secrets ?? {})) env[name] = `stub-${name.toLowerCase()}`;
  return env;
}

/** A generated request context for a trigger kind, and a generated input for the trigger. */
export function generatedFire(
  emb: Embedder,
  type: Loaded<TriggerDoc>,
  seed: number,
): { input: unknown; request: Record<string, unknown> } {
  const kind = emb.scope.get('trigger-kind', type.doc.kind)?.doc as TriggerKindDoc;
  const random = rng(seed);
  const request = generate(emb.scope.contextType(kind, type.doc.settings), random) as Record<string, unknown>;
  const types = emb.types(type.doc);
  // the body/input is generated from the trigger's in type so it always conforms; the mapping is then honoured
  if (types.in) {
    if (type.doc.fire.in !== undefined) {
      const built = emb.inputFor(type.doc, request);
      if ('input' in built) return { input: built.input, request };
      return { input: generate(types.in, random), request };
    }
    const input = generate(types.in, random);
    request.body = input;
    return { input, request };
  }
  return { input: undefined, request };
}

/**
 * Every policy as a trigger of each kind that attaches it, for the gates that run triggers. A policy's decision
 * is a domain operation fired with an input read from the context, the way a trigger's is; rehearsed as a
 * root of its own, every branch of the decision graph is walked with a caller that is there and one that is
 * not. The settings are borrowed from an attaching trigger, since a kind's context (route placeholders, the
 * body's shape) is written in them; a policy nothing attaches is rehearsed under the first trigger's kind.
 */
export function policyRoots(load: LoadResult): Loaded<TriggerDoc>[] {
  const out: Loaded<TriggerDoc>[] = [];
  const triggers = load.registry.all('trigger');
  for (const policy of load.registry.all('policy')) {
    const attaching = triggers.filter(type =>
      (type.doc.policies ?? []).some(ref => load.resolve(policyPath(ref)) === policy.path),
    );
    const seen = new Set<string>();
    for (const type of attaching.length ? attaching : triggers.slice(0, 1)) {
      const kind = load.resolve(type.doc.kind);
      if (seen.has(kind)) continue;
      seen.add(kind);
      const doc: TriggerDoc = {
        $schema: schemaUrl('trigger'),
        description: policy.doc.description,
        label: policy.doc.label,
        kind: type.doc.kind,
        settings: type.doc.settings,
        fire: policy.doc.decide,
      };
      out.push({ ...policy, kind: 'trigger', doc } as unknown as Loaded<TriggerDoc>);
    }
  }
  return out;
}

type FailedNode = Report['nodes'][string] & { id: string };

/** The innermost failed node of a report, through nested runs and through the elements of a map. */
export function failedLeaf(report: Report): FailedNode | undefined {
  for (const [id, node] of Object.entries(report.nodes)) {
    if (node.status !== 'failed') continue;
    return failedBelow(id, node) ?? { ...node, id };
  }
  return undefined;
}

/** The failure strictly inside a failed node: in the graph it ran, or in the element of a map that failed. */
export function failedBelow(id: string, node: Report['nodes'][string]): FailedNode | undefined {
  if (node.sub) return failedLeaf(node.sub);
  const at = node.items?.findIndex(item => item.status === 'failed') ?? -1;
  const failed = at < 0 ? undefined : node.items?.[at];
  if (!failed) return undefined;
  return (failed.sub && failedLeaf(failed.sub)) || { ...failed, id: `${id}.${at}` };
}
