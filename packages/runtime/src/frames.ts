/**
 * Following a value out of the spec that reads it, through the calls that handed it down. A lowered spec reads
 * what it was given as `in`; the call that entered it says, input by input, where each came from one frame further
 * out, and a binding lowers to a frame of its own that hands its caller's value straight on. Three questions are
 * answered by walking those frames: which node holds the list a map runs over, which node a guard's value on
 * `in` was copied from, and where in a map's element a read of `in` behind further calls lies.
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

/**
 * Which node's output holds the list a map runs over, and where in it. A sibling of the map, usually; but a map
 * whose `over` reads `in` iterates what the frame was handed, so the answer is one hop out -- the call that
 * entered the frame, and the source it was given under that name. Nothing when the list is composed, literal,
 * the context's or the trigger's own: a composed list is no single node's output to stub, and the trigger's
 * input the rehearsal steers is met before this is asked. `from` is the frames the holder stands in: the list's own
 * for a sibling, and fewer for a node one or more calls out, since those calls are inside the frame that holds it.
 */
export function listHolder(list: FoundList): { target: string; path: string[]; from: Frame[] } | undefined {
  const held = heldOutwards(list);
  if (!held || ['in', 'context', 'const'].includes(held.src.ref)) return undefined;
  const target = [...held.at.split('.').slice(0, -1), held.src.ref].join('.');
  return { target, path: held.src.path, from: list.from.slice(0, held.outside) };
}

/**
 * Where in its outermost frame's `in` a list a map runs over was handed down from, when every frame on the way names
 * where it got it: the path within the trigger's own input for a map no other map encloses, whose frames run from the
 * trigger's graph. A binding over a graph that takes its input whole hands it `in.ids` as its `in`, so the list is the
 * trigger's own under another name. Nothing where the list comes from a node, or is composed on the way.
 */
export function ownInputAt(list: FoundList): string[] | undefined {
  const held = heldOutwards(list);
  return held?.src.ref === 'in' ? held.src.path : undefined;
}

/**
 * A list's source followed out through the frames that handed it down, the call it was last handed through, and how
 * many of the list's frames stand outside that call: the frames of the spec the source is a node of.
 */
function heldOutwards(
  list: FoundList,
): { at: string; src: { ref: string; path: string[] }; outside: number } | undefined {
  let src = sourceOf(list.over);
  let at = list.at;
  let outside = list.from.length;
  // `in` is whatever the frame was handed, so a frame that declares where it got it is a hop outwards; one that
  // declares nothing -- the wrapper a binding lowers to, which hands its caller's value straight on -- is a hop
  // that changes nothing, and the search carries on with the same source one frame further out.
  for (let frame = list.from.length - 1; src?.ref === 'in' && frame >= 0; frame--) {
    const outer = list.from[frame];
    at = outer.at;
    outside = frame;
    const given = passedAs(outer.in, src.path);
    if (given === 'opaque') return undefined;
    if (given) src = given;
  }
  return src ? { at, src, outside } : undefined;
}

/**
 * What a call was given under the name the value arrives as: the source one frame further out, nothing where the
 * call declares no inputs at all and so hands its caller's value straight on, and `opaque` where it names the
 * input but composes it, since a composed value is no one node's output to steer.
 */
function passedAs(
  given: Record<string, unknown>,
  path: string[],
): { ref: string; path: string[] } | 'opaque' | undefined {
  const names = Object.keys(given);
  if (!names.length) return undefined;
  const name = path[0] ?? names[0];
  if (!(name in given)) return 'opaque';
  const src = sourceOf(given[name]);
  return src ? { ref: src.ref, path: [...src.path, ...path.slice(1)] } : 'opaque';
}

/** A node of an enclosing spec: the prefix its siblings are stubbed under, and its id. */
export interface Upstream {
  prefix: string[];
  node: string;
}

/**
 * The one node of an enclosing spec that every input this switch reads off `in` was copied from, field for field:
 * `in.name` handed down as `{{customer.name}}`, `in.email` as `{{customer.email}}`. Each input is followed outwards
 * a frame at a time, as `listHolder` follows a list, until it names something other than `in`. Nothing where an
 * input reads anything but `in`, where one is composed on the way, where the inputs part company, where a field
 * arrives under another name, or where the frames run out and the value is the trigger's own input -- what a
 * guard's value is then is the caller's business, and steering it is the rehearsal's as it always was.
 */
export function upstreamOf(found: FoundSwitch): Upstream | undefined {
  let held: Upstream | undefined;
  for (const source of Object.values(found.node.in)) {
    const one = tracedOut(sourceOf(source), found.from ?? []);
    if (!one) return undefined;
    if (held && (held.node !== one.node || held.prefix.join('.') !== one.prefix.join('.'))) return undefined;
    held = one;
  }
  return held;
}

/** One read of `in` followed out through the frames that handed it down, to the node that holds the same field. */
function tracedOut(read: { ref: string; path: string[] } | undefined, frames: Frame[]): Upstream | undefined {
  if (read?.ref !== 'in') return undefined;
  const out = handedOut(read, frames);
  if (!out?.at || ['in', 'context', 'const'].includes(out.src.ref)) return undefined;
  if (out.src.path.join('.') !== read.path.join('.')) return undefined;
  return { prefix: out.at.split('.').slice(0, -1), node: out.src.ref };
}

/**
 * Where in the element a map hands its operation a read of `in` is, when every call between the map and the read
 * hands it down as it got it: none declares inputs, as a binding's wrapper does, or each names where it got the value
 * one frame out and that is its own `in`. `frames` are the calls entered since the map, outermost first. Nothing where
 * a call composes the value or takes it from a node of its own, since steering the element would not move it then.
 */
export function elementPathOf(path: string[], frames: Frame[]): string[] | undefined {
  const out = handedOut({ ref: 'in', path }, frames);
  return out?.src.ref === 'in' ? out.src.path : undefined;
}

/**
 * How a map hands each element to the spec it runs: the names `bind` gives, each with the path it reads in the element,
 * or `item` whole where it binds nothing; and, for a list guard's nested spec, whether that spec reads its `in`
 * unwrapped, so its `in` is the element at what `bind` gives `in`.
 */
export function handedAs(node: Record<string, unknown>, handler: string): Pick<FoundList, 'bind' | 'unwrapped'> {
  const bind = (node.bind as Record<string, string[]> | undefined) ?? { item: [] };
  return guardSpecAt(handler) ? { bind, unwrapped: true } : { bind };
}

/**
 * Where in one element of a map a read of what its operation was handed lies: the path `bind` gives the name read
 * first, then the rest of the read -- the element whole for a name bound to `""`, as for `item` where the map binds
 * nothing. A spec handed its `in` unwrapped reads what `bind` gives `in` as its whole `in`. Nothing for a name the map
 * does not bind, which it hands every element alike from its own `in`, so steering the element would not move it.
 */
export function throughBind(list: FoundList, path: string[]): string[] | undefined {
  if (list.unwrapped) return list.bind?.in ? [...list.bind.in, ...path] : undefined;
  const [name, ...rest] = path;
  const at = name === undefined ? undefined : list.bind?.[name];
  return at ? [...at, ...rest] : undefined;
}

/**
 * A read of `in` followed out a frame at a time, innermost first, while it still reads `in`: the source it reads where
 * it stops, and the last call it was followed through. Nothing where a call composes it on the way.
 */
function handedOut(
  read: { ref: string; path: string[] },
  frames: Frame[],
): { src: { ref: string; path: string[] }; at?: string } | undefined {
  let src = read;
  let at: string | undefined;
  for (let frame = frames.length - 1; src.ref === 'in' && frame >= 0; frame--) {
    const given = passedAs(frames[frame].in, src.path);
    if (given === 'opaque') return undefined;
    at = frames[frame].at;
    if (given) src = given;
  }
  return { src, at };
}
