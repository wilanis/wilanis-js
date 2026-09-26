/**
 * What every rule family shares: the scope, the refusal list, the project, the resolver table, and the small
 * judgements that recur -- typing a spec (R001), visibility (L005), the shapes a type may name (L001), an
 * operation reference (R001, L005), settings where only secrets may appear (C001), the profiles to judge
 * under -- a trigger under those that serve it --, and the reasons an operation can refuse with.
 */
import {
  expr,
  type Fields,
  type Fix,
  isMap,
  type Loaded,
  type Node,
  type Operation,
  type OpHit,
  type ProjectDoc,
  type Read,
  type RefusalList,
  type Scope,
  STRING,
  splitRef,
  type TriggerDoc,
  type Type,
  TypeError_,
  type TypeSpec,
  type Values,
} from '@wilanis/core';
import type { ReachableRefusal } from '../refusals.js';
import { nearest } from './nearest.js';
import { Serving } from './served.js';

/** The direction of the fix: the words every refusal carries, and the edits a rule can prove. */
export type Hint = string | { text: string; fixes: Fix[] };

/** A refusal recorded against one file: the rule, what is wrong, where in the document, and the fix. */
export type Refuser = (code: string, message: string, at: string | undefined, hint: Hint) => void;

/**
 * Types the root of a template read in the caller's context. A string answer is the reason it cannot be read;
 * undefined means the reason was already reported.
 */
export type Resolve = (root: string, path: string[]) => Read | string | undefined;

/** Types a whole value at a call site; undefined when the reason it cannot be typed was already reported. */
export type Reader = (value: unknown, at: string) => Read | undefined;

/** A resolver as judged: the segments below request, the read's type and optionality, and whether the document declared it required. */
export interface JudgedResolver {
  path: string[];
  read: Read;
  required?: boolean;
}

/** The shapes a type written in a document may name: edge or core only, or -- at the data layer -- either. */
export type ShapeLayer = 'edge' | 'core' | null;

/** A type written in a document, judged for the layer it speaks. */
export interface LayerSite {
  spec: TypeSpec;
  from: Loaded;
  at: string;
  layer: ShapeLayer;
  /** what the type belongs to, for messages */
  what: string;
}

/** The effectful operations a feature allows, canonical, and where the list is: the document and path a fix edits, and the same in words. */
export interface Effects {
  allowed: Set<string>;
  file: string;
  path: string;
  at: string;
}

/** What L003 offers for an effect the feature does not allow: the operation added to the feature's list, said and given. */
export function allowing(effects: Effects, key: string): Hint {
  return { text: `add "${key}" to ${effects.at}`, fixes: [{ file: effects.file, at: effects.path, add: key }] };
}

/** Names no resolver, node or constant may take: they are the roots a template reads. */
export const RESERVED = new Set(['in', 'const', 'request', 'secrets']);

const LAYER_HINTS: Record<'edge' | 'core', string> = {
  core: 'core speaks core shapes; a trigger or binding translates edge to core',
  edge: 'edge shapes compose edge shapes only',
};

/** Everything a node reads: its inputs, and for a map the list it iterates. */
export function readValuesOf(node: Node): unknown {
  return isMap(node) ? [node.in ?? {}, node.over] : (node.in ?? {});
}

/**
 * The profiles a walk is made under: each declared one, or the one unnamed profile. Every rule made per
 * profile, and everything said about one, walks this list, so the checker and whoever explains a rule cannot
 * disagree about how many walks there are.
 */
export function profilesOf(scope: Scope): (string | undefined)[] {
  const declared = scope.profiles();
  return declared.length ? declared : [undefined];
}

/** How a message says which profile a judgement was made under, when one was. */
export function underProfile(profile: string | undefined): string {
  return profile ? ` (profile '${profile}')` : '';
}

/**
 * How a message says which profiles a judgement was made under, where one fault was found under several.
 * One fault answers one refusal, so a rule made per profile names every profile that found it rather than
 * repeating itself: nothing where no profile is declared, `(profile 'live')` where one found it.
 */
export function underProfiles(profiles: (string | undefined)[]): string {
  const named = profiles.filter((one): one is string => one !== undefined);
  if (named.length === 0) return '';
  return ` (profile${named.length > 1 ? 's' : ''} ${named.map(one => `'${one}'`).join(', ')})`;
}

/** The field names an expression reads: the first segment of every path and `has` in it. */
export function rootsOf(rule: expr.Expr, out = new Set<string>()): Set<string> {
  if (rule.kind === 'path' || rule.kind === 'has') out.add(rule.path[0]);
  else if (rule.kind === 'len' || rule.kind === 'not') rootsOf(rule.arg, out);
  else if (rule.kind === 'bin') rootsOf(rule.right, rootsOf(rule.left, out));
  return out;
}

/** How a reason names what a site gave a field: written out, or not given. */
function gave(name: string, value: unknown): string {
  return value === undefined ? `${name} is not given` : `${name} is ${JSON.stringify(value)}`;
}

/** Every type reference in a spec, with where it sits. */
function* typeRefs(spec: TypeSpec, at: string): Generator<[string, string]> {
  if (typeof spec === 'string') {
    yield [spec, at];
    return;
  }
  for (const [name, field] of Object.entries(spec.fields)) yield* typeRefs(field.type, `${at}/${name}`);
  if (typeof spec.open === 'string') yield [spec.open, `${at}/open`];
}

/**
 * What every rule family judges through: the scope, the project and the refusal list, plus the judgements
 * that recur -- typing a spec (R001), visibility (L005), the layer a type may name (L001), an operation
 * reference (R001, L005), settings reading secrets only (C001), the profiles, and reachable reasons.
 */
export class Judge {
  /** Every resolvers document as judged, by path: what `resolversFor` hands to the graphs and bindings that name it. */
  readonly resolverReads = new Map<string, Record<string, JudgedResolver>>();
  /** Which profiles serve each trigger, and what each profile reaches on whose behalf: worked out once, when first asked. */
  private serving: Serving | undefined;

  constructor(
    readonly scope: Scope,
    readonly project: Loaded<ProjectDoc>,
    private readonly refusals: RefusalList,
  ) {}

  /** Refusals against one file; a hint that carries fixes is split into the refusal's `hint` and `fixes`. */
  refuser(file: string): Refuser {
    return (code, message, at, hint) => {
      if (typeof hint === 'string') this.refusals.add({ code, file, message, at, hint });
      else this.refusals.add({ code, file, message, at, hint: hint.text, fixes: hint.fixes });
    };
  }

  // ---- types --------------------------------------------------------------------------------------

  /** The type a spec names; R001 when it cannot be resolved. */
  type(spec: TypeSpec | undefined, file: string, at: string): Type | undefined {
    if (spec === undefined) return undefined;
    return this.resolving(() => this.scope.types.spec(spec), file, at, 'wilanis ls shape');
  }

  /** The type of a fields block; R001 when a field's type cannot be resolved. */
  fieldsType(fields: Fields | undefined, file: string, at: string): Type | undefined {
    return this.resolving(() => this.scope.types.fields(fields), file, at);
  }

  private resolving(resolve: () => Type, file: string, at: string, hint = 'wilanis ls shape'): Type | undefined {
    try {
      return resolve();
    } catch (error) {
      if (!(error instanceof TypeError_)) throw error;
      this.refuser(file)('R001', error.message, at, hint);
      return undefined;
    }
  }

  /** The type a spec names, or nothing: the refusal is made where the spec itself is judged. */
  quiet(spec: TypeSpec | undefined): Type | undefined {
    if (spec === undefined) return undefined;
    try {
      return this.scope.types.spec(spec);
    } catch {
      return undefined;
    }
  }

  /** What an operation takes, as one type, quietly: its fields, or the shape it names; nothing when it accepts nothing. */
  acceptsType(op: Operation): Type | undefined {
    const accepts = op.accepts ?? {};
    if (typeof accepts === 'string') return this.quiet(accepts);
    return Object.keys(accepts).length ? this.quiet({ fields: accepts }) : undefined;
  }

  /**
   * What an operation takes, as one type: its fields, or the shape it names. R001 when a field's type or the
   * shape does not resolve, or when the string names a type that is not a shape, since only a shape has fields.
   */
  acceptsTypeAt(op: Operation, file: string, at: string): Type | undefined {
    if (typeof op.accepts !== 'string') return this.fieldsType(op.accepts, file, at);
    const type = this.type(op.accepts, file, at);
    if (!type || (type.kind === 'object' && type.name)) return type;
    const message = `accepts names '${op.accepts}', which is not a shape; an operation takes a shape's fields or fields of its own`;
    this.refuser(file)('R001', message, at, 'name a shape (wilanis ls shape), or write the fields under accepts');
    return undefined;
  }

  /** The fields an operation takes one by one: its own, or those of the shape it names. */
  accepted(op: Operation): Fields {
    return this.scope.types.accepted(op.accepts);
  }

  // ---- documents ----------------------------------------------------------------------------------

  /** The profiles to judge under: each declared one, or the one unnamed profile. */
  profiles(): (string | undefined)[] {
    return profilesOf(this.scope);
  }

  /**
   * The profiles a trigger is judged under: those whose startup serves it (`servedUnder`), or every one where
   * none does. Every rule made per profile over a trigger walks this list, so none refuses a route under a
   * profile that never opens it (`served.ts`).
   */
  profilesServing(trigger: Loaded<TriggerDoc>): (string | undefined)[] {
    return this.served().profilesOf(trigger);
  }

  /**
   * Whether a domain `path#operation` is held to its promise under a profile (B011): unless, under it, only
   * triggers judged elsewhere reach it. What an operation promises on a trigger's behalf is judged where the trigger is.
   */
  judgedUnder(key: string, profile: string | undefined): boolean {
    return this.served().judgedUnder(key, profile);
  }

  private served(): Serving {
    this.serving ??= new Serving(this.scope, this.profiles());
    return this.serving;
  }

  /** L005 when `from` may not name `target`. */
  visible(from: Loaded, target: Loaded, at: string): void {
    const reason = this.scope.visibility(from, target);
    if (reason) this.refuser(from.path)('L005', reason, at, `wilanis describe ${target.path} shows who may name it`);
  }

  /** Resolve path#operation from a document, with visibility; R001 when it names nothing. */
  opAt(opRef: string, from: Loaded, at: string): OpHit | undefined {
    const hit = this.scope.op(opRef);
    if (typeof hit === 'string') {
      this.refuser(from.path)('R001', hit, at, this.misspelt(opRef, from, at));
      return undefined;
    }
    this.visible(from, hit.port, at);
    return hit;
  }

  /**
   * What R001 offers for an operation reference that names nothing: the reference as written with the
   * operation set to the one of its port the name is a small misspelling of (`nearest`), or only the words
   * when the port is unknown, hidden from `from`, or no one operation is near. A wrong port is not a typo; the
   * ports are the tree's, and a fix that traded R001 for L005 would repair nothing.
   */
  private misspelt(opRef: string, from: Loaded, at: string): Hint {
    const text = 'wilanis ls port';
    const { path, op } = splitRef(opRef);
    const port = opRef.includes('#') && path && op ? this.scope.get('port', path) : undefined;
    if (!port || this.scope.visibility(from, port)) return text;
    const meant = nearest(op, Object.keys(port.doc.operations));
    return meant ? { text, fixes: [{ file: from.path, at, set: `${path}#${meant}` }] } : text;
  }

  /** path#operation with the path made canonical. */
  canonOp(opRef: string): string {
    const { path, op } = splitRef(opRef);
    return `${this.scope.canon(path)}#${op}`;
  }

  /** The effectful operations a feature allows. */
  effectsOf(feature: string | undefined): Effects {
    const doc = this.scope.registry.get('feature', `@features/${feature}/feature.json`)?.doc;
    const file = `@features/${feature}/feature.json`;
    const allowed = new Set((doc?.effects ?? []).map(effect => this.canonOp(effect)));
    return { allowed, file, path: 'effects', at: `${file} → effects` };
  }

  /** Every reason reachable under any of the profiles (each one, unless told), with the first file found refusing with it. */
  reachableReasons(
    reach: (profile: string | undefined) => ReachableRefusal[],
    profiles = this.profiles(),
  ): Map<string, string> {
    const reasons = new Map<string, string>();
    for (const profile of profiles) {
      for (const refusal of reach(profile)) if (!reasons.has(refusal.reason)) reasons.set(refusal.reason, refusal.file);
    }
    return reasons;
  }

  // ---- repeating a call ---------------------------------------------------------------------------

  /**
   * Why a call of `hit` given `given` is not idempotent where it is made, or nothing when it is (RFC 0011): a
   * pure operation, one that declares itself so, one whose expression holds over the site's literal inputs, or
   * one whose key the site gives. Every rule about repeating a call asks this, so none can disagree.
   */
  idempotentAt(hit: OpHit, given: Values | undefined): string | undefined {
    const { op } = hit;
    if (op.pure === true || op.idempotent === true) return undefined;
    if (typeof op.idempotent === 'string') return this.holdsAt(op.idempotent, given ?? {});
    if (op.key) return given?.[op.key] === undefined ? `'${op.key}' is not given` : undefined;
    if (op.idempotent === false) return `'${hit.path}#${hit.opName}' declares it is not idempotent`;
    return `'${hit.path}#${hit.opName}' declares neither idempotent nor key`;
  }

  /** Why an `idempotent` expression does not hold over what a site gives, or nothing when it does. */
  private holdsAt(rule: string, given: Values): string | undefined {
    let parsed: expr.Expr;
    try {
      parsed = expr.parse(rule);
    } catch (error) {
      return `its idempotent rule '${rule}' cannot be judged: ${(error as Error).message}`;
    }
    const roots = [...rootsOf(parsed)];
    for (const root of roots) {
      const value = given[root];
      if (value === undefined || this.scope.literal(value)) continue;
      const read = typeof value === 'string' ? value : JSON.stringify(value);
      return `${root} is read from ${read}; write it as a literal`;
    }
    if (expr.evaluate(parsed, given)) return undefined;
    return roots.map(root => gave(root, given[root])).join(', ');
  }

  // ---- values -------------------------------------------------------------------------------------

  /** Type a value where only {{secrets.<key>}} may be read; `why` says why nothing else may. */
  secretsRead(value: unknown, why: string): Read | string | undefined {
    const secrets = this.scope.project?.secrets ?? {};
    return this.scope.valueRead(value, (root, path) => {
      if (root !== 'secrets') return `{{${[root, ...path].join('.')}}}: ${why}`;
      if (path.length !== 1) return `{{secrets.${path.join('.')}}}: a secret is one key`;
      if (!(path[0] in secrets)) return `secret '${path[0]}' is not declared in project.json secrets`;
      return { type: STRING, optional: false };
    });
  }

  /** Type a settings block; C001 when it reads anything but a secret. */
  settingsRead(value: unknown, file: string, at: string): Read | undefined {
    const read = this.secretsRead(value, 'only {{secrets.<key>}} may appear in settings');
    if (typeof read !== 'string') return read;
    this.refuser(file)('C001', read, at, 'declare the key under project.json → secrets');
    return undefined;
  }

  // ---- layers -------------------------------------------------------------------------------------

  /** L001, L005 for every shape a type written in a non-native document names. */
  checkLayer(site: LayerSite): void {
    for (const [ref, where] of typeRefs(site.spec, site.at)) this.checkTypeRef(site, ref, where);
  }

  private checkTypeRef(site: LayerSite, ref: string, where: string): void {
    const refuse = this.refuser(site.from.path);
    const base = ref.replace(/(\[\])+$/, '');
    if (base.startsWith('$') || base === 'type') {
      refuse(
        'L001',
        `${site.what} uses '${base}' -- that belongs to native contracts only`,
        where,
        'name a shape of this tree, or a scalar type',
      );
    }
    if (base === 'unknown' && site.layer === 'core') {
      const hint = 'name the fields, or keep the value at the edge';
      refuse('L001', `${site.what} declares unknown -- only edge shapes and native contracts may`, where, hint);
    }
    if (!base.startsWith('@')) return;
    const target = this.scope.get('shape', base);
    if (!target) return; // R001 elsewhere
    this.visible(site.from, target, where);
    if (site.layer && target.doc.layer !== site.layer) {
      const message = `${site.what} names ${target.doc.layer} shape '${base}' from the ${site.layer} layer`;
      refuse('L001', message, where, LAYER_HINTS[site.layer]);
    }
  }
}
