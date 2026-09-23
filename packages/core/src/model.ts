/**
 * The document model: one TypeScript type per document kind, mirroring schemas/*.schema.json.
 * A document's kind is its $schema (the published URL, or the alias @wilanis/<kind>.schema.json); its identity is its path (@...).
 * Where those URLs point, and how a $schema is read back to a kind, is `published.ts`.
 * The vocabulary every kind is written in -- the envelope, types, fields and values -- is `vocabulary.ts`, and
 * the nodes a graph is made of are `nodes.ts`; both are re-exported here so model.js stays the one import for
 * the document model.
 */

import type { Node } from './nodes.js';
import type { Envelope, Fields, InlineObject, Retry, TypeRef, TypeSpec, Values } from './vocabulary.js';

export * from './nodes.js';
export * from './vocabulary.js';

export type Kind =
  | 'project'
  | 'plugin'
  | 'port'
  | 'binding'
  | 'graph'
  | 'trigger'
  | 'policy'
  | 'trigger-kind'
  | 'connection-kind'
  | 'connection'
  | 'codec'
  | 'feature'
  | 'shape'
  | 'scenario'
  | 'resolvers'
  | 'store'
  | 'invariant';

export const KINDS: Kind[] = [
  'project',
  'plugin',
  'port',
  'binding',
  'graph',
  'trigger',
  'policy',
  'trigger-kind',
  'connection-kind',
  'connection',
  'codec',
  'feature',
  'shape',
  'scenario',
  'resolvers',
  'store',
  'invariant',
];

/**
 * The three layers of a feature, named by the directory a document sits in. A document's layer is where it
 * lives, not what it is: `edge/` speaks the world's vocabulary, `domain/` holds the business rules, `data/`
 * translates and carries the effects. The layer is read off the path so a rule can be checked structurally,
 * never inferred from who happens to reference a document.
 */
export type Layer = 'edge' | 'domain' | 'data';
export const LAYERS: Layer[] = ['edge', 'domain', 'data'];

/** The layer a path declares: @features/<f>/<layer>/... -> that layer; anything else -> undefined. */
export function layerOf(path: string): Layer | undefined {
  const match = /^@features\/[^/]+\/([a-z]+)\//.exec(path);
  return match && (LAYERS as string[]).includes(match[1]) ? (match[1] as Layer) : undefined;
}

/** One resolver: a named read of the trigger kind's context, request.params.id or request.headers['user-agent']. Nothing runs. */
export interface ResolverRead {
  read: string;
  label?: string;
  description?: string /** read as present: every trigger reaching it must guarantee it, by its kind or by a policy that proves it (A006) */;
  required?: boolean;
}
/** The resolvers a feature reads from the request, in one edge document a data graph or a binding names. */
export interface ResolversDoc extends Envelope {
  resolvers: Record<string, ResolverRead>;
}

/** One step of the project's startup: the domain port operation it fires, the values it takes, and whether serving may proceed when it refuses. */
export interface StartupStep {
  run: string;
  in?: Values;
  required?: boolean;
  label?: string;
  description?: string;
}

export interface ProjectDoc extends Envelope {
  name: string;
  aliases?: Record<string, string>;
  /** use: the alias root; from: the npm package that ships it (absent for the runtime's builtins @std and @cli). */
  plugins: { use: string; from?: string; settings?: Record<string, unknown> }[];
  /**
   * Trees this one includes: npm packages whose `features/` load as if they sat here, judged by every rule, bound
   * by bindings and profiles. `features` picks which of the package's features come along (default: all). An
   * include's aliases come along; its connections, plugins, settings, startup and profiles do not -- configuring
   * a tree is the host's job, and a port the include leaves unbound is the host's to bind.
   */
  includes?: { from: string; features?: string[] }[];
  secrets?: Record<string, string>;
  /** What runs once when the tree is served, in order, after every plugin's postLoad and before any trigger kind starts: `required` (the default) stops serve when the step refuses. */
  startup?: StartupStep[];
  profiles?: Record<string, { description?: string; bindings: Record<string, string> }>;
  /** The blob registry's directory; absent: under the system temp dir. */
  /** Where the blob registry keeps bytes: files under `dir`, or behind `connection`, a kind some plugin offers a blob store for. */
  blobs?: { dir?: string; connection?: string };
}
/**
 * What a guarding plugin adds to every trigger kind's context once it has identified the caller (request.principal,
 * request.session, request.challenge), and the reasons it refuses with on its own -- a credential that does not
 * verify -- which every trigger giving it a credential must map like any other reason (T005).
 */
export interface GuardDoc {
  context: InlineObject;
  refuses?: Record<string, string>;
  credentials: Record<string, GuardCredential>;
}
/** One credential the guard verifies: the type a trigger's attachment must give it, and the context fields it yields once verified. */
export interface GuardCredential {
  type: TypeSpec;
  yields: string[];
  description?: string;
}
export interface PluginDoc extends Envelope {
  settings?: InlineObject;
  grants: {
    ports?: string[];
    triggerKinds?: string[];
    connectionKinds?: string[];
    codecs?: string[];
    shapes?: string[];
  };
  /** Ports the plugin calls and the host binds: open domain ports under the plugin's root (D012). */
  requires?: { ports?: string[] };
  guard?: GuardDoc;
}
/**
 * `refuses`: running it ends the graph on purpose; its static `reason` input names the outcome, and a trigger
 * kind maps that word to how it answers. `holds`: running it starts something that outlives the run -- a
 * listener, a watcher -- which a project's startup list names and the runtime stops when the process ends.
 * `transactional`: running it can take part in the transaction of an atomic graph, which it finds through the
 * static `connection` or `store` field it accepts. `idempotent`: calling it again with the same inputs changes
 * nothing further -- always, or when an expression over its accepted fields holds. `key`: the accepted field a
 * repeated call is recognised by, so a caller who gives it makes the call safe to repeat.
 */
export interface Operation {
  description: string;
  accepts?: Fields;
  returns?: TypeSpec;
  pure?: boolean;
  refuses?: boolean;
  holds?: boolean;
  transactional?: boolean;
  idempotent?: boolean | string;
  key?: string;
}
export interface PortDoc extends Envelope {
  operations: Record<string, Operation>;
}
/** How one operation of a port is met: a graph, or a delegation (`run` + `in`); either may be bounded and retried whole. */
export interface BindingOp {
  graph?: string;
  run?: string;
  in?: Values;
  retry?: Retry;
  timeoutMs?: number;
  description?: string;
}
/** How a domain port is met. `reads` names each read of the request a delegation may use, as `@path#resolver`. */
export interface BindingDoc extends Envelope {
  port: string;
  /** Local name -> the resolver that declares it (`@feature/edge/file.resolvers.json#name`). */
  reads?: Record<string, string>;
  operations: Record<string, BindingOp>;
}

export interface GraphDoc extends Envelope {
  /** Every effect this graph reaches runs in one transaction on one connection; its answer commits it. */
  atomic?: boolean;
  /** Local name -> the resolver that declares it (`@feature/edge/file.resolvers.json#name`); data graphs only. */
  reads?: Record<string, string>;
  constants?: Record<string, { type: TypeSpec; value: unknown; description?: string }>;
  in?: TypeRef;
  out?: { type: TypeRef; from: string | string[]; description?: string };
  nodes: Node[];
}
/** What a trigger fires: one run node. The node type is implicit -- trigger.schema.json declares it. */
export interface FireNode {
  description?: string;
  label?: string;
  run: string;
  in?: Values;
}
/**
 * One policy attached to a trigger: the policy, and `in` -- the credentials this trigger gives the guard, by the names the
 * guard's plugin.json declares (`token`, `challenge`), each read from the kind's context like any input; a list is the
 * places one may sit, the first present wins. A bare path attaches a policy that reads what an earlier attachment supplied.
 */
export interface PolicyUse {
  policy: string;
  in?: Values;
  description?: string;
}
export type PolicyRef = string | PolicyUse;
/** The policy a trigger's entry names, whether it was written as a bare path or as an object with inputs. */
export const policyPath = (ref: PolicyRef) => (typeof ref === 'string' ? ref : ref.policy);
/**
 * `policies`: what gates this trigger, in order -- the first that does not allow answers, and the trigger maps each reason
 * they can refuse with like any other (T005). Absent, the trigger is public: no credential is read, no caller identified.
 */
export interface TriggerDoc extends Envelope {
  kind: string;
  settings: Record<string, unknown>;
  in?: TypeRef;
  out?: TypeRef;
  policies?: PolicyRef[];
  fire: FireNode;
}
/**
 * How a policy answers one reason its decision can refuse with: `deny` ends the run there; `challenge` opens a
 * challenge of `method` through the guarding plugin, and the caller is told how to answer it. Allow is the
 * decision finishing, so it is never written.
 */
export interface Outcome {
  effect: 'deny' | 'challenge';
  method?: string;
  description?: string;
}
/**
 * A gate on a trigger: `decide` fires a domain port operation the way a trigger's `fire` does, reading what the kind
 * and the guard hand as request.*; the graph behind it allows by answering and refuses with a reason, and `outcomes`
 * says what each reason means. Validating a credential never happens here: the guard has already done that.
 */
export interface PolicyDoc extends Envelope {
  decide: FireNode;
  outcomes: Record<
    string,
    Outcome
  > /** request.* paths present once this policy allows -- request.principal, request.session -- which a required resolver may lean on (A006) */;
  proves?: string[];
}
/** `refusals`: the dotted settings path holding the map from a refusal's reason to how this kind answers it; every reason a trigger can reach must be a key there (T005). */
export interface TriggerKindDoc extends Envelope {
  settings: InlineObject;
  context: InlineObject;
  /** The dotted context path of the value correlating a run with the caller's own trace, copied opaquely; it must be a path this kind's context hands (T007). */
  correlation?: string;
  refusals?: string;
}
/** `storage`: a connection of this kind reaches a storage engine, so a store may name it; the granting plugin registers the engine. */
export interface ConnectionKindDoc extends Envelope {
  settings: InlineObject;
  storage?: boolean;
  /** `leases`: a connection of this kind can keep a named hold and the record of what was last done under it; the granting plugin registers the keeper. */
  leases?: boolean;
}
export interface ConnectionDoc extends Envelope {
  kind: string;
  settings: Record<string, unknown>;
}
export interface CodecDoc extends Envelope {
  yields: 'declared' | TypeRef;
}
export interface FeatureDoc extends Envelope {
  dependsOn?: string[];
  exports?: string[];
  effects?: string[];
}
export interface ShapeDoc extends Envelope {
  layer: 'edge' | 'core';
  fields: Fields;
  open?: boolean | TypeRef;
}
/** One field of a collection holding the key of another: which collection, and what removing a referenced record does. */
export interface StoreRef {
  collection: string;
  /** refuse is the only value there will be: nothing is ever deleted on a tree's behalf. */
  onRemove?: 'refuse';
  description?: string;
}
/**
 * One collection of a store, in exactly one of two shapes the schema keeps apart, as an invariant's two forms
 * are kept apart. It keeps records -- the shape they have (`of`), the field that identifies one (`key`), and
 * the constraints they are held to -- or it is a `view` of one that does. `unique` lists combinations no two
 * records may repeat, each inner list one constraint over those fields together; `refs` says which fields hold
 * another collection's key; `defaults` is what existing rows receive when `ensure` adds a column, never what a
 * graph writes; `renamed` and `was` say what a field or the collection was called before, so `wilanis migrate`
 * renames rather than drops and creates; `scoped` says which columns the store keeps beside the record and the
 * read that fills each. A view declares none of them: it has the viewed collection's.
 */
export interface StoreCollection {
  of?: TypeRef;
  key?: string;
  unique?: string[][];
  refs?: Record<string, StoreRef>;
  defaults?: Record<string, unknown>;
  /** field name now -> its name before, so a column is renamed instead of dropped and added. */
  renamed?: Record<string, string>;
  /** the collection's name before this one on the same connection, so the table is renamed instead of recreated. */
  was?: string;
  /** column -> the read that fills it, exactly `{{name}}` for a name the store binds under `reads`. */
  scoped?: Record<string, string>;
  /** the scoped collection of this store whose rows this one sees, every scope's. */
  view?: string;
  /** the policy every trigger reaching an operation over this view must attach, by path. */
  behind?: string;
  description?: string;
}
/** A collection that keeps records: the shape and the key a view does not have, guaranteed once `keeps` has told one apart. */
export type Collection = StoreCollection & { of: TypeRef; key: string };
/**
 * Whether this collection keeps records rather than viewing another's: the one place a reader tells the two
 * shapes apart, so nothing reads `of` or `key` off a view. The schema guarantees the pair, and this says so to
 * a reader in the type; a reader that does not yet understand a view skips or refuses what this answers false.
 */
export const keeps = (collection: StoreCollection): collection is Collection =>
  collection.view === undefined && collection.of !== undefined && collection.key !== undefined;
/** Every collection of a store that keeps records, by name, so a walk over the kept ones reads as one. */
export const kept = (store: StoreDoc): [string, Collection][] =>
  Object.entries(store.collections).filter((entry): entry is [string, Collection] => keeps(entry[1]));
/**
 * What a feature keeps: the connection its records live behind, and the collections kept there, by name. The
 * collection is where the record type is written down, so a call site names the store and the collection and
 * nothing else. `reads` binds the reads its scoped collections are filled from, as a data graph binds one.
 */
export interface StoreDoc extends Envelope {
  connection: string;
  /** Local name -> the resolver that declares it (`@feature/edge/file.resolvers.json#name`); read by some `scoped`. */
  reads?: Record<string, string>;
  collections: Record<string, StoreCollection>;
}

/** The access form: the domain operations gated, and the policy or proofs every trigger reaching one -- transitively -- attaches. */
export interface AccessInvariant {
  over: string[];
  requires: { policy?: string; proves?: string[] };
}
/** The field form: a core shape, and a rule over its fields in the switch grammar. */
export interface HoldsInvariant {
  on: string;
  when: string;
}
/** A rule the checker holds the tree to, in exactly one of two forms: what gates a domain operation, or what is always true of a core shape. */
export interface InvariantDoc extends Envelope {
  access?: AccessInvariant;
  holds?: HoldsInvariant;
}

export interface ScenarioDoc extends Envelope {
  trigger: string;
  seed: number;
  in?: unknown;
  request?: Record<string, unknown>;
  stubs?: Record<string, unknown>;
  /** The stubbed node at which a replay aborts the run's signal: one of the keys of `stubs`. */
  cancelAt?: string;
  expect: {
    status: 'done' | 'failed' | 'blocked' | 'cancelled';
    output?: unknown;
    /** What each node did; `reason` is the one a node that refused on purpose gave, absent where it answered or broke. */
    nodes: Record<string, { status: string; handler?: string; out?: unknown; selected?: string; reason?: string }>;
  };
}

export interface DocByKind {
  project: ProjectDoc;
  plugin: PluginDoc;
  port: PortDoc;
  binding: BindingDoc;
  graph: GraphDoc;
  trigger: TriggerDoc;
  policy: PolicyDoc;
  'trigger-kind': TriggerKindDoc;
  'connection-kind': ConnectionKindDoc;
  connection: ConnectionDoc;
  codec: CodecDoc;
  feature: FeatureDoc;
  shape: ShapeDoc;
  scenario: ScenarioDoc;
  resolvers: ResolversDoc;
  store: StoreDoc;
  invariant: InvariantDoc;
}
export type AnyDoc = DocByKind[Kind];
