/**
 * The whole record before the write (RFC 0035). A guarded shape is a core shape some `holds` invariant is `on`,
 * and a guarded field is one its `when` reads. A write of a guarded shape takes the whole record, and the record
 * reaches the write from a site RFC 0007 already judges, upstream of the effect: a `#patch` whose `changes` name
 * a guarded field is refused (I007), since a rule over the whole record cannot be held on a part of one, and a
 * `#put` whose `record` is anything but one whole read of a node or of `in` is refused (I008), since a record
 * composed at the write is a value no site ever held. Nothing is added to the guard; these rules only keep the
 * write downstream of it. They run after `checkInvariantSites`, over the invariants as `checkHolds` judged them.
 */
import {
  type GraphDoc,
  type InvariantDoc,
  isSwitch,
  type Loaded,
  type MapNode,
  type Node,
  type RunNode,
  typeAt,
} from '@wilanis/core';
import { bindings } from '../documents.js';
import { guardRoots } from '../guard.js';
import { named } from './invariant-holds.js';
import type { Judge } from './judge.js';
import { readWhole } from './prove.js';

/** The native port whose two writes these rules judge. */
const STORE = '@storage/store.port.json';

/** One field invariant as a write is judged against it: the document, and the fields its rule reads. */
interface Guard {
  invariant: Loaded<InvariantDoc>;
  fields: Set<string>;
}

/** One write of a guarded shape: where it sits, which of the two writes it is, and what guards the shape. */
interface Write {
  graph: Loaded<GraphDoc>;
  node: RunNode | MapNode;
  op: string;
  /** the canonical path of the shape the collection keeps */
  shape: string;
  guards: Guard[];
}

/** I007 and I008 at every node of every graph that writes a guarded shape; a tree with no field invariant has none. */
export function checkInvariantWrites(judge: Judge): void {
  const guarded = guardedShapes(judge);
  if (!guarded.size) return;
  for (const graph of judge.scope.registry.all('graph')) {
    for (const node of graph.doc.nodes) {
      const write = writeAt(judge, graph, node, guarded);
      if (write?.op === 'patch') checkPatch(judge, write);
      if (write?.op === 'put') checkPut(judge, write);
    }
  }
}

/** Every guarded shape by canonical path, with the invariants on it. A rule that does not parse reads no field, so refuses nothing here: I004 refuses it. */
function guardedShapes(judge: Judge): Map<string, Guard[]> {
  const out = new Map<string, Guard[]>();
  for (const invariant of judge.scope.registry.all('invariant')) {
    const holds = invariant.doc.holds;
    if (!holds) continue;
    const shape = judge.scope.canon(holds.on);
    out.set(shape, [...(out.get(shape) ?? []), { invariant, fields: new Set(guardRoots(holds.when)) }]);
  }
  return out;
}

/**
 * The write a node makes of a guarded shape, or nothing where it runs neither `#put` nor `#patch` of the store
 * port, or writes a collection no invariant guards. The collection's shape is the `$T` the call site's `store`
 * resolves, the type G004 holds `record` to.
 */
function writeAt(judge: Judge, graph: Loaded<GraphDoc>, node: Node, guarded: Map<string, Guard[]>): Write | undefined {
  if (isSwitch(node)) return undefined;
  const hit = judge.scope.op(node.run);
  if (typeof hit === 'string' || hit.path !== STORE || !['put', 'patch'].includes(hit.opName)) return undefined;
  const kept = bindings(judge.scope, hit.op, node.in).$T;
  const shape = kept?.kind === 'object' && kept.name ? judge.scope.canon(kept.name) : undefined;
  const guards = shape ? guarded.get(shape) : undefined;
  return shape && guards ? { graph, node, op: hit.opName, shape, guards } : undefined;
}

/** I007: a patch whose `changes` name a field some invariant on the collection's shape reads. */
function checkPatch(judge: Judge, write: Write): void {
  const changed = changedFields(judge, write);
  const reading = write.guards.filter(guard => changed.some(field => guard.fields.has(field)));
  if (!reading.length) return;
  const fields = changed.filter(field => reading.some(guard => guard.fields.has(field)));
  const which = listed(reading.map(guard => named(guard.invariant)));
  const message = `patch writes ${listed(fields.map(field => `'${field}'`))}, which ${which} ${reading.length > 1 ? 'read' : 'reads'}; a rule over the whole record cannot be held on a part of one`;
  const hint = `load the record, make the new one with @std/object.port.json#merge in a domain graph, and #put it whole through an operation that takes a ${shapeName(judge, write.shape)}`;
  judge.refuser(write.graph.path)('I007', message, `nodes/${write.node.id}/in/changes`, hint);
}

/**
 * The fields a patch's `changes` name: its keys where it is written out, or the fields of its type where it is
 * one read of `in`, typed off the graph's `in`. None where neither can be told.
 */
function changedFields(judge: Judge, write: Write): string[] {
  const changes = write.node.in?.changes;
  if (typeof changes === 'object' && changes !== null && !Array.isArray(changes)) return Object.keys(changes);
  const path = readWhole(changes);
  const taken = path?.[0] === 'in' ? judge.quiet(write.graph.doc.in) : undefined;
  const read = taken && path ? typeAt(taken, path.slice(1)) : undefined;
  return typeof read === 'object' && read.type.kind === 'object' ? Object.keys(read.type.fields) : [];
}

/** I008: a put whose `record` is composed at the write rather than read whole from a node or from `in`. */
function checkPut(judge: Judge, write: Write): void {
  const record = write.node.in?.record;
  if (record === undefined || wholeRead(write, record)) return; // absent: G006's, or bound from a map's elements
  const shape = shapeName(judge, write.shape);
  const which = listed(write.guards.map(guard => named(guard.invariant)));
  const message = `the ${shape} written here is composed at the write, so nothing judges it against ${which} before the store keeps it`;
  const hint = `make the ${shape} whole before the write -- @std/object.port.json#make with "type": "${write.shape}", in a domain graph that hands it to this one as in -- and give #put "record": "{{in}}"`;
  judge.refuser(write.graph.path)('I008', message, `nodes/${write.node.id}/in/record`, hint);
}

/** Whether a value is one whole read of `in` or of a node of the write's graph: made or taken before the write reads it. */
function wholeRead(write: Write, value: unknown): boolean {
  const path = readWhole(value);
  if (path?.length !== 1) return false;
  return path[0] === 'in' || write.graph.doc.nodes.some(node => node.id === path[0]);
}

/** How a message names a shape: its label, or its path where it has none. */
export const shapeName = (judge: Judge, shape: string): string => judge.scope.get('shape', shape)?.doc.label ?? shape;

/** Items said as a reader would list them: `a`, `a and b`, `a, b and c`. */
export function listed(items: string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : (items[0] ?? '');
}
