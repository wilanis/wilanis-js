/**
 * Following a value out of the spec that reads it, through the calls and the maps that handed it down. A lowered spec
 * reads what it was given as `in`; the call that entered it says, input by input, where each came from one frame
 * further out, and a binding lowers to a frame of its own that hands its caller's value straight on. A map hands the
 * spec it runs each element under the names `bind` gives, and every element alike the values its own `in` names.
 * `traced` follows one read of `in` out through all of them, to the node, the element or the trigger's input it comes
 * from; which node holds the list a map runs over, where in the trigger's input that list is, and which node a guard's
 * value on `in` was copied from are all read through it.
 */
import { guardSpecAt } from '@wilanis/compiler';
import type { FoundList, FoundSwitch, Frame } from './branches.js';

/** Where a switch input reads from: a node in the same spec, and the path within that node's output. */
export function sourceOf(spec_: unknown): { ref: string; path: string[] } | undefined {
  if (!spec_ || typeof spec_ !== 'object') return undefined;
  const object = spec_ as Record<string, unknown>;
  if (typeof object.ref === 'string' && Array.isArray(object.path))
    return { ref: object.ref, path: object.path as string[] };
  return undefined; // list/object/value/concat sources are composed, not a single stubbable node
}

/** One read of a source: what it names, and the path within it. */
type Read = { ref: string; path: string[] };

/**
 * Where a read stands in a run: a node of a spec, by its dotted path; the calls entered to reach that spec since the
 * innermost map enclosing it, outermost first; and the maps enclosing it, outermost first. A switch stands where it
 * is found, and the list a map runs over stands where the map is.
 */
export interface Standing {
  at: string;
  from: Frame[];
  lists: FoundList[];
}

/** The standing of a switch, from where the walk found it. */
export function standingOf(found: Pick<FoundSwitch, 'at' | 'from' | 'lists'>): Standing {
  return { at: found.at, from: found.from ?? [], lists: found.lists };
}

/**
 * A node of an enclosing spec a read lands on: its id, the prefix its siblings are stubbed under, the path within its
 * answer, and where it stands. `element` where the read crossed a map as the element it hands, so the path runs
 * through element 0 of a list the node holds.
 */
export interface OnNode {
  node: string;
  prefix: string[];
  path: string[];
  standing: Standing;
  element?: true;
}

/** The trigger's own input, at a path: where every call and map on the way hands the read down from `in`. */
export interface OnInput {
  input: string[];
  element?: true;
}

/** Where a traced read lands: something the rehearsal sets. */
export type Landed = OnNode | OnInput;

/** Where a trace stopped: the call or map whose value it cannot follow further out. */
export interface Stopped {
  stopped: string;
}

/** One hop of a trace that goes on: the read one frame or map further out, and where it now stands. */
type Hop = { src: Read; here: Standing };

/**
 * A read of `in` followed out through the calls and maps that handed it down: where it lands, or where it stopped. A
 * read of anything but `in` lands where it stands. Each hop is bounded by the walk that found the frames, which never
 * enters a handler twice on one path, so the trace needs no limit of its own.
 */
export function traced(read: Read, standing: Standing): Landed | Stopped {
  let hop: Hop = { src: read, here: standing };
  while (hop.src.ref === 'in') {
    const next = outward(hop.src.path, hop.here);
    if (!('src' in next)) return next;
    hop = next;
  }
  return landing(hop);
}

/** Where a read that names something other than `in` lands: a node of the spec it stands in, unless it reads what no stub sets. */
function landing({ src, here }: Hop): Landed | Stopped {
  if (src.ref === 'context' || src.ref === 'const') return { stopped: here.at };
  const prefix = here.at.split('.').slice(0, -1);
  return { node: src.ref, prefix, path: src.path, standing: { ...here, at: [...prefix, src.ref].join('.') } };
}

/**
 * One step out from a read of `in`: through the innermost call entered, else through the innermost map, else -- where
 * neither is left -- the trigger's own input.
 */
function outward(path: string[], here: Standing): Hop | Landed | Stopped {
  const frame = here.from.at(-1);
  if (frame) return throughFrame(frame, path, { ...here, at: frame.at, from: here.from.slice(0, -1) });
  const list = here.lists.at(-1);
  if (list) return throughMap(list, path, here.lists.slice(0, -1));
  return { input: path };
}

/**
 * What a call was given under the name a read of `in` arrives as. A call that names no inputs, as a binding's wrapper,
 * hands its caller's value straight on; one into a spec that takes its input whole hands the source under `in`, with
 * the whole read under it; any other names the source under the read's first name -- or its first input, for a read
 * of `in` whole. `out` is where the call stands.
 */
function throughFrame(frame: Frame, path: string[], out: Standing): Hop | Stopped {
  const given = frame.in;
  const names = Object.keys(given);
  if (!names.length) return { src: { ref: 'in', path }, here: out };
  if (frame.unwrapped) return handed(given.in, path, out);
  const [name = names[0], ...rest] = path;
  return name in given ? handed(given[name], rest, out) : { stopped: frame.at };
}

/**
 * A read of `in` through the map that runs the spec it stands in: the element, where `bind` hands the read from it,
 * else the source the map's own `in` hands every element alike under the read's first name, read where the map stands.
 */
function throughMap(list: FoundList, path: string[], outer: FoundList[]): Hop | Landed | Stopped {
  const within = throughBind(list, path);
  const here: Standing = { at: list.at, from: list.from, lists: outer };
  if (within) return elementOf(list, within, here);
  const [name, ...rest] = path;
  return name !== undefined && list.in && name in list.in ? handed(list.in[name], rest, here) : { stopped: list.at };
}

/**
 * Element 0 of the list a map runs over, at a path within it: where that list's own source lands, with the element
 * under it. The first element stands for all, as it does everywhere in the walk. Stopped where the list is composed.
 */
function elementOf(list: FoundList, within: string[], here: Standing): Landed | Stopped {
  const over = sourceOf(list.over);
  const held = over ? traced(over, here) : { stopped: list.at };
  if ('stopped' in held) return held;
  if ('input' in held) return { input: [...held.input, '0', ...within], element: true };
  return { ...held, path: [...held.path, '0', ...within], element: true };
}

/**
 * The read one hop out, from the source a call or a map hands under a name, with the rest of the read under it: a read
 * goes on as that source; an object written out is entered at the next field read; anything else is composed, a literal
 * or a list written out, and the trace stops at the call or map, where `out` stands.
 */
function handed(source: unknown, rest: string[], out: Standing): Hop | Stopped {
  const src = sourceOf(source);
  if (src) return { src: { ref: src.ref, path: [...src.path, ...rest] }, here: out };
  const fields = (source as { object?: Record<string, unknown> } | undefined)?.object;
  const [field, ...deeper] = rest;
  if (fields && field !== undefined && field in fields) return handed(fields[field], deeper, out);
  return { stopped: out.at };
}

/** The node that holds a list, the path within its answer, and the frames and maps it stands in. */
export interface Holder {
  target: string;
  path: string[];
  from: Frame[];
  lists: FoundList[];
}

/**
 * Which node's output holds the list a map runs over, and where in it. A sibling of the map, usually; but a map whose
 * `over` reads `in` iterates what its frame was handed, so the answer is found by following that read out (`traced`):
 * through the calls, and through any map enclosing it, to the node it lands on, element 0 of a list an outer map ran
 * over among them. `outer` is the maps enclosing the list, outermost first. Nothing when the list is composed, literal,
 * the context's or the trigger's own: a composed list is no single node's output to stub, and the trigger's input the
 * rehearsal steers is met before this is asked.
 */
export function listHolder(list: FoundList, outer: FoundList[] = []): Holder | undefined {
  const over = sourceOf(list.over);
  const held = over && traced(over, { at: list.at, from: list.from, lists: outer });
  if (!held || !('node' in held)) return undefined;
  const { standing, path } = held;
  return { target: standing.at, path, from: standing.from, lists: standing.lists };
}

/**
 * Where in the trigger's own input a list a map runs over was handed down from, when every call and map on the way
 * names where it got it (`traced`). A binding over a graph that takes its input whole hands it `in.ids` as its `in`, so
 * the list is the trigger's own under another name. Nothing where the list comes from a node, is composed on the way,
 * or is an element of a list the trigger's input holds.
 */
export function ownInputAt(list: FoundList, outer: FoundList[] = []): string[] | undefined {
  const over = sourceOf(list.over);
  const held = over && traced(over, { at: list.at, from: list.from, lists: outer });
  return held && 'input' in held && !held.element ? held.input : undefined;
}

/**
 * A node of an enclosing spec: the prefix its siblings are stubbed under, and its id. `element` where the value is an
 * element of the list the node answers, which a map handed down one element at a time.
 */
export interface Upstream {
  prefix: string[];
  node: string;
  element?: true;
}

/**
 * The one node of an enclosing spec that every input this switch reads off `in` was copied from, field for field:
 * `in.name` handed down as `{{customer.name}}`, `in.email` as `{{customer.email}}` -- or, across a map that binds each
 * field by its own name, as `name` and `email` of each element of the list the node answers. Each input is followed
 * out (`traced`) until it names something other than `in`. Nothing where an input reads anything but `in`, where one
 * is composed on the way, where the inputs part company, where a field arrives under another name or inside an
 * element of a list deeper than the node's whole answer, or where the value is the trigger's own input -- what a
 * guard's value is then is the caller's business, and steering it is the rehearsal's as it always was.
 */
export function upstreamOf(found: FoundSwitch): Upstream | undefined {
  let held: Upstream | undefined;
  for (const source of Object.values(found.node.in)) {
    const one = copiedFrom(sourceOf(source), standingOf(found));
    if (!one || (held && !sameUpstream(held, one))) return undefined;
    held = one;
  }
  return held;
}

/** Whether two inputs were copied from the same value: one node, in one spec, whole or element by element alike. */
const sameUpstream = (one: Upstream, other: Upstream): boolean =>
  one.node === other.node && one.prefix.join('.') === other.prefix.join('.') && one.element === other.element;

/**
 * One read of `in` followed out to the node that holds the same field, under the same name: in the node's answer, or
 * in element 0 of the list it answers, which stands for every element a map hands down.
 */
function copiedFrom(read: Read | undefined, standing: Standing): Upstream | undefined {
  if (read?.ref !== 'in') return undefined;
  const out = traced(read, standing);
  if (!('node' in out)) return undefined;
  const field = out.element ? ['0', ...read.path] : read.path;
  if (out.path.join('.') !== field.join('.')) return undefined;
  return out.element ? { prefix: out.prefix, node: out.node, element: true } : { prefix: out.prefix, node: out.node };
}

/**
 * How a map hands each element to the spec it runs: the names `bind` gives, each with the path it reads in the element,
 * or `item` whole where it binds nothing; the sources its own `in` hands every element alike; and, for a list guard's
 * nested spec, whether that spec reads its `in` unwrapped, so its `in` is the element at what `bind` gives `in`.
 */
export function handedAs(node: Record<string, unknown>, handler: string): Pick<FoundList, 'bind' | 'in' | 'unwrapped'> {
  const bind = (node.bind as Record<string, string[]> | undefined) ?? { item: [] };
  const given = node.in as Record<string, unknown> | undefined;
  const handed = given && Object.keys(given).length ? { bind, in: given } : { bind };
  return guardSpecAt(handler) ? { ...handed, unwrapped: true } : handed;
}

/**
 * Where in one element of a map a read of what its operation was handed lies: the path `bind` gives the name read
 * first, then the rest of the read -- the element whole for a name bound to `""`, as for `item` where the map binds
 * nothing. A spec handed its `in` unwrapped reads what `bind` gives `in` as its whole `in`. Nothing for a name the map
 * does not bind, which it hands every element alike from its own `in`.
 */
export function throughBind(list: FoundList, path: string[]): string[] | undefined {
  if (list.unwrapped) return list.bind?.in ? [...list.bind.in, ...path] : undefined;
  const [name, ...rest] = path;
  const at = name === undefined ? undefined : list.bind?.[name];
  return at ? [...at, ...rest] : undefined;
}
