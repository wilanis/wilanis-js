/**
 * What a store says beyond the marks its own document writes: which engine keeps its records, what type each
 * collection's key is, and every call site that runs an operation against it. None of it is in the store
 * document -- the engine is one hop through the connection to the kind a plugin grants, the key's type one hop
 * into the shape the collection names, and the call sites are elsewhere in the tree -- so a reader who has only
 * the JSON cannot see any of it, which is what `describe` and the viewer exist to fix.
 */
import type { ConnectionDoc, LoadResult, Scope, StoreDoc } from '@wilanis/core';
import { show, splitOp } from '@wilanis/core';

/** The port every store operation is asked through; a call names this port or it is not a store call. */
export const STORE_PORT = '@storage/store.port.json';

/** One call of the store port: where it was written, which operation, and which collection of which store. */
export interface StoreCall {
  /** The document the call sits in. */
  file: string;
  /** The node of the graph, or the operation of the binding. */
  where: string;
  /** The operation of the store port, by its short name. */
  op: string;
  /** The store the call names, canonical. */
  store: string;
  /** The collection of that store, by the name it declares; absent where the call writes none. */
  collection?: string;
}

/** The engine that keeps a store's records: the connection kind a plugin grants, and the plugin that grants it. */
export interface StoreEngine {
  /** The connection the store names, canonical. */
  connection: string;
  /** The connection kind that connection is of, canonical. */
  kind: string;
  /** The plugin alias that grants the kind (@storage-memory), when the kind is a plugin's. */
  plugin?: string;
  /** The npm package that ships that plugin, when the project names one. */
  from?: string;
}

/** The engine behind one store, walked connection → kind → the plugin that grants it. */
export function engineOf(store: StoreDoc, scope: Scope): StoreEngine {
  const connection = scope.get('connection', store.connection);
  const kindRef = (connection?.doc as ConnectionDoc | undefined)?.kind;
  const kind = kindRef ? scope.get('connection-kind', kindRef) : undefined;
  const plugin = kind?.native;
  return {
    connection: connection?.path ?? scope.canon(store.connection),
    kind: kind?.path ?? (kindRef ? scope.canon(kindRef) : ''),
    plugin,
    from: plugin ? scope.project?.plugins.find(use => use.use === plugin)?.from : undefined,
  };
}

/** The type of a collection's key field, as a reader sees it, or nothing where the shape does not declare it. */
export function keyTypeOf(of: string, key: string, scope: Scope): string | undefined {
  try {
    const type = scope.types.spec(of);
    if (type.kind !== 'object') return undefined;
    const field = type.fields[key];
    return field ? show(field.type) : undefined;
  } catch {
    return undefined;
  }
}

/** The store and collection one call of the store port names, when both are written as literals. */
function namesOf(given: Record<string, unknown> | undefined, scope: Scope) {
  const store = given?.store;
  if (typeof store !== 'string') return undefined;
  const collection = given?.collection;
  return { store: scope.canon(store), collection: typeof collection === 'string' ? collection : undefined };
}

/** One call, when it runs an operation of the store port against a store written as a literal. */
function callOf(
  site: { file: string; where: string; run: string; given: Record<string, unknown> | undefined },
  scope: Scope,
): StoreCall | undefined {
  const { path, op } = splitOp(site.run);
  if (!path || !op || scope.canon(path) !== scope.canon(STORE_PORT)) return undefined;
  const named = namesOf(site.given, scope);
  if (!named) return undefined;
  return { file: site.file, where: site.where, op, store: named.store, collection: named.collection };
}

/** Every node of every graph that runs an operation of the store port. */
function graphCalls(load: LoadResult, scope: Scope): StoreCall[] {
  const out: StoreCall[] = [];
  for (const graph of load.registry.all('graph'))
    for (const node of graph.doc.nodes) {
      if (!('run' in node)) continue;
      const call = callOf({ file: graph.path, where: node.id, run: node.run, given: node.in }, scope);
      if (call) out.push(call);
    }
  return out;
}

/** Every binding operation that delegates straight to an operation of the store port. */
function bindingCalls(load: LoadResult, scope: Scope): StoreCall[] {
  const out: StoreCall[] = [];
  for (const binding of load.registry.all('binding'))
    for (const [name, op] of Object.entries(binding.doc.operations)) {
      if (!op.run) continue;
      const call = callOf({ file: binding.path, where: name, run: op.run, given: op.in }, scope);
      if (call) out.push(call);
    }
  return out;
}

/** Every call of the store port in the tree, in document order: the graphs first, then the bindings. */
export function storeCalls(load: LoadResult, scope: Scope): StoreCall[] {
  return [...graphCalls(load, scope), ...bindingCalls(load, scope)];
}

/** Every call that runs against one store, so a store says which graphs reach it and how. */
export function callsAgainst(store: string, load: LoadResult, scope: Scope): StoreCall[] {
  return storeCalls(load, scope).filter(call => call.store === scope.canon(store));
}

/**
 * Where one node's call lands, when it runs an operation of the store port: the store, the collection it names
 * and the operation, so `wilanis map` ends a line at the records rather than at the port that speaks for them.
 */
export function storeTail(run: string, given: Record<string, unknown> | undefined, scope: Scope): string {
  const call = callOf({ file: '', where: '', run, given }, scope);
  if (!call) return '';
  const store = scope.get('store', call.store);
  return ` → store ${store?.path ?? call.store}${call.collection ? ` ${call.collection}` : ''} (${call.op})`;
}
