/**
 * Where one demand of a rehearsal case is met. The solver says, field by field, what a switch's inputs must hold for a
 * branch to be taken (`branches.ts` asks it); each such demand is written here into what the rehearsal sets: a patch
 * to the trigger's own input, a stub of a node's answer, or a stub of the node that holds the list a map hands an
 * element from. A read of `in` is followed out of the switch's graph by `traced` in `frames.ts`, through every call and
 * map on the way, and is met where it lands. A traced demand never lands past a guard: where the trace meets a guard's
 * answer, it is written into the value the guard judges, so the guard judges what the rehearsal wrote (RFC 0038).
 * Where the stubbing follows a pure `make` (`writtenOf`, which `fuzz --edges` alone gives), a demand on its answer goes
 * on into what it writes out instead, to the input it copies (#1009).
 * Where the trace stops, a literal on the way meets the demand with nothing written, or closes the branch on that
 * path; anything else leaves it unreachable, with the sentence `demand-said.ts` writes.
 */
import { TAKEN_IDS } from '@wilanis/compiler';
import { type Type, typeAt } from '@wilanis/core';
import type { KSwitchLike, Settled, Stubbing } from './branches.js';
import { intoCall } from './demand-calls.js';
import { closedSaid, exhaustedOf, stoppedSaid, type Unmet } from './demand-said.js';
import { type Domain, meets } from './domains.js';
import {
  type Holder,
  type Landed,
  type OnNode,
  type Standing,
  type Stopped,
  sourceOf,
  traced,
  writtenThrough,
} from './frames.js';
import { throughWhere } from './map-rules.js';
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
    landed = 'stopped' in again ? again : withEach(again, landed.each, landed.path.length);
  }
  return landed;
}

/**
 * A landing that also stands for every element where the read it was traced from did. A hop out keeps the end of the
 * path, so each such step, counted from the end, still stands where it did; the read's first step, which the hop
 * rewrote, is no longer there.
 */
function withEach(landed: Landed, each: number[] | undefined, length: number): Landed {
  return each ? { ...landed, each: [...(landed.each ?? []), ...each.filter(one => one < length)] } : landed;
}

/**
 * A demand met where a traced read lands: a patch to the trigger's input, or a stub of the node it lands on. A node that
 * is a guard's answer at a made site is stubbed at `<id>:made`, the value the guard judges, never past it. An element
 * of a list a node holds is written into every element of that list (`everyElement`), since a rule a map runs per
 * element judges each one, at `<map>.0` where the node is a map (`answerAt`) and at the node as `nonEmpty` writes the
 * list. Any other node is stubbed where its answer is stubbed (`stubTarget`). Where the trace stopped, `ofStopped` says
 * what is left.
 */
function ofTraced(read: string[], landed: Landed | Stopped, asked: Asked, from: Settled): Met | Unmet | Fixed | Every {
  if ('stopped' in landed) return ofStopped(read, landed, asked, from);
  if ('input' in landed) return ofInput(landed.input, asked, from, landed.each);
  const through = inward(landed.standing.at, landed.path, landed.standing, from);
  if (through) return ofTraced(read, withEvery(through, landed.each), asked, from);
  const call = called(landed.standing.at, landed, asked, from);
  if (call) return call;
  const each = landed.each ? { each: landed.each } : {};
  const placed = onNode(landed, from);
  if (asked.domain.absent && requiredAt(from.typeOf(placed.target), placed.path))
    return { missed: 'exhausted', why: `'${placed.path.join('.')}' is required in what '${placed.target}' answers` };
  return { stub: { ...placed, value: asked.domain, field: asked.field, ...each } };
}

/** Whether the last step of a path names a field its object requires: one a stub can never leave out. */
function requiredAt(type: Type | undefined, path: string[]): boolean {
  const parent = path.length ? typeAtPath(type, path.slice(0, -1)) : undefined;
  return parent?.kind === 'object' && parent.fields[path[path.length - 1] ?? '']?.required === true;
}

/**
 * A demand on a node's answer followed into what the node writes out, where the stubbing follows a pure `make`
 * (`writtenOf`): at a made site, into the value the guard judges, `<id>:made`. Nothing where the stubbing follows none,
 * or the node is no such make, and the demand is a stub of its answer as before.
 */
function writtenFrom(node: string, path: string[], standing: Standing, from: Settled): Landed | Stopped | undefined {
  if (!from.writtenOf) return undefined;
  const made = from.madeOf?.(node) ?? node;
  const written = from.writtenOf(made);
  return written === undefined ? undefined : writtenThrough(written, path, { ...standing, at: made });
}

/**
 * A demand on a node's answer carried to what the node is run from, where it is run and never stubbed (#1027): the
 * value a pure `make` copies; or the list a map with no rule runs over, for a demand on the whole answer, which is on
 * its length. A call into one of the tree's graphs is met inside it (`called`). Nothing where the node is none of
 * these, and the demand stays on its answer.
 */
function inward(node: string, path: string[], standing: Standing, from: Settled): Landed | Stopped | undefined {
  const written = writtenFrom(node, path, standing, from);
  if (written) return written;
  // a map with no rule answers one element per element of its `over`: how many it answers is how many that holds
  const over = path.length || from.mapRuleOf?.(node) ? undefined : from.overOf?.(node);
  return over === undefined ? undefined : writtenThrough(over, [], { ...standing, at: node });
}

/** A demand on what the call at a node answers, met inside the graph it runs (`intoCall`); nothing for any other node. */
function called(
  node: string,
  read: { path: string[]; standing: Standing; each?: number[] },
  asked: Asked,
  from: Settled,
) {
  return intoCall(node, read, {
    answeredIn: from.answeredIn,
    isMap: from.isMap,
    landing: landed => ofTraced(landed.path, landed, asked, from),
    meet: (dotted, domain, at) => meet(dotted, domain, at, from),
    overrides: met => overrides(met, from),
    strict: from.strict,
  });
}

/** A landing that stands for every element where the read it was carried from did, its path's end kept as it was. */
function withEvery(landed: Landed | Stopped, each: number[] | undefined): Landed | Stopped {
  return each && !('stopped' in landed) ? { ...landed, each: [...(landed.each ?? []), ...each] } : landed;
}

/**
 * A demand on what the node holding a list answers, met as a demand on a switch's read that lands there is: carried
 * inward where the node is run and never stubbed (#1027), else written at the node.
 */
export function onHolder(held: Holder, domain: Domain, from: Settled): Met | Unmet | Fixed | Every {
  const segments = held.target.split('.');
  const standing = { at: held.target, from: held.from, lists: held.lists };
  const landed: OnNode = { node: segments.at(-1) ?? '', prefix: segments.slice(0, -1), path: held.path, standing };
  return ofTraced(held.path, landed, { field: held.target, domain }, from);
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
  if (landed.each || placed.target !== node) return placed;
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
 * type meets it (`exhaustedOf`). An absent field is the solver's to demand, never this patch's to choose. A patch on an
 * element of a list the input holds carries the demand, so it is met in every element the list holds when it is laid.
 */
function ofInput(
  path: string[],
  asked: Asked,
  from: Pick<Stubbing, 'inputSeed' | 'inType'> & { seed: number },
  each?: number[],
): { input: Patch } | Unmet {
  const type = typeAtPath(from.inType, path);
  const value = satisfy(asked.domain, getPath(from.inputSeed, path), type, from.seed);
  if (value === NO_MEMBER) return exhaustedOf(asked.field, asked.domain, type);
  return {
    input: each ? { path, value, each: { at: each, domain: asked.domain } } : { path, value, held: asked.domain },
  };
}

/**
 * A patch to the trigger's input: the path and the value written there. `each` where the path runs through an element
 * of a list that stands for every element: the steps that do, counted from the path's end, and the demand each element
 * is made to meet, since what the list holds is known only when the patch is laid over the ones before it. `held`
 * where the demand is met by what the path holds when the patch is laid, as a list made to hold one element is.
 */
export type Patch = { path: string[]; value: unknown; each?: { at: number[]; domain: Domain }; held?: Domain };

/** A stub a demand writes: the node, the path within its answer, what it must hold, the field, and where it stands for every element. */
type Stub = { target: string; path: string[]; value: unknown; field: string; each?: number[] };

/** A demand met: a patch to the trigger's input, or a stub written at a node's path. */
export type Met = { input: Patch } | { stub: Stub };

/** One demand met as several, every one to be laid: what a keep's answer asks of the list it runs over. */
export type Every = { all: (Met | Unmet | Fixed | Every)[] };

/**
 * Where one demand is met: the trigger's input, where the switch reads it as its own; a node of the switch's own graph,
 * stubbed at that node, a guard's answer among them; anything else read off `in`, followed out to where it lands
 * (`ofTraced`); or nowhere.
 */
export function meet(dotted: string, domain: Domain, at: At, from: Settled): Met | Unmet | Fixed | Every {
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
  const node = [...at.prefix, src.ref].join('.');
  const path = [...src.path, ...within];
  // a map's rule is logic, run and never stubbed: what it must answer is asked of the list it runs over (#1027)
  const rule = from.mapRuleOf?.(node);
  if (rule) return throughWhere(rule, { path, domain }, at, (one, held, here) => meet(one, held, here, from));
  const through = inward(node, path, { ...at.standing, at: node }, from);
  if (through) return ofTraced(path, through, asked, from);
  const call = called(node, { path, standing: { ...at.standing, at: node } }, asked, from);
  if (call) return call;
  return { stub: { target: stubTarget(node, from), path, value: domain, field: dotted } };
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
  const { target } = stub;
  const type = from.typeOf(target);
  const domain = stub.value as Domain;
  let value = target in stubs ? stubs[target] : standIn(target, from);
  // a demand on an element is met in every element the stub holds, each changed from its own generated value
  for (const path of everyElement(value, stub.path, stub.each)) {
    const want = satisfy(domain, getPath(value, path), typeAtPath(type, path), from.seed);
    if (want === NO_MEMBER) return exhaustedOf(stub.field, domain, typeAtPath(type, path));
    value = setPath(value, path, want, { type, seed: from.seed });
  }
  stubs[target] = value;
  return undefined;
}

/**
 * Every path a demand on an element stands for in `root`: the path with each step `each` names -- index 0 of a list,
 * counted from the path's end -- taken through every index the list there holds. A list that is not there, or holds
 * nothing, keeps index 0, which writing makes. Outer lists first, so an element of an element is found in each.
 */
export function everyElement(root: unknown, path: string[], each: number[] = []): string[][] {
  const steps = each
    .map(one => path.length - one)
    .filter(at => at >= 0 && path[at] === '0')
    .sort((one, other) => one - other);
  let paths = [path];
  for (const at of steps)
    paths = paths.flatMap(one => indexesOf(getPath(root, one.slice(0, at))).map(index => atIndex(one, at, index)));
  return paths;
}

/** A path with the step at one place taken as another index. */
const atIndex = (path: string[], at: number, index: string): string[] =>
  path.map((step, place) => (place === at ? index : step));

/** The indexes of a list's elements, as path steps; index 0 alone where the value is no list or an empty one. */
const indexesOf = (list: unknown): string[] =>
  Array.isArray(list) && list.length ? list.map((_, index) => String(index)) : ['0'];

/**
 * One patch laid over the trigger's input: its value at its path, or -- where it stands for every element of a list --
 * the demand it carries met in every element the input holds by now, each changed from its own value.
 */
export function patchInto(input: unknown, patch: Patch, from: { inType?: Type; seed: number }): unknown {
  const parents = { type: from.inType, seed: from.seed };
  if (patch.held) return setPath(input, patch.path, heldBy(input, patch, from), parents);
  if (!patch.each) return setPath(input, patch.path, patch.value, parents);
  let out = input;
  for (const path of everyElement(input, patch.path, patch.each.at)) {
    const want = satisfy(patch.each.domain, getPath(input, path), typeAtPath(from.inType, path), from.seed);
    // an element no value meets keeps the value element 0 was given, which the demand was solved for
    out = setPath(out, path, want === NO_MEMBER ? patch.value : want, parents);
  }
  return out;
}

/**
 * What a patch whose demand is `held` writes: that demand met by what the input holds at the path by now, so a patch
 * laid after another keeps what the other wrote there -- a list cut to one element keeps the element a guard was
 * steered on (#1027). The value it was solved with where nothing there meets it.
 */
function heldBy(input: unknown, patch: Patch, from: { inType?: Type; seed: number }): unknown {
  const want = satisfy(patch.held ?? {}, getPath(input, patch.path), typeAtPath(from.inType, patch.path), from.seed);
  return want === NO_MEMBER ? patch.value : want;
}

/**
 * Whether a met demand would change a value another decision steered: a stub at a node whose steered answer holds,
 * at the path, something other than what the seed generated there and that the demand does not accept -- or, where
 * the path runs past the end of a list the steering made, that list, which an element demanded of it would grow (#1027).
 */
export function overrides(met: ReturnType<typeof meet>, from: Settled): boolean {
  if ('all' in met) return met.all.some(one => overrides(one, from));
  if (!('stub' in met) || !from.steered || !(met.stub.target in from.steered)) return false;
  const { target } = met.stub;
  const steered = from.steered[target];
  if (meets(getPath(steered, met.stub.path), met.stub.value as Domain)) return false;
  const path = steeredAlong(steered, met.stub.path);
  const now = getPath(steered, path);
  return now !== undefined && JSON.stringify(now) !== JSON.stringify(getPath(from.seeded?.(target), path));
}

/** The path itself where the steered value holds something there, else the list it runs past the end of, if any. */
function steeredAlong(steered: unknown, path: string[]): string[] {
  if (getPath(steered, path) !== undefined || !path.length) return path;
  const parent = path.slice(0, -1);
  return Array.isArray(getPath(steered, parent)) ? parent : path;
}

/** Where a case is steered: the stubs it writes, and the patches to the trigger's input. */
export interface Steered {
  stubs: Record<string, unknown>;
  input: Patch[];
}

/** One met demand laid into what a case steers: a patch to the input, or a stub written; why not, where it is not met. */
export function lay(
  met: ReturnType<typeof meet>,
  into: Steered,
  from: Required<Pick<Stubbing, 'generated' | 'typeOf' | 'seed'>>,
): Unmet | undefined {
  if ('missed' in met) return met;
  if ('fixed' in met) return undefined;
  if ('all' in met) return met.all.map(one => lay(one, into, from)).find(why => why !== undefined);
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
