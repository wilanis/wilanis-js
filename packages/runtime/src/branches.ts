/**
 * Branch enumeration for the rehearsal: every way a switch can route, solved from its own expressions.
 *
 * Rehearsing with generated stubs takes whichever branch the seed happens to satisfy; to walk them all we read the
 * rules instead of guessing. For each rule we build the values that make it true and every earlier rule false -- that
 * is the case which reaches its target, since the kernel tries rules in order -- and one more case for the else,
 * where every rule is false at once. The solver itself is in domains.ts, and what it writes into a stub in stubs.ts.
 */
import type { Type } from '@wilanis/core';
import {
  type At,
  answerAt,
  lay,
  type Missed,
  meet,
  type Patch,
  type Steered,
  standIn,
  typeAtPath,
  type Unmet,
} from './demands.js';
import type { Branch, Domain } from './domains.js';
import { type Holder, handedAs, listHolder, ownInputAt, sourceOf, standingOf } from './frames.js';
import { branchesOf } from './solve.js';
import { getPath, satisfy, setPath } from './stubs.js';

export type { Branch, Demands, Domain } from './domains.js';
export { branchesOf } from './solve.js';
export { getPath, PLACEHOLDER, satisfy, setPath } from './stubs.js';

// ---- enumerating a spec's branches ------------------------------------------------------------------

/** One rehearsal case: a set of stubs by dotted node path, and the branch it is meant to reach. */
/** What a rehearsal stubs with: the seed's values and types by node path, and the trigger's own input. */
export interface Stubbing {
  generated: (nodePath: string) => unknown;
  typeOf?: (nodePath: string) => Type | undefined;
  seed?: number;
  inputSeed?: unknown;
  inType?: Type;
  /** Whether the node at a dotted path is a map: the kernel reads its stubs per element, at `<path>.<index>`. */
  isMap?: (nodePath: string) => boolean;
  /**
   * The one effect the node at a dotted path delegates to, where it is a call a binding meets by a `run`: a demand on
   * its answer is written there, `<path>.op`, where the kernel stubs it and a seed records it, never at the call.
   */
  effectOf?: (nodePath: string) => string | undefined;
  /** The lowered `over` of the map at a dotted path: the list it runs over, which is what makes its answer non-empty. */
  overOf?: (nodePath: string) => unknown;
  /**
   * Where the node at a dotted path is a guard's answer at a made site, the node its value was moved aside to,
   * `<path>:made`: what the guard judges, and where a demand traced to the answer is written, never past the guard.
   */
  madeOf?: (nodePath: string) => string | undefined;
  /** The graph document the node at a dotted path stands in: where a sentence says a trace stopped. */
  graphOf?: (nodePath: string) => string | undefined;
  /**
   * What the node at a dotted path writes out, where it is a pure `make` whose answer a demand is followed through to
   * the value it copies. Only `fuzz --edges` gives it: it steers the trigger's input and never a node's answer.
   */
  writtenOf?: (nodePath: string) => unknown;
}

/**
 * A stubbing whose seed values are what `stubs` already steered, where it steered them: a case built over it writes
 * its demands on top of those, so laying it over them keeps every field they set that it does not demand itself.
 */
export function over(from: Stubbing, stubs: Record<string, unknown>): Stubbing {
  return { ...from, generated: path => (path in stubs ? stubs[path] : from.generated(path)) };
}

/** Where a walk over a spec has reached: the path so far, the handlers already walked, and the lists it passed through. */
export interface Where {
  prefix?: string[];
  seen?: Set<string>;
  via?: string[];
  fromTriggerIn?: boolean;
  lists?: FoundList[];
  /** The calls entered to reach the frame being walked, outermost first: where this spec's `in` comes from. */
  entered?: Frame[];
}

export interface Case {
  /** Dotted path of the switch, from the top-level graph. */
  at: string;
  branch: Branch;
  /** Node path -> the whole stubbed output of that node. Empty when nothing needed patching. */
  stubs: Record<string, unknown>;
  /**
   * Demands that land on the graph's own input rather than a node: path within the input -> value.
   * Only meaningful for a switch in the top-level graph, where the input is the trigger's.
   */
  input?: Patch[];
  /** Demands that could not be routed to anything the rehearsal can set. */
  unreachable?: string[];
  /** Demands for a value no value of the field's type meets: its enum's members all excluded, or a text it cannot make. */
  exhausted?: string[];
  /** Why each field under `unreachable` or `exhausted` is, where a sentence says more than today's: by field. */
  why?: Record<string, string>;
  /**
   * Where a literal a caller hands excludes what the branch demands, so no run takes it on this path: the sentences
   * that say which node hands which literal, joined. Not a gap in the walk, and no problem where another path runs it.
   */
  closed?: string;
  /** The dotted paths of the nodes made to break, for the branch a `catch` routes a fault to (RFC 0014). */
  broken?: string[];
}

/** A switch found in a spec, with the position it occupies in the run. */
export interface FoundSwitch {
  /** Dotted node path of the switch itself. */
  at: string;
  /** The prefix under which the switch's sibling nodes are stubbed. */
  prefix: string[];
  /** True while every enclosing frame forwards `in` unchanged, so the trigger's input still steers this switch. */
  fromTriggerIn?: boolean;
  node: KSwitchLike;
  /**
   * The nodes enclosing this switch, outermost first: each is a call whose graph the switch lives in.
   * A switch inside one of them is only reached when every enclosing switch routes towards it, so a
   * case for a nested switch must first satisfy its ancestors.
   */
  via: string[];
  /**
   * The map nodes enclosing this switch, outermost first. A switch inside a mapped operation runs once per
   * element and is rehearsed through the first one, so each enclosing list must hold at least one element.
   */
  lists: FoundList[];
  /**
   * The calls entered to reach the spec this switch stands in since the last map, outermost first: where its `in`
   * came from, which is how a guard on `in` is traced back to the value an enclosing graph handed it.
   */
  from?: Frame[];
}

/** One call the walk descended through: its dotted path, and the sources the call was given by name. */
export interface Frame {
  at: string;
  in: Record<string, unknown>;
  /** True where the spec the call runs takes its input whole, handed under the one key `in` (`takesWhole`). */
  unwrapped?: boolean;
}

/** A map node on the way to a switch: where it sits, what it iterates, and whether the trigger's input still steers that list. */
export interface FoundList {
  /** Dotted node path of the map itself. */
  at: string;
  /** The lowered source of `over`. */
  over: unknown;
  /** True when `over` reading `in` reads the trigger's own input. */
  fromTriggerIn: boolean;
  /**
   * The calls the walk entered to reach the spec this map stands in, outermost first: each one's path and the
   * sources it was given. A map whose `over` reads `in` iterates a list the frame was handed rather than one a
   * sibling node made, so what steers it is outside this spec, and following these back -- a hop per frame,
   * since a binding lowers to a frame of its own -- says which node out there actually holds the list.
   */
  from: Frame[];
  /**
   * The input names the map hands its operation each element under, and the path within the element each reads: its
   * lowered `bind`, or the whole element as `item` where it binds nothing. Only a map the walk enters says it.
   */
  bind?: Record<string, string[]>;
  /** The sources the map hands every element alike, by name: its lowered `in`. A name here is never in `bind` (G006). */
  in?: Record<string, unknown>;
  /** True where the spec the map runs is handed its one input `in` unwrapped, as a list guard's nested spec is. */
  unwrapped?: boolean;
}

/** The shape of a lowered switch this module needs; `label` carries the rule's source text. */
export interface KSwitchLike {
  kind: 'switch';
  in: Record<string, unknown>;
  rules: { to: string; label: string }[];
  else: string;
  /** The nodes whose fault this switch routes, and where each goes. */
  catch?: Record<string, string>;
}

/**
 * A spec a call runs, as the walk reads it: its nodes by id, and whether it takes its input whole, handed under the
 * one key `in` -- which the compiler decides (`takesWhole`) and the resolver passes on.
 */
export type Nested = { nodes: Record<string, unknown>; whole?: boolean };

/**
 * Every switch reachable from a spec, including those inside graph-bound calls. `nested` resolves a
 * call's handler to the spec it runs, so the walk does not need the compiler's private caches.
 */
export function switchesOf(
  spec: { nodes: Record<string, unknown> },
  nested: (handler: string) => Nested | undefined,
  where: Where = {},
): FoundSwitch[] {
  const out: FoundSwitch[] = [];
  for (const [id, raw] of Object.entries(spec.nodes))
    out.push(...atNode(id, raw as Record<string, unknown>, nested, where));
  return out;
}

/** Where a walk goes on from one node: the switch it is, or the switches inside the call it makes. */
function atNode(
  id: string,
  node: Record<string, unknown>,
  nested: (handler: string) => Nested | undefined,
  where: Where,
): FoundSwitch[] {
  const { prefix = [], seen = new Set<string>(), via = [], fromTriggerIn = true, lists = [], entered = [] } = where;
  if (node.kind === 'switch')
    return [
      {
        at: [...prefix, id].join('.'),
        prefix,
        node: node as unknown as KSwitchLike,
        via,
        fromTriggerIn,
        lists,
        from: entered,
      },
    ];
  const handler = typeof node.handler === 'string' ? node.handler : undefined;
  // a handler is walked once per branch position; recursion through the same handler would not terminate
  if (!handler || seen.has(handler)) return [];
  const sub = nested(handler);
  if (!sub) return [];
  const here = [...prefix, id].join('.');
  const walked = { seen: new Set([...seen, handler]), via: [...via, here] };
  // a mapped operation runs once per element, each under the element's index; the first element stands for all --
  // `nonEmpty` makes a list the rehearsal sets hold that one alone -- and what it receives is the element, never the
  // trigger's input
  if (node.kind === 'map')
    return switchesOf(sub, nested, {
      ...walked,
      prefix: [...prefix, id, '0'],
      fromTriggerIn: false,
      lists: [...lists, { at: here, over: node.over, fromTriggerIn, from: entered, ...handedAs(node, handler) }],
      entered: [],
    });
  return switchesOf(sub, nested, {
    ...walked,
    prefix: [...prefix, id],
    fromTriggerIn: fromTriggerIn && forwardsIn(node),
    lists,
    entered: [...entered, frameOf(here, node, sub)],
  });
}

/** The frame a call enters: its path, what it hands by name, and whether the spec it runs unwraps it. */
function frameOf(at: string, node: Record<string, unknown>, sub: Nested): Frame {
  const given = (node.in as Record<string, unknown>) ?? {};
  return sub.whole ? { at, in: given, unwrapped: true } : { at, in: given };
}

/**
 * What it takes for a mapped operation to run, once, for the element the walk steers: its list holds exactly one
 * element, since a second would run from values nothing steered, and a guard one of them breaks would end every case
 * of the switch wherever its first element was steered (#904). A demand on the
 * trigger's input when the list is read from it -- field for field, or handed down under another name by the calls
 * and maps on the way (`ownInputAt`) -- a stub of the node that holds it otherwise: a sibling of the map, or, where
 * the map runs over what its frame was handed, the node out there that fed it (`listHolder`), element 0 of a list an
 * outer map ran over among them. `outer` is the maps enclosing the list, outermost first. Nothing when the list is
 * composed or literal, since a literal list is already what it is, and such a list keeps every element it has. A
 * holder that is itself a map answers element by element, at `<map>.<index>`, so a stub at the map is one the kernel
 * never reads: its answer holds an element when the list it runs over does, which is the same question one map
 * further out, asked in the frames that map stands in (#869).
 */
export function nonEmpty(list: FoundList, from: Stubbing, outer: FoundList[] = []): NonEmpty {
  const src = sourceOf(list.over);
  if (!src) return NOTHING;
  const handed = handedFrom(src, list, outer);
  if (handed) return { stubs: {}, input: [patchOf(handed, from)] };
  const held = listHolder(list, outer);
  if (!held) return NOTHING;
  if (!held.path.length && from.isMap?.(held.target)) {
    const holder = ownListOf(held, list, from);
    return holder ? nonEmpty(holder, from, held.lists) : NOTHING;
  }
  return { stubs: stubHolding(held, from), input: [] };
}

/** What a list the rehearsal sets must be to run a mapped operation for the one element it steers: there, with that element alone. */
const ONE_ELEMENT: Domain = { minLen: 1, maxLen: 1, present: true };

/**
 * Where in the trigger's own input a list is read from, when it is: field for field where the map reads `in` and
 * `in` is still the trigger's, or handed down under another name by the calls and maps on the way (`ownInputAt`).
 */
function handedFrom(src: { ref: string; path: string[] }, list: FoundList, outer: FoundList[]): string[] | undefined {
  if (src.ref === 'in' && list.fromTriggerIn) return src.path;
  return ownInputAt(list, outer);
}

/** The patch to the trigger's input that makes the list at a path hold one element. */
function patchOf(path: string[], from: Stubbing): { path: string[]; value: unknown } {
  const value = satisfy(ONE_ELEMENT, getPath(from.inputSeed, path), typeAtPath(from.inType, path), from.seed ?? 1);
  return { path, value };
}

/**
 * The stub of the node that holds the list, with one element in it; the answer keeps every other field it has, since a
 * sibling may read one. A list inside element 0 of a map's answer is stubbed at that element (`answerAt`). A holder that
 * is a guard's answer is stubbed at the value the guard judges, `<id>:made`, never past it: where the element a switch
 * reads is written (`meet`), so the two meet in one stub.
 */
function stubHolding(held: Holder, from: Stubbing): Record<string, unknown> {
  const { generated, typeOf = () => undefined, seed = 1 } = from;
  const { target, path } = answerAt(from.madeOf?.(held.target) ?? held.target, held.path, from);
  const base = standIn(target, { generated, typeOf, seed });
  const type = typeOf(target);
  const filled = satisfy(ONE_ELEMENT, getPath(base, path), typeAtPath(type, path), seed);
  return { [target]: setPath(base, path, filled, { type, seed }) };
}

/** What makes a list hold an element: the stubs to write, and the patches to the trigger's input. */
type NonEmpty = { stubs: Record<string, unknown>; input: { path: string[]; value: unknown }[] };

const NOTHING: NonEmpty = { stubs: {}, input: [] };

/**
 * The list a holder map runs over, as a list of its own to make non-empty. The holder stands in the frames
 * `listHolder` found it in: all of the held list's frames where it is the list's sibling, fewer where the list was
 * handed into a call and the holder stands outside that call, or those of an outer map where it was handed into that
 * map. Its `over` is followed out through those frames and the maps enclosing them. The trigger's input steers it as it
 * steers the held list only where no frame was cut; otherwise `ownInputAt` follows the frames that are left.
 */
function ownListOf(held: Holder, holding: FoundList, from: Pick<Stubbing, 'overOf'>): FoundList | undefined {
  const over = from.overOf?.(held.target);
  if (over === undefined) return undefined;
  const fromTriggerIn = held.from.length === holding.from.length && holding.fromTriggerIn;
  return { at: held.target, over, fromTriggerIn, from: held.from };
}

/** Does this call hand its callee the caller's `in` untouched, field for field? Then the trigger's input still reaches inside. */
function forwardsIn(node: Record<string, unknown>): boolean {
  const given = node.in as Record<string, unknown> | undefined;
  if (!given || typeof given !== 'object') return false;
  return Object.entries(given).every(([name, value]) => {
    const src = value as { ref?: string; path?: string[] } | undefined;
    return src?.ref === 'in' && Array.isArray(src.path) && src.path.length === 1 && src.path[0] === name;
  });
}

/**
 * The rehearsal cases for one switch: one per rule plus the else, each with the stubs that steer the run
 * into that branch, and one per node the switch catches, which makes that node break. `generated` answers
 * what the seed produced for a node path, so a case only overrides the fields its rule reads.
 */
export function casesFor(found: FoundSwitch, from: Stubbing): Case[] {
  const settled: Settled = { ...from, typeOf: from.typeOf ?? (() => undefined), seed: from.seed ?? 1 };
  const { node, prefix } = found;
  const steerable = found.fromTriggerIn ?? !prefix.length;
  const branches = branchesOf(
    node.rules.map(rule => ({ when: rule.label, to: rule.to })),
    node.else,
  );
  const ruled = branches.map(branch => steer(branch, found, settled, steerable));
  return [...ruled, ...caughtCases(found)];
}

/** A stubbing with what a case needs settled: a type lookup that may answer nothing, and a seed. */
export type Settled = Required<Pick<Stubbing, 'generated' | 'typeOf' | 'seed'>> &
  Omit<Stubbing, 'generated' | 'typeOf' | 'seed'>;

/** The rule index a catch branch carries: neither a rule nor the else, since no rule is tried when a node broke. */
export const CAUGHT = -2;

/**
 * One case per node the switch catches, labelled `<node> broke`: nothing is demanded of the switch's inputs, since
 * the rules are not tried, and the caught node is made to break so its fault routes where the catch says.
 */
function caughtCases(found: FoundSwitch): Case[] {
  return Object.entries(found.node.catch ?? {}).map(([node, to]) => ({
    at: found.at,
    branch: { rule: CAUGHT, when: `${node} broke`, to, demands: {} },
    stubs: {},
    broken: [[...found.prefix, node].join('.')],
  }));
}

/** One branch as a case: the stubs and the input that steer a run into it. */
function steer(branch: Branch, found: FoundSwitch, from: Settled, steerable: boolean): Case {
  const steered: Steered = { stubs: {}, input: [] };
  const unmet: [string, Unmet][] = [];
  const at: At = { node: found.node, prefix: found.prefix, steerable, standing: standingOf(found) };
  const demands = branch.unsolved ? [] : Object.entries(branch.demands);
  for (const [dotted, domain] of demands) {
    const why = lay(meet(dotted, domain, at, from), steered, from);
    if (why) unmet.push([dotted, why]);
  }
  const { stubs, input } = steered;
  return { at: found.at, branch, stubs, ...(input.length ? { input } : {}), ...missedOf(unmet) };
}

/**
 * The demands a case does not meet, as the case says them: the fields under each reason and the sentence for each, and
 * the sentences of the literals that close it on this path, joined.
 */
function missedOf(unmet: [string, Unmet][]): Pick<Case, Exclude<Missed, 'closed'> | 'why' | 'closed'> {
  const closed = unmet.flatMap(([, one]) => (one.missed === 'closed' && one.why ? [one.why] : []));
  const out: Pick<Case, Exclude<Missed, 'closed'> | 'why' | 'closed'> = closed.length
    ? { closed: closed.join('; ') }
    : {};
  for (const [field, { missed, why }] of unmet) {
    if (missed === 'closed') continue;
    out[missed] = [...(out[missed] ?? []), field];
    if (why) out.why = { ...out.why, [field]: why };
  }
  return out;
}
