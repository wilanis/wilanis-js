/**
 * What `wilanis describe` says about a shape: the layer it lives in, the fields a value carries, every node
 * and binding operation that makes or writes one, the collections that keep them, and the invariants their
 * values are held to.
 *
 * Who makes a value is not in the document -- it is written across every graph and binding of the tree -- so a
 * reader who cannot see it here has to grep for the shape's path, which is the one thing `describe` exists to
 * avoid. Nothing here judges: the checker has already refused a write that does not fit.
 */
import type { Loaded, LoadResult, Scope, ShapeDoc } from '@wilanis/core';
import { overShape } from './invariant-lines.js';
import { fieldLine } from './lines.js';

/** A shape: its layer and fields, who makes or writes values of it, and the invariants its values are held to. */
export function shapeLines(doc: Loaded, scope: Scope, load: LoadResult, showType: (spec: unknown) => string): string[] {
  const declared = doc.doc as ShapeDoc;
  const lines = [`layer  ${declared.layer}`, 'fields:'];
  for (const [name, field] of Object.entries(declared.fields)) lines.push(fieldLine(name, field, showType));
  if (declared.open) lines.push(`open: values may carry fields beyond these (${JSON.stringify(declared.open)})`);
  const writers = [...graphWriters(load, doc.path, scope), ...bindingWriters(load, doc.path, scope)];
  if (writers.length) lines.push('made or written by (the attributes each gives):', ...writers);
  lines.push(...heldBy(load, doc.path, scope));
  lines.push(...overShape(doc.path, scope));
  return lines;
}

/** Every node of every graph that makes or writes values of this shape. */
function graphWriters(load: LoadResult, shape: string, scope: Scope): string[] {
  const out: string[] = [];
  for (const graph of load.registry.all('graph'))
    for (const node of graph.doc.nodes) {
      if (!('run' in node)) continue;
      const said = writerLine({ file: graph.path, where: node.id, run: node.run, given: node.in }, shape, scope);
      if (said) out.push(said);
    }
  return out;
}

/** Every binding operation that makes or writes values of this shape. */
function bindingWriters(load: LoadResult, shape: string, scope: Scope): string[] {
  const out: string[] = [];
  for (const binding of load.registry.all('binding'))
    for (const [name, op] of Object.entries(binding.doc.operations)) {
      if (!op.run) continue;
      const said = writerLine({ file: binding.path, where: name, run: op.run, given: op.in }, shape, scope);
      if (said) out.push(said);
    }
  return out;
}

/** The keys one literal value gives, when it is an object. */
const keysOf = (value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value as Record<string, unknown>) : [];

/** Which of one call's inputs the contract declares as this shape, and the keys each was given. */
function declaredAs(run: string, given: Record<string, unknown> | undefined, shape: string, scope: Scope) {
  const found = scope.op(run);
  if (typeof found === 'string') return [];
  const keys: string[] = [];
  for (const [name, field] of Object.entries(found.op.accepts ?? {}))
    if (typeof field.type === 'string' && scope.canon(field.type) === shape && given?.[name] !== undefined)
      keys.push(...keysOf(given[name]), '');
  return keys;
}

/**
 * Whether one call makes or writes values of this shape, and the keys it gives: one `type` field naming the shape
 * (object#make, session#set), or an input the contract declares as the shape (issue's attributes).
 */
function writerLine(
  call: { file: string; where: string; run: string; given: Record<string, unknown> | undefined },
  shape: string,
  scope: Scope,
): string | undefined {
  const byType = typeof call.given?.type === 'string' && scope.canon(call.given.type) === shape;
  const keys = byType ? [...keysOf(call.given?.values), ...keysOf(call.given?.value)] : [];
  const byContract = declaredAs(call.run, call.given, shape, scope);
  if (!byType && !byContract.length) return undefined;
  const named = [...keys, ...byContract].filter(Boolean);
  return `    ${call.file}#${call.where}  via ${call.run}${named.length ? `  (${named.join(', ')})` : ''}`;
}

/** Every collection of every store that keeps records of this shape, so a shape says where it is kept. */
function heldBy(load: LoadResult, shape: string, scope: Scope): string[] {
  const out: string[] = [];
  for (const store of load.registry.all('store'))
    for (const [name, collection] of Object.entries(store.doc.collections))
      if (scope.canon(collection.of) === shape) out.push(`held by  ${store.path}#${name}`);
  return out;
}
