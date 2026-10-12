/**
 * Where one demand of a rehearsal case is met. The solver says, field by field, what a switch's inputs must hold for a
 * branch to be taken (`branches.ts` asks it); each such demand is written here into what the rehearsal sets: a patch
 * to the trigger's own input, a stub of a node's answer, or a stub of the node that holds the list a map hands an
 * element from. A read of `in` is followed out of the switch's graph by `traced` in `frames.ts`, through every call and
 * map on the way, and is met where it lands. A traced demand never lands past a guard: where the trace meets a guard's
 * answer, it is written into the value the guard judges, so the guard judges what the rehearsal wrote (RFC 0038).
 * Where the trace stops, a literal on the way meets the demand with nothing written, or closes the branch on that
 * path; anything else leaves it unreachable, with the sentence `demand-said.ts` writes.
 */
import { TAKEN_IDS } from '@wilanis/compiler';
import { type Type, typeAt } from '@wilanis/core';
import type { KSwitchLike, Settled, Stubbing } from './branches.js';
import { closedSaid, exhaustedOf, stoppedSaid, type Unmet } from './demand-said.js';
import { type Domain, meets } from './domains.js';
import { type Landed, type OnNode, type Standing, type Stopped, sourceOf, traced } from './frames.js';
import { getPath, NO_MEMBER, satisfy, setPath } from './stubs.js';

export type { Missed, Unmet } from './demand-said.js';

/** Where a switch stands: the switch itself, where its siblings are stubbed, and how its `in` can be steered. */
export interface At {
  node: KSwitchLike;
  prefix: string[];
  steerable: boolean;
  /** where the switch stands in the run: the calls and the maps a read of its `in` is traced out through */
  standing: Standing;
}

/**
 * A read of `in` followed out to what the rehearsal sets (`traced`), never past a guard: where it lands on `in:ok`, the
 * value a taken site's guard let through, it goes on as `in`, out to the caller that handed the value the guard judged.
 */
function followed(read: { ref: string; path: string[] }, standing: Standing): Landed | Stopped {
  let landed = traced(read, standing);
  while ('node' in landed && landed.node === TAKEN_IDS.ok) {
    const again = traced({ ref: 'in', path: landed.path }, landed.standing);
    landed = landed.element && !('stopped' in again) ? { ...again, element: true } : again;
  }
  return landed;
}

/**
 * A demand met where a traced read lands: a patch to the trigger's input, or a stub of the node it lands on. A node that
 * is a guard's answer at a made site is stubbed at `<id>:made`, the value the guard judges, never past it. An element
 * of a list a node holds is written at index 0 of that list, the first element standing for all as it does everywhere
 * else in the walk, at `<map>.0` where the node is a map (`answerAt`) and at the node as `nonEmpty` writes the list. Any
 * other node is stubbed where its answer is stubbed (`stubTarget`). Where the trace stopped, `ofStopped` says what is
 * left.
 */
function ofTraced(read: string[], landed: Landed | Stopped, asked: Asked, from: Settled): Met | Unmet | Fixed {
  if ('stopped' in landed) return ofStopped(read, landed, asked, from);
  if ('input' in landed) return ofInput(landed.input, asked, from);
  return { stub: { ...onNode(landed, from), value: asked.domain, field: asked.field } };
}

/** One demand as the solver made it: the field of the switch's inputs it is on, and what that field must hold. */
type Asked = { field: string; domain: Domain };

/** A demand a value the tree fixes already meets: nothing to write, since every run on this path hands that value. */
export type Fixed = { fixed: true };

/**
 * A demand on a read of `in` whose trace stopped: met with nothing written where a literal on the way meets it, closed
 * on this path where the literal excludes it, and unreachable otherwise -- each with the sentence that says where the
 * trace stopped. A literal compared with another value is unreachable: what it is compared with is not fixed.
 */
function ofStopped(read: string[], stopped: Stopped, asked: Asked, from: Settled): Unmet | Fixed {
  const { domain } = asked;
  if (stopped.reason !== 'literal' || domain.paired)
    return { missed: 'unreachable', why: stoppedSaid(read, stopped, from.graphOf) };
  if (meets(stopped.value, domain)) return { fixed: true };
  return { missed: 'closed', why: closedSaid(read, stopped, from.graphOf) };
}

/** Where a demand that landed on a node is written: the node's stub, or the guard's judged value, at a path. */
function onNode(landed: OnNode, from: Settled): { target: string; path: string[] } {
  const node = from.madeOf?.(landed.standing.at) ?? landed.standing.at;
  const placed = answerAt(node, landed.path, from);
  if (landed.element || placed.target !== node) return placed;
  return { target: stubTarget(node, from), path: placed.path };
}

/**
 * Where a stub of a node's answer at a path is written: at the node, or -- where the node is a map and the path starts
 * at an element -- at that element, since the kernel reads a map's stub element by element, at `<map>.<index>`.
 */
export function answerAt(
  target: string,
  path: string[],
  from: Pick<Stubbing, 'isMap'>,
): { target: string; path: string[] } {
  const [first, ...rest] = path;
  return first === '0' && from.isMap?.(target) ? { target: `${target}.0`, path: rest } : { target, path };
}

/**
 * A demand on the trigger's own input at a path: the patch that meets it, or 'exhausted' where no value of the field's
 * type meets it (`exhaustedOf`). An absent field is the solver's to demand, never this patch's to choose.
 */
function ofInput(
  path: string[],
  asked: Asked,
  from: Pick<Stubbing, 'inputSeed' | 'inType'> & { seed: number },
): { input: { path: string[]; value: unknown } } | Unmet {
  const type = typeAtPath(from.inType, path);
  const value = satisfy(asked.domain, getPath(from.inputSeed, path), type, from.seed);
  return value === NO_MEMBER ? exhaustedOf(asked.field, asked.domain, type) : { input: { path, value } };
}

/** A stub a demand writes: the node, the path within its answer, what the path must hold, and the field it is for. */
type Stub = { target: string; path: string[]; value: unknown; field: string };

/** A demand met: a patch to the trigger's input, or a stub written at a node's path. */
type Met = { input: { path: string[]; value: unknown } } | { stub: Stub };

/**
 * Where one demand is met: the trigger's input, where the switch reads it as its own; a node of the switch's own graph,
 * stubbed at that node, a guard's answer among them; anything else read off `in`, followed out to where it lands
 * (`ofTraced`); or nowhere.
 */
export function meet(dotted: string, domain: Domain, at: At, from: Settled): Met | Unmet | Fixed {
  const [inputName, ...within] = dotted.split('.');
  const src = sourceOf(at.node.in[inputName]);
  if (!src) return { missed: 'unreachable' };
  const asked = { field: dotted, domain };
  // a switch in the top-level graph reading `in` is steered by the trigger's input, not a stub
  if (src.ref === 'in' && at.steerable) return ofInput([...src.path, ...within], asked, from);
  // any other read of `in` is followed out, through the calls and maps that handed it down, to what the rehearsal sets
  if (src.ref === 'in') {
    const read = [...src.path, ...within];
    return ofTraced(read, followed({ ref: 'in', path: read }, at.standing), asked, from);
  }
  if (src.ref === 'context' || src.ref === 'const') return { missed: 'unreachable' };
  const target = stubTarget([...at.prefix, src.ref].join('.'), from);
  return { stub: { target, path: [...src.path, ...within], value: domain, field: dotted } };
}

/**
 * Which stub a demand on a node's answer writes into: the node's own, or, where the node is a call a binding meets by
 * delegation, the one effect under it. A binding operation lowers to a wrapper spec holding one node `op`, and that
 * effect is what the kernel stubs and what a seed records; a stub at the call would answer only where every node is
 * answered from a stub, as in the rehearsal, and never where effects alone are, as in an edge's run (#788).
 */
function stubTarget(direct: string, from: Pick<Stubbing, 'effectOf'>): string {
  return from.effectOf?.(direct) ?? direct;
}

/**
 * What a stub starts from before a demand is written into it: what the seed recorded there, else a value of the type
 * the node declares. A node the seed never records -- a pure one, such as the `#make` a made site's guard moves aside
 * to `<id>:made` -- would otherwise start from nothing, and the stub would hold only the fields the rule reads: the
 * guard judges it and routes where it was steered, and the next node to read the value fails its shape instead.
 */
export function standIn(target: string, from: Required<Pick<Stubbing, 'generated' | 'typeOf' | 'seed'>>): unknown {
  const recorded = from.generated(target);
  if (recorded !== undefined) return recorded;
  const type = from.typeOf(target);
  return type ? satisfy({ present: true }, undefined, type, from.seed) : undefined;
}

/**
 * One demand written into the stub it steers, on top of what earlier demands already wrote there; 'exhausted', and
 * nothing written, where no value of the field's type meets it (`exhaustedOf`).
 */
function write(
  stubs: Record<string, unknown>,
  stub: Stub,
  from: Required<Pick<Stubbing, 'generated' | 'typeOf' | 'seed'>>,
): Unmet | undefined {
  const { target, path } = stub;
  const type = from.typeOf(target);
  const base = target in stubs ? stubs[target] : standIn(target, from);
  const domain = stub.value as Domain;
  const want = satisfy(domain, getPath(base, path), typeAtPath(type, path), from.seed);
  if (want === NO_MEMBER) return exhaustedOf(stub.field, domain, typeAtPath(type, path));
  stubs[target] = setPath(base, path, want, { type, seed: from.seed });
  return undefined;
}

/** Where a case is steered: the stubs it writes, and the patches to the trigger's input. */
export interface Steered {
  stubs: Record<string, unknown>;
  input: { path: string[]; value: unknown }[];
}

/** One met demand laid into what a case steers: a patch to the input, or a stub written; why not, where it is not met. */
export function lay(
  met: ReturnType<typeof meet>,
  into: Steered,
  from: Required<Pick<Stubbing, 'generated' | 'typeOf' | 'seed'>>,
): Unmet | undefined {
  if ('missed' in met) return met;
  if ('fixed' in met) return undefined;
  if (!('input' in met)) return write(into.stubs, met.stub, from);
  into.input.push(met.input);
  return undefined;
}

/** The declared type at a path within a node's output type, as far as the type system can follow it. */
export function typeAtPath(type: Type | undefined, path: string[]): Type | undefined {
  if (!type) return undefined;
  // typeAt answers a string when the path cannot be followed into the type
  try {
    const rule = typeAt(type, path);
    return typeof rule === 'string' ? undefined : rule.type;
  } catch {
    return undefined;
  }
}
