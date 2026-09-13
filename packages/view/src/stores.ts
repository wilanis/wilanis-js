/**
 * What a store page and a store-reaching graph node show beyond the JSON: the engine behind the records, each
 * collection's key type, the calls run against the store, and -- on one node -- which collection of which store
 * it reaches. The walks themselves live in the runtime, so `describe` and this page cannot differ about them.
 */
import type { Loaded, LoadResult, Scope, StoreDoc, Values } from '@wilanis/core';
import { splitOp } from '@wilanis/core';
import { callsAgainst, engineOf, keyTypeOf, STORE_PORT } from '@wilanis/runtime';
import type { VKeeps, VStore, VStoreCall } from './types.js';
import { labelOf } from './types.js';

/** The type of every collection's key, by collection name, where the shape it names declares the field. */
function keyTypesOf(store: StoreDoc, scope: Scope): Record<string, string> {
  const types: Record<string, string> = {};
  for (const [name, collection] of Object.entries(store.collections)) {
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

/** What a store adds to its view: the engine that keeps its records, its key types, and what runs against it. */
export function storeView(scope: Scope, load: LoadResult, doc: Loaded): VStore {
  const store = doc.doc as StoreDoc;
  const engine = engineOf(store, scope);
  return {
    connection: engine.connection,
    connectionLabel: labelOf(scope.registry.any(engine.connection)),
    kind: engine.kind,
    kindLabel: engine.kind ? labelOf(scope.registry.any(engine.kind)) : '',
    ...(engine.plugin ? { plugin: engine.plugin } : {}),
    ...(engine.from ? { from: engine.from } : {}),
    keyTypes: keyTypesOf(store, scope),
    calls: callsOf(doc.path, load, scope),
  };
}

/** The collection of the store a node reaches, when it runs an operation of the store port against a literal one. */
export function keepsOf(scope: Scope, run: string, given: Values | undefined): VKeeps | undefined {
  const { path, op } = splitOp(run);
  if (!path || !op || scope.canon(path) !== scope.canon(STORE_PORT)) return undefined;
  const named = given?.store;
  if (typeof named !== 'string') return undefined;
  const store = scope.get('store', named);
  const collection = typeof given?.collection === 'string' ? given.collection : undefined;
  const of = collection ? store?.doc.collections[collection]?.of : undefined;
  return {
    store: store?.path ?? scope.canon(named),
    label: labelOf(store),
    ...(collection ? { collection } : {}),
    ...(of ? { of: scope.canon(of) } : {}),
    op,
  };
}
