/**
 * The whole record before the write (RFC 0035). A guarded shape is a core shape some `holds` invariant is `on`,
 * and a guarded field is one its `when` reads. A write of a guarded shape takes the whole record, and the record
 * reaches the write from a site RFC 0007 already judges, upstream of the effect: a `#patch` whose `changes` name
 * a guarded field is refused (I007), since a rule over the whole record cannot be held on a part of one, and a
 * `#put` whose `record` is anything but one whole read of a site of the shape is refused (I008), since a record no
 * site made or took is a value nothing judged. Both hold on every path a write takes: a graph's `run` node, a
 * `map`'s bound element, and a binding's delegation straight to the store. Nothing is added to the guard; these
 * rules only keep the write downstream of it. They run after `checkInvariantSites`.
 */
import {
  type BindingDoc,
  type GraphDoc,
  type InvariantDoc,
  isMap,
  isSwitch,
  type Loaded,
  type MapNode,
  type OpHit,
  type RunNode,
  type Type,
  typeAt,
  type Values,
} from '@wilanis/core';
import { bindings, passedInputs } from '../documents.js';
import { guardRoots } from '../guard.js';
import { type Site, siteId, sitesOf } from '../sites.js';
import { GraphReads } from './graph-reads.js';
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

/** What a call writes: which of the two writes, the canonical shape the collection keeps, and what guards it. */
interface Target {
  op: string;
  shape: string;
  guards: Guard[];
}

/** One call that writes a guarded shape -- a graph's node or a binding's delegation -- as both rules read it. */
interface Write extends Target {
  file: string;
  /** the inputs as the call gives them, a binding's passed by name included */
  given: Values;
  /** a `map`'s element: the list it runs over, and each input bound from within an element */
  element?: { over: unknown; bind: Record<string, string> };
  /** the type of one whole read at the call, or nothing where it cannot be told */
  typeOf: (path: string[]) => Type | undefined;
  /** the read roots that are sites of the shape here, by arity: what a whole read may name and be judged */
  sites: { one: Set<string>; list: Set<string> };
  /** where one input sits, for `at` */
  inputAt: (input: string) => string;
  /** a binding has no site, so its fix is a data graph; a graph's is the record made in a domain graph */
  binding: boolean;
}

/** I007 and I008 at every call that writes a guarded shape; a tree with no field invariant has none. */
export function checkInvariantWrites(judge: Judge): void {
  const guarded = guardedShapes(judge);
  if (!guarded.size) return;
  const sites = new Map([...guarded.keys()].map(shape => [shape, sitesOf(judge.scope, shape)]));
  const writes = [
    ...judge.scope.registry.all('graph').flatMap(graph => graphWrites(judge, graph, { guarded, sites })),
    ...judge.scope.registry.all('binding').flatMap(binding => bindingWrites(judge, binding, guarded)),
  ];
  for (const write of writes) {
    if (write.op === 'patch') checkPatch(judge, write);
    else checkPut(judge, write);
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
 * What a call to `run` given `given` writes of a guarded shape, or nothing where it runs neither `#put` nor
 * `#patch` of the store port, or writes a collection no invariant guards. The collection's shape is the `$T` the
 * call's `store` resolves, the type G004 holds `record` to.
 */
function targetOf(
  judge: Judge,
  run: string,
  given: Values | undefined,
  guarded: Map<string, Guard[]>,
): Target | undefined {
  const hit = judge.scope.op(run);
  if (typeof hit === 'string' || hit.path !== STORE || !['put', 'patch'].includes(hit.opName)) return undefined;
  const kept = bindings(judge.scope, hit.op, given).$T;
  const shape = kept?.kind === 'object' && kept.name ? judge.scope.canon(kept.name) : undefined;
  const guards = shape ? guarded.get(shape) : undefined;
  return shape && guards ? { op: hit.opName, shape, guards } : undefined;
}

// ---- where a write is made -----------------------------------------------------------------------

/** The writes of guarded shapes a graph's nodes make, each typed by the graph's own reads. */
function graphWrites(
  judge: Judge,
  graph: Loaded<GraphDoc>,
  known: { guarded: Map<string, Guard[]>; sites: Map<string, Site[]> },
): Write[] {
  const out: Write[] = [];
  let typeOf: Write['typeOf'] | undefined;
  for (const node of graph.doc.nodes) {
    if (isSwitch(node)) continue;
    const target = targetOf(judge, node.run, node.in, known.guarded);
    if (!target) continue;
    typeOf ??= graphTyping(judge, graph);
    const sites = sitesIn(known.sites.get(target.shape) ?? [], graph);
    out.push({ ...target, ...nodeInputs(node), file: graph.path, typeOf, sites, binding: false });
  }
  return out;
}

/** What one node gives a write: its inputs, a `map`'s element, and where each input sits for `at`. */
function nodeInputs(node: RunNode | MapNode): Pick<Write, 'given' | 'element' | 'inputAt'> {
  const element = isMap(node) ? { over: node.over, bind: node.bind ?? {} } : undefined;
  const inputAt = (input: string) => `nodes/${node.id}/${element && input in element.bind ? 'bind' : 'in'}/${input}`;
  return { given: node.in ?? {}, element, inputAt };
}

/**
 * How a whole read of one graph is typed: by the checker's own `GraphReads`, over the graph's input, constants and
 * node answers, the table G004 types a node's inputs by. Built quietly: what does not resolve types as nothing
 * here, and is refused where the graph itself is judged.
 */
function graphTyping(judge: Judge, graph: Loaded<GraphDoc>): Write['typeOf'] {
  const nodes = new Map(graph.doc.nodes.map(node => [node.id, node]));
  const ops = new Map<string, OpHit>();
  for (const node of nodes.values()) {
    const hit = isSwitch(node) ? undefined : judge.scope.op(node.run);
    if (hit && typeof hit !== 'string') ops.set(node.id, hit);
  }
  const constTypes: Record<string, Type> = {};
  for (const [name, constant] of Object.entries(graph.doc.constants ?? {})) {
    const type = judge.quiet(constant.type);
    if (type) constTypes[name] = type;
  }
  const inType = judge.quiet(graph.doc.in);
  const reads = new GraphReads(judge, { file: graph.path, nodes, ops, resolvers: {}, inType, constTypes });
  return path => {
    const root = reads.rootOf(path);
    return root ? typed(typeAt(root.type, root.below)) : undefined;
  };
}

/** The sites of a shape in one graph, by the root a read names them with and by arity. */
function sitesIn(sites: Site[], graph: Loaded<GraphDoc>): Write['sites'] {
  const out = { one: new Set<string>(), list: new Set<string>() };
  for (const site of sites) if (site.graph.path === graph.path) out[site.arity].add(siteId(site));
  return out;
}

/**
 * The writes of guarded shapes a binding's delegations make straight to the store, with the inputs the operation
 * passes by name. Its values read the operation's own `in`, typed off what it accepts; a binding holds no site, so
 * no read of it is one.
 */
function bindingWrites(judge: Judge, binding: Loaded<BindingDoc>, guarded: Map<string, Guard[]>): Write[] {
  const out: Write[] = [];
  const port = judge.scope.get('port', binding.doc.port);
  for (const [name, bound] of Object.entries(binding.doc.operations)) {
    const op = port?.doc.operations[name];
    const hit = bound.run && op ? judge.scope.op(bound.run) : undefined;
    if (!bound.run || !op || !hit || typeof hit === 'string') continue;
    const given = passedInputs(judge.scope, hit.op, op, bound.in);
    const target = targetOf(judge, bound.run, given, guarded);
    if (!target) continue;
    const accepts = judge.acceptsType(op);
    const typeOf = (path: string[]) =>
      path[0] === 'in' && accepts ? typed(typeAt(accepts, path.slice(1))) : undefined;
    const inputAt = (input: string) => `operations/${name}/${input in (bound.in ?? {}) ? `in/${input}` : 'run'}`;
    const sites = { one: new Set<string>(), list: new Set<string>() };
    out.push({ ...target, file: binding.path, given, typeOf, sites, inputAt, binding: true });
  }
  return out;
}

/** A read's type, or nothing where the read names what is not there. */
const typed = (read: { type: Type } | string): Type | undefined => (typeof read === 'string' ? undefined : read.type);

// ---- I007 ----------------------------------------------------------------------------------------

/** I007: a patch whose `changes` name a field some invariant on the collection's shape reads. */
function checkPatch(judge: Judge, write: Write): void {
  const changed = changedFields(write);
  const reading = write.guards.filter(guard => changed.some(field => guard.fields.has(field)));
  if (!reading.length) return;
  const fields = changed.filter(field => reading.some(guard => guard.fields.has(field)));
  const which = listed(reading.map(guard => named(guard.invariant)));
  const message = `patch writes ${listed(fields.map(field => `'${field}'`))}, which ${which} ${reading.length > 1 ? 'read' : 'reads'}; a rule over the whole record cannot be held on a part of one`;
  const hint = `load the record, make the new one with @std/object.port.json#merge in a domain graph, and #put it whole through an operation that takes a ${shapeName(judge, write.shape)}`;
  judge.refuser(write.file)('I007', message, write.inputAt('changes'), hint);
}

/**
 * The fields a patch's `changes` name: its keys where it is written out; the fields of its type where it is one
 * whole read, of `in` or of a node; and for a `map` that binds it from each element, the fields of what it binds.
 * None where the type cannot be told.
 */
function changedFields(write: Write): string[] {
  const changes = write.given.changes;
  if (typeof changes === 'object' && changes !== null && !Array.isArray(changes)) return Object.keys(changes);
  const path = readWhole(changes);
  if (path) return fieldsOf(write.typeOf(path));
  const bound = write.element?.bind.changes;
  return bound === undefined ? [] : fieldsOf(elementType(write, bound));
}

/** The type one input a `map` binds takes: the path it names within an element of the list the map runs over. */
function elementType(write: Write, bound: string): Type | undefined {
  const over = readWhole(write.element?.over);
  const list = over ? write.typeOf(over) : undefined;
  return list?.kind === 'list' ? typed(typeAt(list.of, bound ? bound.split('.') : [])) : undefined;
}

/** The fields of an object type; none of anything else. */
const fieldsOf = (type: Type | undefined): string[] => (type?.kind === 'object' ? Object.keys(type.fields) : []);

// ---- I008 ----------------------------------------------------------------------------------------

/** I008: a put whose `record` is not one whole read of a site of the shape, given or bound from each element. */
function checkPut(judge: Judge, write: Write): void {
  const source = unjudged(write);
  if (!source) return;
  const shape = shapeName(judge, write.shape);
  const which = listed(write.guards.map(guard => named(guard.invariant)));
  const message = `the ${shape} written here ${source}, so nothing judges it against ${which} before the store keeps it`;
  const hint = write.binding
    ? `meet this operation with a data graph whose in is the ${shape}, and give its #put "record": "{{in}}", where the compiler judges it`
    : `make the ${shape} whole before the write -- @std/object.port.json#make with "type": "${write.shape}", in a domain graph that hands it to this one as in -- and give #put "record": "{{in}}"`;
  judge.refuser(write.file)('I008', message, write.inputAt('record'), hint);
}

/**
 * Where a put's record comes from, said, when that is not a site of the shape; nothing where it is. A record given
 * is one whole read of a site that holds one value of the shape; one a `map` binds is each element, whole, of one
 * whole read of a site that holds a list of it. An absent record is G006's.
 */
function unjudged(write: Write): string | undefined {
  const record = write.given.record;
  if (record !== undefined) return unjudgedGiven(write, record);
  const bound = write.element?.bind.record;
  return bound === undefined ? undefined : unjudgedBound(write, bound);
}

/** Where a record given in `in` comes from, when that is not one whole read of a site of one value of the shape. */
function unjudgedGiven(write: Write, record: unknown): string | undefined {
  const path = readWhole(record);
  if (path?.length === 1 && write.sites.one.has(path[0])) return undefined;
  return path ? `is read from '${path.join('.')}', which is no site of it` : 'is composed at the write';
}

/** Where a record a `map` binds comes from, when that is not each element, whole, of a site of a list of the shape. */
function unjudgedBound(write: Write, bound: string): string | undefined {
  const over = readWhole(write.element?.over);
  if (bound === '' && over?.length === 1 && write.sites.list.has(over[0])) return undefined;
  const from = over ? `'${over.join('.')}'` : 'the list the map runs over';
  return `is ${bound ? `'${bound}' of ` : ''}each element of ${from}, which is no site of it`;
}

/** How a message names a shape: its label, or its path where it has none. */
export const shapeName = (judge: Judge, shape: string): string => judge.scope.get('shape', shape)?.doc.label ?? shape;

/** Items said as a reader would list them: `a`, `a and b`, `a, b and c`. */
export function listed(items: string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : (items[0] ?? '');
}
