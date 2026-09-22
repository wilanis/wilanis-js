/**
 * What a store page and a store-reaching graph node show beyond the JSON: the engine behind the records, each
 * collection's key type, the calls run against the store, and -- on one node -- which collection of which store
 * it reaches and how that collection is scoped. The walks themselves live in the runtime, so `describe` and this
 * page cannot differ about them. How a scope is read off a store is `scopes.ts` beside this: the store page and
 * the node badge ask it the same question, so neither can say a column the other does not.
 */
import type { Loaded, LoadResult, Scope, StoreDoc, Values } from '@wilanis/core';
import { keeps, kept, splitRef } from '@wilanis/core';
import { callsAgainst, engineOf, keyTypeOf, STORE_PORT } from '@wilanis/runtime';
import { markRequestPorts, readsOf } from './reads.js';
import { type Over, scopedColumns, scopeOf, viewsOf } from './scopes.js';
import type { VKeeps, VNode, VScopedColumn, VStore, VStoreCall } from './types.js';
import { labelOf } from './types.js';

/** The type of every collection's key, by collection name, where the shape it names declares the field. */
function keyTypesOf(store: StoreDoc, scope: Scope): Record<string, string> {
  const types: Record<string, string> = {};
  for (const [name, collection] of kept(store)) {
    const type = keyTypeOf(collection.of, collection.key, scope);
    if (type) types[name] = type;
  }
  return types;
}

/** Every call run against this store, each with the label of the document it sits in. */
function callsOf(path: string, load: LoadResult, scope: Scope): VStoreCall[] {
  return callsAgainst(path, load, scope).map(call => ({
    file: call.file,
    label: labelOf(scope.registry.any(call.file)),
    where: call.where,
    op: call.op,
    ...(call.collection ? { collection: call.collection } : {}),
  }));
}

/** Each scoped collection of a store, by name, with the columns it keeps; absent where the store scopes none. */
function scopedOf(scope: Scope, doc: Loaded<StoreDoc>): Record<string, VScopedColumn[]> {
  const out: Record<string, VScopedColumn[]> = {};
  for (const [name, collection] of Object.entries(doc.doc.collections)) {
    const columns = scopedColumns(scope, doc, collection);
    if (columns.length) out[name] = columns;
  }
  return out;
}

/**
 * What a store adds to its view: the engine that keeps its records, its key types, what runs against it, and --
 * where it scopes a collection -- what it reads from the request, drawn as a graph's request node is, with the
 * scope and the views that cross it. A store that scopes nothing carries none of the three.
 */
export function storeView(scope: Scope, load: LoadResult, doc: Loaded): VStore {
  const store = doc.doc as StoreDoc;
  const engine = engineOf(store, scope);
  const scoped = scopedOf(scope, doc as Loaded<StoreDoc>);
  const views = viewsOf(scope, store);
  return {
    connection: engine.connection,
    connectionLabel: labelOf(scope.registry.any(engine.connection)),
    kind: engine.kind,
    kindLabel: engine.kind ? labelOf(scope.registry.any(engine.kind)) : '',
    ...(engine.plugin ? { plugin: engine.plugin } : {}),
    ...(engine.from ? { from: engine.from } : {}),
    keyTypes: keyTypesOf(store, scope),
    calls: callsOf(doc.path, load, scope),
    ...storeRequest(scope, store),
    ...(Object.keys(scoped).length ? { scoped } : {}),
    ...(Object.keys(views).length ? { views } : {}),
  };
}

/**
 * The request node of a store page: one port per name the store binds under `reads`, as a graph's is, so the
 * same node a reader knows from a graph says where a scope comes from. Nothing when the store binds no read.
 */
function storeRequest(scope: Scope, store: StoreDoc): { request?: VNode } {
  const reads = readsOf(scope, store.reads);
  if (!reads.size) return {};
  const request: VNode = {
    id: 'request',
    kind: 'request',
    label: 'Request',
    description: `what the trigger kind hands, read to scope this store's collections`,
    inputs: [],
    outputs: [...reads.values()].map(read => ({ name: read.path.join('.'), depth: read.path.length - 1 })),
  };
  markRequestPorts(request, reads);
  return { request };
}

/**
 * The collection of the store a node reaches, when it runs an operation of the store port against a literal one,
 * and how that collection is scoped. The scope is the store's word and never the node's: the compiler carries it
 * to every operation over a scoped collection, so a reader meets it on the node that could not have written it.
 */
export function keepsOf(scope: Scope, run: string, given: Values | undefined): VKeeps | undefined {
  const { path, op } = splitRef(run);
  if (!path || !op || scope.canon(path) !== scope.canon(STORE_PORT)) return undefined;
  const named = given?.store;
  if (typeof named !== 'string') return undefined;
  const store = scope.get('store', named);
  const collection = typeof given?.collection === 'string' ? given.collection : undefined;
  return {
    store: store?.path ?? scope.canon(named),
    label: labelOf(store),
    ...(collection ? { collection } : {}),
    ...shapeKept(scope, store, collection),
    op,
    ...scopeCarried(scope, { store, collection, run }),
  };
}

/** The shape one collection holds, as a spread: nothing at all for a view, which has the viewed collection's. */
function shapeKept(scope: Scope, store: Loaded<StoreDoc> | undefined, collection: string | undefined) {
  const declared = collection === undefined ? undefined : store?.doc.collections[collection];
  const of = declared && keeps(declared) ? declared.of : undefined;
  return of ? { of: scope.canon(of) } : {};
}

/** The scope a node carries, as a spread: nothing at all over a collection that has none, or a view, which has none. */
function scopeCarried(scope: Scope, over: Over) {
  const scoped = scopeOf(scope, over);
  return scoped ? { scope: scoped } : {};
}
