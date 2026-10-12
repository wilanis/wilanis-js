/**
 * What both judges read off a document: the variables a call site binds, the inputs a delegation passes
 * on, the nodes a graph answers with, which collection of which store a native call site is over, and which
 * connection it goes to, as written and as a profile reaches it. The checker and the compiler agree on these
 * by sharing them.
 */
import {
  type Field,
  type GraphDoc,
  type Names,
  type Operation,
  type PortDoc,
  parsePath,
  resolvedHere,
  type Scope,
  type Type,
  type Values,
} from '@wilanis/core';

/**
 * The variables an operation binds at one call site, through both channels: a `type` field whose literal is
 * the type, and a static field whose `resolves` says where the type is written down. The checker and the
 * compiler share this, so neither can differ from the other about what a call site binds.
 */
export function bindings(scope: Scope, op: Operation, given: Values | undefined): Record<string, Type> {
  const subst: Record<string, Type> = resolvedHere(op.accepts, given ?? {}, scope.resolving());
  for (const [name, field] of Object.entries(scope.types.accepted(op.accepts))) {
    if (!field.binds || field.type !== 'type') continue;
    const value = given?.[name];
    if (typeof value !== 'string') continue;
    try {
      subst[field.binds] = scope.types.spec(value);
    } catch {
      /* unknown type: R001 elsewhere */
    }
  }
  return subst;
}

/**
 * What a delegation hands its target: the statement's own values, and for every input it does not give that
 * the bound operation also accepts, the caller's value by name.
 */
export function passedInputs(scope: Scope, target: Operation, op: Operation, given: Values | undefined): Values {
  const out: Values = { ...(given ?? {}) };
  const ours = scope.types.accepted(op.accepts);
  for (const name of Object.keys(scope.types.accepted(target.accepts))) {
    if (!(name in out) && ours[name]) out[name] = `{{in.${name}}}`;
  }
  return out;
}

/** The nodes a graph answers with, in order of preference; nothing when it answers nothing. */
export function outputCandidates(doc: GraphDoc): string[] | undefined {
  if (!doc.out) return undefined;
  return Array.isArray(doc.out.from) ? doc.out.from : [doc.out.from];
}

/**
 * What `collectionOf` asks of a call site: what it names and what it was given there. A `ReachedEffect` is
 * one, so the walk hands its sites straight over, and so is a node or a delegation a rule has in hand.
 */
export interface CallSite {
  /** the `path#operation` the site names */
  key: string;
  given: Values | undefined;
}

/** The collection one native call site is over: the store document it names, and the collection within it. */
export interface CollectionSite {
  /** the canonical path of the store document the site names */
  store: string;
  /** the name the site gives the collection, as the store declares it */
  collection: string;
}

/** How a port addresses one collection: the input naming the document, and the input holding the key into it. */
interface Address {
  named: string;
  by: string;
}

/**
 * Which input of a port names a document keyed by collection, and which input holds the key: read off the
 * `resolves` paths the port writes, so nothing here learns the word `store`. A path whose first segment takes
 * a key by an input -- `collections[collection].of` -- says that the field's literal names a document with a
 * `collections` map and that the named input picks one out of it, which is exactly the pair a reader wants.
 * It is a property of the port and not of one operation, since a port addresses its documents one way: `count`
 * binds no type and writes no path, and is over a collection all the same.
 */
function addressing(port: PortDoc): Address | undefined {
  for (const op of Object.values(port.operations)) {
    // a shape named whole carries no `resolves`: those are a native contract's own fields
    if (typeof op.accepts === 'string') continue;
    for (const [named, field] of Object.entries(op.accepts ?? {})) {
      const by = keyedBy(field);
      if (by) return { named, by };
    }
  }
  return undefined;
}

/** Which input one field's `resolves` takes the collection's name by, or nothing where none of its paths does. */
function keyedBy(field: Field): string | undefined {
  for (const expr of Object.values(field.resolves ?? {})) {
    const path = parsePath(expr);
    if (typeof path === 'string') continue;
    const first = path[0];
    if (first?.name === 'collections' && first.from === 'input') return first.by;
  }
  return undefined;
}

/**
 * The collection a native call site is over, or nothing where it is over none: the site's static inputs read
 * through the port's own `resolves` channel, so the compiler answers it for any port that addresses a store
 * that way and learns nothing of what a store means. A site naming a store the tree lacks, or a collection
 * the store does not declare, answers nothing -- R001 refuses the one and the plugin's X204 the other, where each
 * is named.
 */
export function collectionOf(scope: Scope, site: CallSite): CollectionSite | undefined {
  const hit = scope.op(site.key);
  if (typeof hit === 'string' || !hit.port.native) return undefined;
  const address = addressing(hit.port.doc);
  if (!address) return undefined;
  const named = site.given?.[address.named];
  const collection = site.given?.[address.by];
  if (typeof named !== 'string' || typeof collection !== 'string') return undefined;
  const store = scope.get('store', named);
  if (!store || !(collection in store.doc.collections)) return undefined;
  return { store: store.path, collection };
}

/** The fields of an operation that name a connection or a store (`names`), with the word each says, in field order. */
export function namingFields(scope: Scope, op: Operation): [string, Names][] {
  return Object.entries(scope.types.accepted(op.accepts)).flatMap(([name, field]): [string, Names][] =>
    field.names ? [[name, field.names]] : [],
  );
}

/** The literals one field gives at a call site: a string, or each string of a list; nothing else is a literal here. */
export function literalsOf(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  return Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string') : [];
}

/**
 * Every canonical connection a native call goes to, each once, in field order: what each field the contract
 * marks `names` gives at the call, a connection document as itself and a store as the connection it names. The
 * reach of a profile reads it for which connections the profile needs, so a call that names two -- a store and a
 * lease -- reaches both.
 *
 * It stays quiet throughout. A field that is absent, or names a document that is not there, is the business of
 * the rules that judge the call site and the store itself -- R001 from `checkNamedLiterals` at the call, R001
 * from `checkStore` for a store's connection -- so a tree with one fault answers one refusal rather than the
 * same fault told twice.
 */
export function connectionsOf(scope: Scope, op: Operation, given: Values | undefined): string[] {
  const found: string[] = [];
  for (const [name, names] of namingFields(scope, op)) {
    for (const literal of literalsOf(given?.[name])) {
      const connection = connectionNamed(scope, names, literal);
      if (connection && !found.includes(connection)) found.push(connection);
    }
  }
  return found;
}

/** The canonical connection one literal names: the connection itself, or the store's own; nothing where it names none. */
function connectionNamed(scope: Scope, names: Names, literal: string): string | undefined {
  if (names === 'connection') return scope.get('connection', literal) ? scope.canon(literal) : undefined;
  const store = scope.get('store', literal);
  return store ? scope.canon(store.doc.connection) : undefined;
}

/**
 * The one canonical connection a transactional call's transaction falls on, or nothing where the call does not
 * say: what the operation's one field marked `names` gives (C009 holds a transactional operation to exactly
 * one). The atomic rules read it for where a transaction falls (L010). An operation that marks several fields
 * falls on no one of them, so it answers nothing.
 */
export function connectionOf(scope: Scope, op: Operation, given: Values | undefined): string | undefined {
  const [only, ...more] = namingFields(scope, op);
  if (!only || more.length) return undefined;
  const [first] = literalsOf(given?.[only[0]]);
  return first === undefined ? undefined : connectionNamed(scope, only[1], first);
}

/**
 * The connection a named one is under a profile: the stand-in the profile puts in its place (C018), else
 * itself, and itself too where the stand-in names no connection, which R001 refuses. This is what "one
 * connection" means wherever it is asked: which settings a profile's reach reads, which connection an atomic
 * graph's effects fall on (L010), and the path the environment hands a handler for each connection, which a
 * pool and a transaction are keyed by. Two names a profile resolves to one connection are one connection to
 * all three, since all three ask this.
 */
export function connectionUnder(scope: Scope, named: string, profile: string | undefined): string {
  const reached = scope.connectionFor(named, profile);
  return typeof reached === 'string' ? scope.canon(named) : reached.path;
}
