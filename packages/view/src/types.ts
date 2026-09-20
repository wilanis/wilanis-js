/**
 * What a page reads: the shapes of the view model. Nothing here computes; these are the types every other module of
 * the view fills in, plus the tree index and the labels a reader sees.
 */
import { checkTree } from '@wilanis/compiler';
import type { Kind, Layer, Loaded, LoadResult, Outcome, Refusal } from '@wilanis/core';
import { SCHEMA_BASE } from '@wilanis/core';

export interface VPort {
  /** The port's name; an attribute port is its path below the parent, joined with dots (body.id). */
  name: string;
  /** How deep an attribute port sits under its parent; absent for a top-level port. */
  depth?: number;
  /** A human label for the port: on the request node, the name the graph reads it by. */
  label?: string;
  /** A document this port stands for: the resolvers document that declares a request read. */
  opens?: string;
  /** The type, shown; absent when unknown. */
  type?: string;
  required?: boolean;
  /** A static field: a literal, never a read. */
  static?: boolean;
  /** The literal value written for this input, when it is one (JSON). */
  literal?: string;
  /** The document a literal names, canonical, when it is a document path (a type, a connection). */
  ref?: string;
  /** The text written for this input when it interpolates reads into text. */
  text?: string;
  /** The input was not given and the operation does not require it. */
  missing?: boolean;
  /** On a map node: the input is read from each element -- the path below it, or '' for the element whole. */
  bound?: string;
  description?: string;
}

/** Where a node's operation leads, so a click can follow it. */
export interface VTarget {
  op: string;
  /** The operation's short name. */
  opName: string;
  /** The port that declares the contract. */
  port: string;
  portLabel: string;
  native: boolean;
  pure?: boolean;
  effect?: boolean;
  /** The operation ends the graph on purpose; the node's `reason` is what the trigger maps. */
  refuses?: boolean;
  /** For a domain port: every binding that meets it, and what each does for this operation. */
  bindings?: { path: string; label: string; graph?: string; graphLabel?: string; run?: string }[];
  /** Where a click lands: the graph behind the first binding, the binding when it delegates, the port when native. */
  implementation: string;
}

export type VNodeKind = 'in' | 'const' | 'request' | 'run' | 'map' | 'rule' | 'out';

export interface VNode {
  id: string;
  kind: VNodeKind;
  /** The node's label, or its id made readable. */
  label: string;
  /** The operation a run or map node runs. */
  op?: string;
  /** The graph's in or out type, shown. */
  type?: string;
  description?: string;
  inputs: VPort[];
  outputs: VPort[];
  /** The fields of the out type, on the out node. */
  fields?: VPort[];
  target?: VTarget;
  /** On a rule node: the decision it belongs to and its place in it. */
  decision?: VDecision;
  /** On a rule node: its condition said in words, one clause per line. */
  says?: VSaid[];
  onItemFailure?: string;
  bind?: Record<string, string>;
  /** On a node that refuses on purpose: every trigger that can reach it, and how each answers its reason. */
  answeredBy?: VAnsweredBy[];
  /** On a node that runs an operation of the store port: the records it reaches, so a click opens them. */
  keeps?: VKeeps;
  /** True on a node of an atomic graph whose operation takes part in the transaction. */
  participates?: boolean;
  /** On a node the compiler put a field invariant's rule in front of: the invariants it is guarded by. */
  guarded?: VGuarded;
  /** On a node that makes or takes a value a field invariant was proved of: which invariants, and how. */
  proved?: VProved;
}

/** Whether a site holds one value of a shape or a list of them: a list is guarded element by element. */
export type VArity = 'one' | 'list';

/**
 * The guard the compiler lowered at one site: which invariants could not be proved there, and the one rule the
 * switch it wrote tests. A site is guarded once however many rules are unproved at it, since two rules over one
 * shape conjoin into one switch -- so the badge names them all and the rule reads as the guard tests it.
 */
export interface VGuarded {
  /** Every invariant unproved here, in registry order, so a click opens the one a reader asks about. */
  by: { path: string; label: string }[];
  /** The rule the guard tests: each unproved rule bracketed, joined by `&&`. */
  when: string;
  arity: VArity;
}

/** The invariants proved at one site, each with the rule and how every conjunct of it was established. */
export interface VProved {
  by: { path: string; label: string; when: string; held: VHeld[] }[];
  arity: VArity;
}

/**
 * How one conjunct of a rule was established at a site, in the three ways RFC 0007 names: the value is written
 * out in literals and the conjunct comes out true, a switch routing here already established it, or the whole
 * value was read from another site of the same shape, which was judged there.
 */
export type VHeld = { by: 'literal' } | { by: 'narrowed'; switch: string } | { by: 'through'; node: string };

/** One site of a field invariant's shape, as its page tables it: where it is, and whether it was proved there. */
export interface VSite {
  /** The graph the value comes into being in, canonical. */
  graph: string;
  graphLabel: string;
  /** The read path the value answers at: the node's id, or `in` where the graph takes it. */
  node: string;
  kind: 'made' | 'taken';
  arity: VArity;
  /** How each conjunct of the rule was established here; absent where it was not proved, and so guarded. */
  held?: VHeld[];
}

/**
 * What one atomic graph's declaration means, for the page that draws it: where the one transaction falls, and
 * what rolls it back. Which nodes take part is marked on the nodes themselves, since a reader points at a node
 * and not at a list. Nothing here is written by an author: it is read from the walk the checker judges by.
 */
export interface VAtomic {
  /** The connections the transaction may fall on, canonical: one where every profile agrees. */
  connections: string[];
  /** The reasons a declared refusal below the graph rolls it back on, sorted. */
  rollsBackOn: string[];
}

/**
 * Where one node's records are: the store document, the collection of it the node names, the shape that
 * collection holds and the operation run against it. A graph names a store and a collection and nothing else,
 * so this is the one hop from a node to what it reads or writes.
 */
export interface VKeeps {
  /** The store document, canonical. */
  store: string;
  label: string;
  /** The collection by the name it declares; absent where the node writes none. */
  collection?: string;
  /** The shape that collection holds, when the store declares it. */
  of?: string;
  /** The operation of the store port, by its short name. */
  op: string;
  /** How the collection is scoped, where it is: the columns the compiler fills here, and nothing a document wrote. */
  scope?: VScope;
}

/**
 * The scope one node carries over a scoped collection: the columns the collection declares and the read that
 * fills each, read off the store and never off the node. No document writes it (X203) and no author can forget
 * it, so a badge on the node is the only place a reader meets it -- which is why it names the store it came from.
 */
export interface VScope {
  /** The store that declares the scope, canonical, so the badge opens it. */
  store: string;
  /** One column per key the collection's `scoped` declares, with the read that fills it. */
  by: VScopedColumn[];
}

/** One scoped column: the column the store keeps beside the record, and the read of the request that fills it. */
export interface VScopedColumn {
  /** The column name the collection declares under `scoped`. */
  column: string;
  /** The local name the store reads it by, as `scoped` writes it: `{{tenant}}` reads as `tenant`. */
  read: string;
  /** The resolvers document that declares that read, canonical, when the store binds one. */
  opens?: string;
  /** The segments below `request` the resolver reads, joined with dots, when it resolves. */
  from?: string;
}

/**
 * A switch is drawn as a ladder: one rule node per rule, in order, each reading only the inputs its condition
 * names. `then` routes to the rule's target; `otherwise` steps to the next rule, and leaves the ladder for the
 * switch's `else` from the last one. So "the first rule that holds wins" is the shape, not a caption.
 */
export interface VDecision {
  /** The switch node's id, shared by every rule of it. */
  id: string;
  label: string;
  description?: string;
  /** The condition as written. */
  when: string;
  /** This rule's place, from 1, and how many there are. */
  rule: number;
  of: number;
  /** The node this rule routes to when it holds. */
  then: string;
  /** Where it goes when it does not: the next rule's id, or the switch's else target from the last rule. */
  otherwise: string;
  /** True on the last rule, whose otherwise leaves the ladder. */
  last: boolean;
}

/**
 * One line of a condition said in words: `if status is 200`, `and body exists`. Its parts are words, values
 * as written, and the inputs the rule reads, so a page can point from a name in the sentence to the port.
 */
export interface VSaid {
  lead: 'if' | 'and' | 'or';
  parts: VSaidPart[];
}
export type VSaidPart = { text: string } | { value: string } | { input: string; text: string };

export interface VEdge {
  from: string;
  /** The output port, or attribute port; '' for the node's whole value. */
  fromPort: string;
  to: string;
  /** The input port; '' for the node itself (a route, or the out node). */
  toPort: string;
  kind: 'data' | 'route' | 'out';
  /** A rule's `when` on a route; the candidate's place on an out edge. */
  label?: string;
}

/** One reference from one document to another: the JSON pointer it sits at, and the document it names. */
export interface VRef {
  path: string;
  label: string;
  kind: Kind;
  at: string;
  /** For a caller reached through a binding: the port operation the binding meets. */
  via?: string;
}

export interface DocView {
  path: string;
  kind: Kind;
  name: string;
  label: string;
  feature?: string;
  layer?: Layer;
  native?: string;
  /** The package this document was included from, when it is another tree's. */
  included?: string;
  /** On a native document: the npm package that ships the plugin, absent for the runtime's builtins. */
  from?: string;
  file?: string;
  description: string;
  doc: unknown;
  /** Documents this one names, with where. */
  refs: VRef[];
  /** Documents that name this one, with where. */
  callers: VRef[];
  refusals: Refusal[];
  graph?: { nodes: VNode[]; edges: VEdge[]; role: 'domain' | 'data'; atomic?: VAtomic };
  /** On a port: every binding that meets it, and what each does per operation. */
  implementations?: {
    path: string;
    label: string;
    operations: Record<string, { graph?: string; graphLabel?: string; run?: string }>;
  }[];
  /** On a trigger: the port operation it fires, and where that leads. */
  fires?: VTarget;
  /** On a trigger whose kind maps refusals: every reason it can reach or maps, how it is answered, and the nodes that refuse with it. */
  answers?: VAnswer[];
  /** On a trigger: the policies that gate it, in order, the operation each decides through, and the credentials the attachment gives the guard. */
  policies?: VAttachedPolicy[];
  /** On a policy: the port operation it decides through, and where that leads. */
  decides?: VTarget;
  /** On a policy: what each reason its decision can refuse with means. */
  outcomes?: Record<string, Outcome>;
  /** On a policy: the request.* paths present once it allows. */
  proves?: string[];
  /** On a policy: every trigger that names it. */
  gates?: { path: string; label: string }[];
  /** On a store: the engine behind it, its collections with their key types, and the calls run against it. */
  store?: VStore;
  /** On an invariant: the form it takes, and what it holds -- the ways in it gates, or the shape and rule it is about. */
  invariant?: VInvariant;
}

/**
 * What an invariant page needs beyond its own JSON: an access form's covered operations and every trigger that
 * reaches one, with what satisfies the rule there; a field form's shape and rule. A reader who has only the
 * document sees a list of operations and cannot see which routes the rule actually binds, which is the whole
 * point of stating it once.
 */
export type VInvariant = VAccessInvariant | VHoldsInvariant;

/** The access form: what must gate every way in, the operations it covers, and the triggers that reach them. */
export interface VAccessInvariant {
  form: 'access';
  /** The policy every reaching trigger attaches, canonical, when the invariant names one. */
  policy?: string;
  policyLabel?: string;
  /** The request.* paths some attached policy must prove, when the invariant names them instead of a policy. */
  proves?: string[];
  /** Each operation the invariant covers, canonical, with the port that declares it. */
  covers: VCovered[];
  /** Every way in the invariant binds: one row per trigger and covered operation it reaches, under any profile. */
  reached: VReaching[];
}

/** One operation an access invariant covers: where a click lands, and what the port calls it. */
export interface VCovered {
  /** The canonical `path#operation`. */
  op: string;
  opName: string;
  /** The port that declares it, canonical. */
  port: string;
  portLabel: string;
}

/** One trigger an access invariant binds: the operation it reaches, how it got there, and what satisfies the rule. */
export interface VReaching {
  trigger: string;
  triggerLabel: string;
  /** The covered operation it reaches, canonical. */
  op: string;
  /** The operation it was reached through, when the trigger does not fire it directly. */
  through?: string;
  /**
   * Every part of `requires` met here, and what meets it: the policy the invariant names, and one per path it
   * requires proved. Empty means the rule is not met -- which is what I001 refuses, unless `unjudged` says the
   * checker never judged it.
   */
  satisfiedBy: { path: string; label: string; proves?: string }[];
  /**
   * The checker declines to judge this way in, because `requires` names something the invariant is itself
   * refused for: a policy the tree has not (R001) or a path the guard cannot hand (I002). No trigger could
   * meet it, so I001 is never raised and a page must not show an empty `satisfiedBy` as a fault here.
   */
  unjudged?: boolean;
}

/**
 * The field form: the shape the rule is about, the rule as written, and every place a value of the shape comes
 * into being with how the rule stands there. The sites are the whole point of stating a rule once -- a reader
 * who sees only the document cannot tell a rule that landed on thirteen graphs from one that landed on none,
 * nor which of them proved it and cost the tree nothing.
 */
export interface VHoldsInvariant {
  form: 'holds';
  /** The core shape, canonical. */
  on: string;
  onLabel: string;
  /** The rule, in the switch grammar, its roots the shape's fields. */
  when: string;
  /** The shape's field names, so a reader can see which roots the rule may name. */
  fields: string[];
  /** Every site of the shape, in the order the compiler walks them: proved, with how, or guarded. */
  sites: VSite[];
}

/**
 * What a store page needs beyond its own JSON: which engine keeps the records and which plugin grants that
 * engine, each collection's key with the type the shape gives it, and every call site that runs an operation
 * against it. None of it is in the document, so a reader who has only the JSON cannot see any of it.
 */
export interface VStore {
  /** The connection its records live behind, canonical. */
  connection: string;
  connectionLabel: string;
  /** The connection kind that connection is of, canonical; empty where the connection names none. */
  kind: string;
  kindLabel: string;
  /** The plugin alias that grants the kind (@storage-memory), when the kind is a plugin's. */
  plugin?: string;
  /** The npm package that ships that plugin, when the project names one. */
  from?: string;
  /** The type of each collection's key, by collection name, where the shape declares the field. */
  keyTypes: Record<string, string>;
  /** Every call that runs an operation against this store. */
  calls: VStoreCall[];
  /** What the store reads from the request to fill its scopes, drawn as a graph's request node is; absent where it reads nothing. */
  request?: VNode;
  /** Each scoped collection, by name, with the columns the store keeps and the read filling each. */
  scoped?: Record<string, VScopedColumn[]>;
  /** Each collection that is a view, by name: the collection it sees every scope of, and the policy it is behind. */
  views?: Record<string, VStoreViewOf>;
}

/** One view of this store: the scoped collection whose rows it sees, and the policy every trigger reaching it attaches. */
export interface VStoreViewOf {
  /** The scoped collection it views, by the name the store declares. */
  of: string;
  /** The policy it is behind, canonical, so the page opens it. */
  behind: string;
  behindLabel: string;
}

/** One call against a store: the document it sits in, where in it, the operation and the collection. */
export interface VStoreCall {
  file: string;
  label: string;
  where: string;
  op: string;
  collection?: string;
}

/**
 * One policy a trigger attaches: where it is, what decides it, and what the attachment gives the guard.
 * `required` is there when the trigger reaches a view this policy is the `behind` of -- the one attachment an
 * author did not choose freely, since A008 refuses the trigger without it.
 */
export interface VAttachedPolicy {
  path: string;
  label: string;
  decide: string;
  gives?: Record<string, unknown>;
  /** The views reaching this trigger requires it for, each with the collection it crosses; absent where none does. */
  required?: VRequiredBy[];
}

/** One view whose `behind` a trigger's attachment is: which collection of which store it crosses. */
export interface VRequiredBy {
  /** The store that declares the view, canonical. */
  store: string;
  storeLabel: string;
  /** The view's name, and the scoped collection it sees every scope of. */
  view: string;
  of: string;
}

/** One refusal reason at a trigger: how the trigger answers it (absent: not mapped), and where it comes from (empty: nothing reaches it). */
export interface VAnswer {
  reason: string;
  answer?: unknown;
  from: { graph: string; graphLabel: string; node: string; nodeLabel: string }[];
}
/** A trigger that reaches a refusing node: how it answers that node's reason. `maps` is false when the kind answers every refusal alike. */
export interface VAnsweredBy {
  trigger: string;
  triggerLabel: string;
  maps: boolean;
  answer?: unknown;
}

export interface IndexEntry {
  path: string;
  kind: Kind;
  name: string;
  label: string;
  feature?: string;
  layer?: Layer;
  native?: string;
  included?: string;
  file?: string;
  description: string;
}

/** A document's label, or its file name made readable (get-row → Get row). */
export function labelOf(doc: Loaded | undefined): string {
  return doc?.doc.label ?? readable(doc?.name ?? '');
}
/** kebab-case, snake_case or camelCase made into words, capitalised once. */
export function readable(id: string): string {
  const words = id
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : id;
}

export interface TreeIndex {
  root: string;
  project?: string;
  /** Every alias in force -- the project's and the includes' -- so a page can canonicalise a reference written through one. */
  aliases: Record<string, string>;
  /** Where the schemas are published, so a page can recognise a $schema written as a URL. */
  schemaBase: string;
  docs: IndexEntry[];
  refusals: Refusal[];
}

/** Every document of the tree and every refusal, for the document list. */
export function indexOf(load: LoadResult): TreeIndex {
  const refusals = checkTree(load).items;
  const docs = load.registry.files
    .slice()
    .sort((one, other) => one.kind.localeCompare(other.kind) || one.path.localeCompare(other.path))
    .map(file => ({
      path: file.path,
      kind: file.kind,
      name: file.name,
      label: labelOf(file),
      feature: file.feature,
      layer: file.layer,
      native: file.native,
      file: file.file,
      description: file.doc.description,
    }));
  return {
    root: load.root,
    project: load.registry.project?.doc.name,
    aliases: load.aliases,
    schemaBase: SCHEMA_BASE,
    docs,
    refusals,
  };
}
