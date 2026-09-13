/**
 * Where a tree asks something of a store: every node of every graph and every delegation of every binding
 * whose `run` names an operation of this plugin's ports, with what it was given and what its `{{in.*}}`
 * reads resolve against. A rule over one call reads the same thing a rule over all of them does.
 */
import {
  type BindingDoc,
  type GraphDoc,
  isMap,
  isRun,
  type Loaded,
  type ObjField,
  type PluginCheckContext,
  type Type,
  type Values,
} from '@wilanis/core';

type Scope = PluginCheckContext['scope'];

export const ROOT = '@storage';
export const STORE_PORT = `${ROOT}/store.port.json`;
export const ENGINE_PORT = `${ROOT}/storage.port.json`;

/** One call of a storage operation: where it is written, which operation it names, and what it was given. */
export interface Call {
  file: string;
  at: string;
  /** the operation this call names, canonical: `@storage/store.port.json#patch` */
  run: string;
  given: Values | undefined;
  /** what `{{in.*}}` reads here resolve against: the graph's in shape, or the operation's accepts */
  reads: Type | undefined;
}

/** The operation a call names, without its port: `patch`, `ensure`. */
export const operationOf = (call: Call) => call.run.split('#')[1] ?? '';

/** Whether a run names an operation of one of this plugin's ports. */
export function isStorageCall(run: string | undefined, scope: Scope): boolean {
  if (!run) return false;
  const port = scope.canon(run.split('#')[0]);
  return port === STORE_PORT || port === ENGINE_PORT;
}

/** The run a call names, canonical, so a rule compares against the port it knows. */
const canonical = (run: string, scope: Scope) => {
  const [port, operation] = run.split('#');
  return `${scope.canon(port)}#${operation ?? ''}`;
};

/** The type a graph's `{{in.*}}` reads resolve against, where it declares one that resolves. */
function inOf(graph: Loaded<GraphDoc>, scope: Scope): Type | undefined {
  if (!graph.doc.in) return undefined;
  try {
    return scope.types.spec(graph.doc.in);
  } catch {
    return undefined; // R001, where the graph is judged
  }
}

/** The type a binding operation's `{{in.*}}` reads resolve against: what the port's operation accepts. */
function acceptsOf(binding: Loaded<BindingDoc>, name: string, scope: Scope): Type | undefined {
  const hit = scope.op(`${binding.doc.port}#${name}`);
  if (typeof hit === 'string') return undefined; // R001, where the binding is judged
  try {
    return scope.types.fields(hit.op.accepts);
  } catch {
    return undefined;
  }
}

/** Every storage call a graph's nodes make. */
export function graphCalls(scope: Scope): Call[] {
  const out: Call[] = [];
  for (const graph of scope.registry.all('graph'))
    for (const node of graph.doc.nodes)
      if ((isRun(node) || isMap(node)) && isStorageCall(node.run, scope))
        out.push({
          file: graph.path,
          at: `nodes/${node.id}/in`,
          run: canonical(String(node.run), scope),
          given: node.in,
          reads: inOf(graph, scope),
        });
  return out;
}

/** Every storage call a binding's operations make. */
export function bindingCalls(scope: Scope): Call[] {
  const out: Call[] = [];
  for (const binding of scope.registry.all('binding'))
    for (const [name, operation] of Object.entries(binding.doc.operations))
      if (isStorageCall(operation.run, scope))
        out.push({
          file: binding.path,
          at: `operations/${name}/in`,
          run: canonical(String(operation.run), scope),
          given: operation.in,
          reads: acceptsOf(binding, name, scope),
        });
  return out;
}

/** The collection a call names, once X204 has settled that it names one; nothing where it does not. */
export function collectionOf(call: Call, scope: Scope): { shape: Type; fields: Record<string, ObjField> } | undefined {
  const named = call.given?.store;
  const collection = call.given?.collection;
  if (typeof named !== 'string' || typeof collection !== 'string') return undefined;
  const declared = scope.get('store', named)?.doc.collections[collection];
  if (!declared) return undefined;
  let shape: Type;
  try {
    shape = scope.types.spec(declared.of);
  } catch {
    return undefined; // R001, where the store is judged
  }
  return { shape, fields: shape.kind === 'object' ? shape.fields : {} };
}
