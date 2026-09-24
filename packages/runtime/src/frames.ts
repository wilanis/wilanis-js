/**
 * Following a value out of the spec that reads it, through the calls that handed it down. A lowered spec reads
 * what it was given as `in`; the call that entered it says, input by input, where each came from one frame further
 * out, and a binding lowers to a frame of its own that hands its caller's value straight on. Two questions are
 * answered by walking those frames: which node holds the list a map runs over, and which node a guard's value on
 * `in` was copied from.
 */
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
 * the request's or the trigger's own: a composed list is no single node's output to stub, and the trigger's
 * input the rehearsal steers is met before this is asked.
 */
export function listHolder(list: FoundList): { target: string; path: string[] } | undefined {
  let src = sourceOf(list.over);
  let at = list.at;
  // `in` is whatever the frame was handed, so a frame that declares where it got it is a hop outwards; one that
  // declares nothing -- the wrapper a binding lowers to, which hands its caller's value straight on -- is a hop
  // that changes nothing, and the search carries on with the same source one frame further out.
  for (let frame = list.from.length - 1; src?.ref === 'in' && frame >= 0; frame--) {
    const outer = list.from[frame];
    at = outer.at;
    const given = passedAs(outer.in, src.path);
    if (given === 'opaque') return undefined;
    if (given) src = given;
  }
  if (!src || src.ref === 'in' || src.ref === 'request' || src.ref === 'const') return undefined;
  return { target: [...at.split('.').slice(0, -1), src.ref].join('.'), path: src.path };
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
  let src = read;
  let at: string | undefined;
  for (let frame = frames.length - 1; src.ref === 'in' && frame >= 0; frame--) {
    const given = passedAs(frames[frame].in, src.path);
    if (given === 'opaque') return undefined;
    at = frames[frame].at;
    if (given) src = given;
  }
  if (!at || ['in', 'request', 'const'].includes(src.ref)) return undefined;
  if (src.path.join('.') !== read.path.join('.')) return undefined;
  return { prefix: at.split('.').slice(0, -1), node: src.ref };
}
