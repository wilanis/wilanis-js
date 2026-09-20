/**
 * Reading a store document from the environment a handler is given. A call site names the store and the
 * collection; everything else -- the connection, its kind and settings, the record's shape, the field that
 * identifies one -- is read from documents the tree already holds, the way @http reads a connection.
 */
import type { Resolves } from '@wilanis/core';
import type { At, Engine, Ref } from './engine.js';
import { engines } from './engine.js';
import type { Lowering } from './ensure.js';

type Connection = { kind: string; settings: Record<string, unknown> };

/** The environment a handler reads: what the runtime built for the tree it is running. */
interface Env {
  canon?: (ref: string) => string;
  connections?: Record<string, Connection>;
  resolving?: Resolves;
}

/** One collection as a store document declares it: the record-keeping shape, since a view declares no `of`. */
interface Declared {
  of: string;
  key: string;
  unique?: string[][];
  refs?: Record<string, { collection: string }>;
  defaults?: Record<string, unknown>;
}
interface StoreDocument {
  connection: string;
  collections: Record<string, Partial<Declared> & { view?: string; scoped?: Record<string, string> }>;
}

/**
 * The collections of a store that keep records, by name. A view has no shape, no key and no table of its own,
 * so nothing here -- the references, the plan, the engine -- has anything to do with one: it is the viewed
 * collection's rows that exist, and reading them through a view is RFC 0015's later step.
 */
function keeping(store: StoreDocument): Record<string, Declared> {
  const entries = Object.entries(store.collections).filter(
    (entry): entry is [string, Declared] => entry[1].view === undefined && !!entry[1].of && !!entry[1].key,
  );
  return Object.fromEntries(entries);
}

const canonOf = (env: Record<string, unknown>) => (env as Env).canon ?? ((ref: string) => ref);

/** The store document a call names, or the reason it is not one this tree holds. */
function documentOf(env: Record<string, unknown>, named: unknown): StoreDocument {
  const resolving = (env as Env).resolving;
  if (!resolving) throw new Error('no tree in this environment to read a store from');
  const doc = resolving.document(String(named));
  if (!doc || typeof doc !== 'object') throw new Error(`unknown store '${named}'`);
  const store = doc as Partial<StoreDocument>;
  if (!store.connection || !store.collections) throw new Error(`'${named}' is not a store document`);
  return store as StoreDocument;
}

/** The connection a store sits on, with its kind canonicalised and its secrets already substituted. */
function connectionOf(env: Record<string, unknown>, store: StoreDocument): { path: string; conn: Connection } {
  const path = canonOf(env)(store.connection);
  const conn = (env as Env).connections?.[path];
  if (!conn) throw new Error(`unknown connection '${store.connection}'`);
  return { path, conn };
}

/**
 * Every reference the store declares, in one list: a field of one collection holding another's key. Both
 * directions are read off the same declaration, so no collection has to be visited twice to learn who points
 * at it.
 */
function refsOf(store: StoreDocument): Ref[] {
  return Object.entries(keeping(store)).flatMap(([from, declared]) =>
    Object.entries(declared.refs ?? {}).map(([field, ref]) => ({ from, field, to: ref.collection })),
  );
}

/** One collection of a store, as the engine sees it: where it lives, what it is called, its shape and its key. */
export function collectionAt(env: Record<string, unknown>, named: unknown, name: unknown): At {
  const store = documentOf(env, named);
  const collections = keeping(store);
  const declared = collections[String(name)];
  if (!declared) {
    const names = Object.keys(collections).join(', ') || 'none';
    throw new Error(`store '${named}' has no collection '${name}' (collections: ${names})`);
  }
  const { path, conn } = connectionOf(env, store);
  const resolving = (env as Env).resolving;
  if (!resolving) throw new Error('no tree in this environment to read a shape from');
  const refs = refsOf(store);
  return {
    connection: path,
    kind: conn.kind,
    settings: conn.settings,
    name: String(name),
    shape: resolving.type(declared.of),
    key: declared.key,
    unique: declared.unique ?? [],
    defaults: declared.defaults ?? {},
    refs: refs.filter(ref => ref.from === String(name)),
    referenced: refs.filter(ref => ref.to === String(name)),
  };
}

/**
 * The columns a store keeps beside one collection's records, by name -- what the collection declares `scoped`,
 * read straight off the document. It is the store's own word about which columns a scope must fill, which is
 * what a handler holds an arriving `scope` to; the reads that fill them are the compiler's business and no
 * handler ever sees one. A collection that declares none, and a view, answer nothing.
 */
export function scopedAt(env: Record<string, unknown>, named: unknown, name: unknown): string[] {
  const declared = documentOf(env, named).collections[String(name)];
  if (!declared || declared.view !== undefined) return [];
  return Object.keys(declared.scoped ?? {});
}

/**
 * A store as the planner reads it: the connection it sits on, its collections with the marks RFC 0017 adds,
 * and the way to resolve the shape each names. It is the whole store rather than a collection at a time,
 * because a plan is a plan for one connection -- a `ref` names a table that has to exist, and a collection
 * planned alone could not know whether it does.
 */
export function storeFor(env: Record<string, unknown>, named: unknown): Lowering {
  const store = documentOf(env, named);
  const { path, conn } = connectionOf(env, store);
  const resolving = (env as Env).resolving;
  if (!resolving) throw new Error('no tree in this environment to read a shape from');
  return {
    on: { connection: path, kind: conn.kind, settings: conn.settings },
    declaring: { connection: path, collections: keeping(store) },
    shapeOf: (of: string) => resolving.type(of),
  };
}

/**
 * The engine that keeps these records: the one registered for the connection's kind. Where none is, the tree
 * names no plugin that grants that kind an engine -- which X203 refuses before anything runs, so this message
 * is for a plugin that failed to load rather than for a tree that is wrong.
 */
export function engineFor(env: Record<string, unknown>, at: { kind: string }): Engine {
  const engine = engines(env).for(at.kind);
  if (engine) return engine;
  const registered = engines(env).kinds.join(', ') || 'none';
  throw new Error(
    `no storage engine for connection kind '${at.kind}': add the package that grants it to project.json -> plugins (registered: ${registered})`,
  );
}
