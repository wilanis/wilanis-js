/**
 * The embedder: what every trigger kind calls to fire a graph. Compiles once per graph, supplies `in`
 * and `request`, runs the kernel, then judges the answer against the trigger's out type and prunes keys
 * a closed shape does not declare -- the trigger is where the domain's value becomes the edge's.
 */
import { buildEnv, type Compiled, type CompileOptions, Compiler, runGraph } from '@wilanis/compiler';
import type { Codecs, Hold, PluginModule, Scope, Serving } from '@wilanis/core';
import { type BlobStore, conforms, type GuardArgs, type StartupStep, type TriggerDoc, type Type } from '@wilanis/core';
import type { KernelSpec, Report } from '@wilanis/engine';
import { type BlobChoice, blobStoreOf, FileBlobStore } from './blobs.js';
import { correlationOf, type Fired, type Ran, runId, type Started } from './fired.js';
import { gate } from './gate.js';
import { portsOf } from './ports.js';
import { coerceWire, fillTemplates, prune } from './values.js';

export { coerceWire, fillTemplates, prune } from './values.js';

export interface FireOptions {
  stubs?: Record<string, unknown>;
  signal?: AbortSignal /** The blob scope of this run; handlers see it as env.blobs. Absent: the tree's store itself. */;
  blobs?: BlobStore;
}

/** What is told of every run this embedder makes; `Served` is the one that holds them, so a reload keeps them. */
export interface Observers {
  ran(what: Ran): void;
}

/** Whether a value is a credential at all: a value with nothing in it is none. */
function present(value: unknown): boolean {
  if (value === undefined || value === '') return false;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
  return Object.values(value as Record<string, unknown>).some(present);
}

/**
 * The credential one read gives: a list is the places it may sit, the first present wins; anything else is the value
 * where it is present, and undefined where it is not.
 */
function credentialFrom(written: unknown, request: Record<string, unknown>): unknown {
  const filled = fillTemplates(written, { request });
  const value = Array.isArray(written) ? (filled as unknown[]).find(present) : filled;
  return present(value) ? value : undefined;
}

/** The credentials every attachment of a trigger gives, and the reads as written; the first attachment to give one wins. */
function gathered(trigger: TriggerDoc, request: Record<string, unknown>) {
  const found = { credentials: {} as Record<string, unknown>, reads: {} as Record<string, unknown> };
  for (const use of trigger.policies ?? []) if (typeof use !== 'string') take(use.in ?? {}, request, found);
  return found;
}

/** What one attachment gives, added to what earlier attachments already gave. */
function take(
  given: Record<string, unknown>,
  request: Record<string, unknown>,
  found: { credentials: Record<string, unknown>; reads: Record<string, unknown> },
) {
  for (const [name, written] of Object.entries(given)) {
    found.reads[name] ??= written;
    if (found.credentials[name] !== undefined) continue;
    const value = credentialFrom(written, request);
    if (value !== undefined) found.credentials[name] = value;
  }
}

/** What every trigger kind fires a tree through: the gate, the compiled graph, the kernel, and the answer judged. */
export class Embedder {
  private compiler: Compiler;
  private compiled = new Map<string, Compiled>();
  readonly env: Record<string, unknown>;
  readonly missingSecrets: string[];
  /** The tree's blob registry: where every blob's bytes live. Handlers reach it as env.blobs. */
  readonly blobs: BlobStore;
  /** Declared secret key -> its value in the environment, for the one place a document reads one outside a connection: a startup step's in. */
  readonly secrets: Record<string, string>;
  /** What `holds` operations have started, in the order they started it: the runtime stops them in reverse. */
  readonly held: { label: string; stop: () => Promise<void> }[] = [];
  /** A run whose effects are stubbed (rehearse, fuzz, regress): nothing leaves the process, and nothing gates it. */
  readonly stubbed: boolean;
  /** The one plugin that identifies callers, when the project names one. */
  readonly guard: PluginModule | undefined;
  /** What every stamp of every run this embedder makes is read from, so a test can freeze time. */
  readonly clock: () => number;
  /**
   * Who is told of every run. It is the server's, never this embedder's own, because a reload builds a fresh
   * embedder and an observer left on the old one would go quiet without saying so.
   */
  private observers: Observers | undefined;

  constructor(
    readonly scope: Scope,
    readonly plugins: PluginModule[],
    opts: CompileOptions & { env?: NodeJS.ProcessEnv; blobs?: BlobStore; root?: string; clock?: () => number } = {},
  ) {
    this.clock = opts.clock ?? Date.now;
    this.compiler = new Compiler(scope, plugins, opts);
    const processEnv = opts.env ?? process.env;
    const built = buildEnv(scope, processEnv, opts.profile);
    this.secrets = Object.fromEntries(
      Object.entries(scope.project?.secrets ?? {}).map(([name, value]) => [name, processEnv[value] ?? '']),
    );
    const root = opts.root ?? process.cwd();
    // a stubbed run keeps its bytes in files whatever the project names: nothing it does leaves the process
    this.blobs =
      opts.blobs ??
      (opts.stubEffects
        ? new FileBlobStore(root, scope.project?.blobs?.dir)
        : blobStoreOf({ scope, plugins, connections: built.env.connections as BlobChoice['connections'], root }));
    const hold: Hold = what => {
      this.held.push(what);
    };
    this.env = { ...built.env, blobs: this.blobs, hold, root, ports: portsOf(this) };
    this.missingSecrets = built.missing;
    this.stubbed = Boolean(opts.stubEffects);
    this.guard = plugins.find(plugin => plugin.guard);
  }

  /**
   * Give `holds` operations the tree being served, as env.serving, and take the server's observers so every run
   * this embedder makes is told to them. Only `start` and a reload call this: a stubbed run holds nothing and
   * records nothing, since nobody registered with it.
   */
  serve(served: { serving(): Serving } & Observers) {
    (this.env as Record<string, unknown>).serving = served.serving();
    this.observers = served;
  }

  /** Tell whoever is listening what one run did; a run nobody is serving is told to nobody. */
  private observed(what: Ran): void {
    this.observers?.ran(what);
  }

  /** The environment one run sees: the tree's, with this run's blob scope where it has one of its own. */
  envFor(blobs: unknown): Record<string, unknown> {
    return blobs ? { ...this.env, blobs } : this.env;
  }

  /** A port operation as `path#operation`, canonical, for a record that names what ran across restarts. */
  private opPath(opRef: string): string {
    const found = this.scope.op(opRef);
    return typeof found === 'string' ? opRef : `${found.path}#${found.opName}`;
  }

  /** The compiled form of one graph, compiled the first time it is asked for and kept for every run after. */
  graph(ref: string): Compiled {
    const path = this.scope.canon(ref);
    let found = this.compiled.get(path);
    if (!found) {
      found = this.compiler.graph(path);
      this.compiled.set(path, found);
    }
    return found;
  }

  /**
   * The nested spec a list site's guard runs, by the name its `map` calls it under, once the graph that carries
   * it has been compiled. Neither a graph nor a binding, so a walk over what a run does cannot reach it from a
   * document and asks the compiler for it by name instead (RFC 0007).
   */
  guardSpec(name: string): KernelSpec | undefined {
    return this.compiler.guardSpec(name);
  }

  /** The compiled binding behind a trigger's port operation. Compiled once per operation, like a graph. */
  operation(opRef: string): Compiled {
    const key = `op:${this.scope.canon(opRef.split('#')[0])}#${opRef.split('#')[1] ?? ''}`;
    let found = this.compiled.get(key);
    if (!found) {
      found = this.compiler.operation(opRef);
      this.compiled.set(key, found);
    }
    return found;
  }

  /**
   * Run one of the project's startup steps: the domain port operation it names, with its `in` written as
   * literals and {{secrets.*}}. Nothing has been received, so the run is given no request -- the checker
   * has already refused any step that reaches a read of one. What it did is told to whoever is listening as a
   * `Started` and never as a `Fired`: a step is not a trigger, it has no kind, no correlation and no gate.
   * `at` is required and never defaulted: a step's index is a real position in `project.json → startup`, which
   * the record exports as `wilanis.startup.at`, so a caller that does not know it must not be given a false one.
   */
  async startup(step: StartupStep, opts: FireOptions & { at: number }): Promise<Report> {
    const compiled = this.operation(step.run);
    const input = fillTemplates(step.in ?? {}, { secrets: this.secrets }) as Record<string, unknown>;
    const startedAt = this.clock();
    const answer = await runGraph(compiled, {
      initial: { in: input },
      signal: opts.signal,
      clock: this.clock,
      env: this.envFor(opts.blobs),
    });
    this.observed({
      id: runId(startedAt),
      at: opts.at,
      label: step.label ?? step.run,
      run: this.opPath(step.run),
      answer,
      startedAt,
      endedAt: this.clock(),
    } satisfies Started);
    return answer;
  }

  /**
   * The trigger's in/out types, resolved. A policy rehearsed as a trigger declares no `in` and writes `fire.in`
   * all the same; its input is then what the decision accepts.
   */
  types(trigger: TriggerDoc): { in?: Type; out?: Type } {
    const accepts = () => {
      const operation = this.scope.op(trigger.fire.run);
      return typeof operation === 'string' || !Object.keys(operation.op.accepts ?? {}).length
        ? undefined
        : this.scope.types.fields(operation.op.accepts);
    };
    const inType = () => {
      if (trigger.in) return this.scope.types.ref(trigger.in);
      return trigger.fire.in !== undefined ? accepts() : undefined;
    };
    return { in: inType(), out: trigger.out ? this.scope.types.ref(trigger.out) : undefined };
  }

  /**
   * What the guard is handed: the credentials the trigger's policy attachments give, read from the context -- a list is
   * the places one may sit, the first present wins; a value with nothing in it is no credential -- and the reads as
   * written, so the guard can say where an answer goes.
   */
  guardArgs(trigger: TriggerDoc, request: Record<string, unknown>): GuardArgs {
    const settings = this.guard
      ? ((this.env.plugins as Record<string, Record<string, unknown>>)[this.guard.root] ?? {})
      : {};
    const { credentials, reads } = gathered(trigger, request);
    return { trigger, kind: this.scope.canon(trigger.kind), request, credentials, reads, settings, env: this.env };
  }

  /** The codec table of a plugin's settings, resolved to implementations: content type -> codec. */
  codecsOf(root: string): Codecs {
    const settings = (this.env.plugins as Record<string, Record<string, unknown>>)[root] ?? {};
    const table = (settings.codecs ?? {}) as Record<string, string>;
    const out: Codecs = {};
    for (const [ct, path] of Object.entries(table)) {
      for (const plugin of this.plugins) {
        const found = plugin.codecs?.[path];
        if (found) out[ct.toLowerCase()] = found;
      }
    }
    return out;
  }

  /**
   * Build the trigger's input from its context: the `input` mapping when declared, else the decoded body.
   * Answers the input, or the reason it does not conform to the trigger's in type.
   */
  inputFor(trigger: TriggerDoc, request: Record<string, unknown>): { input: unknown } | { error: string } {
    const type = this.types(trigger).in;
    if (!type) return { input: undefined };
    const raw = trigger.fire.in !== undefined ? fillTemplates(trigger.fire.in, { request }) : request.body;
    const input =
      type.kind === 'object' && raw && typeof raw === 'object' && !Array.isArray(raw)
        ? Object.fromEntries(
            Object.entries(raw as Record<string, unknown>).map(([name, value]) => [
              name,
              type.fields[name] ? coerceWire(value, type.fields[name].type) : value,
            ]),
          )
        : raw;
    const bad = conforms(input, type);
    return bad ? { error: bad } : { input };
  }

  /**
   * The report of one trigger's run: the gate's answer where it ends the run, else the port operation's, with the
   * output pruned to what a closed out shape declares and judged against it. This is where the domain's value
   * becomes the edge's. What the whole fire did -- the gate's decisions, allowed or not, the guard's timing, the
   * run -- is assembled as a `Fired` and told to whoever is listening; a stubbed run tells nobody, since nothing
   * is serving it.
   */
  async fire(
    trigger: TriggerDoc,
    input: unknown,
    request: Record<string, unknown>,
    opts: FireOptions = {},
  ): Promise<Report> {
    const startedAt = this.clock();
    const gated = await gate(this, trigger, request, { stubbed: this.stubbed, ...opts });
    const run = gated.ended ? undefined : await this.ran(trigger, input, request, opts);
    const answer = gated.ended ?? (run as Report);
    const correlation = this.correlation(trigger, request);
    this.observed({
      id: runId(startedAt),
      trigger: this.pathOf(trigger),
      kind: this.scope.canon(trigger.kind),
      ...(correlation ? { correlation } : {}),
      ...(gated.identify ? { identify: gated.identify } : {}),
      decisions: gated.decisions,
      ...(run ? { run } : {}),
      answer,
      startedAt,
      endedAt: this.clock(),
    } satisfies Fired);
    return answer;
  }

  /** The trigger's operation, run, settled with the guard, and judged against the trigger's out type. */
  private async ran(
    trigger: TriggerDoc,
    input: unknown,
    request: Record<string, unknown>,
    opts: FireOptions,
  ): Promise<Report> {
    const initial: Record<string, unknown> = { request };
    if (input !== undefined) initial.in = input;
    const report = await runGraph(this.operation(trigger.fire.run), {
      initial,
      stubs: opts.stubs,
      signal: opts.signal,
      clock: this.clock,
      env: this.envFor(opts.blobs),
    });
    const guard = this.guard?.guard;
    if (guard?.settle && !this.stubbed && trigger.policies?.length)
      await guard.settle({ ...this.guardArgs(trigger, request), report });
    const declared = trigger.out ? this.types(trigger).out : undefined;
    return report.status === 'done' && declared ? judged(report, declared, trigger.out ?? '') : report;
  }

  /** The canonical path the trigger is written at, or its kind and operation where it is not one of the tree's. */
  private pathOf(trigger: TriggerDoc): string {
    const found = this.scope.registry.all('trigger').find(one => one.doc === trigger);
    return found?.path ?? this.opPath(trigger.fire.run);
  }

  /** What correlates this run with its caller's own trace: the value at the path the trigger's kind declares. */
  private correlation(trigger: TriggerDoc, request: Record<string, unknown>): string | undefined {
    const kind = this.scope.get('trigger-kind', trigger.kind);
    return correlationOf(request, kind?.doc.correlation);
  }
}

/** A done report judged against the trigger's out type: pruned to what a closed shape declares, or refused. */
function judged(report: Report, type: Type, out: string): Report {
  const output = prune(report.output, type); // a closed out shape keeps only what it declares
  const bad = conforms(output, type);
  if (!bad) return { ...report, output };
  return {
    ...report,
    status: 'failed',
    nodes: {
      ...report.nodes,
      out: { status: 'failed', error: `the answer does not conform to ${out}: ${bad}` },
    },
  };
}
