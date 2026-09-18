/**
 * Branch enumeration for the rehearsal: every way a switch can route, solved from its own expressions.
 *
 * Rehearsing with generated stubs takes whichever branch the seed happens to satisfy; to walk them all we read the
 * rules instead of guessing. For each rule we build the values that make it true and every earlier rule false -- that
 * is the case which reaches its target, since the kernel tries rules in order -- and one more case for the else,
 * where every rule is false at once. The solver itself is in domains.ts, and what it writes into a stub in stubs.ts.
 */
import { type Type, typeAt } from '@wilanis/core';
import type { Branch, Domain } from './domains.js';
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
  input?: { path: string[]; value: unknown }[];
  /** Demands that could not be routed to anything the rehearsal can set. */
  unreachable?: string[];
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
}

/** One call the walk descended through: its dotted path, and the sources the call was given by name. */
export interface Frame {
  at: string;
  in: Record<string, unknown>;
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
}

/** The shape of a lowered switch this module needs; `label` carries the rule's source text. */
export interface KSwitchLike {
  kind: 'switch';
  in: Record<string, unknown>;
  rules: { to: string; label: string }[];
  else: string;
}

/** Where a switch input reads from: a node in the same spec, and the path within that node's output. */
function sourceOf(spec_: unknown): { ref: string; path: string[] } | undefined {
  if (!spec_ || typeof spec_ !== 'object') return undefined;
  const object = spec_ as Record<string, unknown>;
  if (typeof object.ref === 'string' && Array.isArray(object.path))
    return { ref: object.ref, path: object.path as string[] };
  return undefined; // list/object/value/concat sources are composed, not a single stubbable node
}

/**
 * Every switch reachable from a spec, including those inside graph-bound calls. `nested` resolves a
 * call's handler to the spec it runs, so the walk does not need the compiler's private caches.
 */
export function switchesOf(
  spec: { nodes: Record<string, unknown> },
  nested: (handler: string) => { nodes: Record<string, unknown> } | undefined,
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
  nested: (handler: string) => { nodes: Record<string, unknown> } | undefined,
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
      },
    ];
  const handler = typeof node.handler === 'string' ? node.handler : undefined;
  // a handler is walked once per branch position; recursion through the same handler would not terminate
  if (!handler || seen.has(handler)) return [];
  const sub = nested(handler);
  if (!sub) return [];
  const here = [...prefix, id].join('.');
  const walked = { seen: new Set([...seen, handler]), via: [...via, here] };
  // a mapped operation runs once per element, each under the element's index; the first element stands for all,
  // and what it receives is the element, never the trigger's input
  if (node.kind === 'map')
    return switchesOf(sub, nested, {
      ...walked,
      prefix: [...prefix, id, '0'],
      fromTriggerIn: false,
      lists: [...lists, { at: here, over: node.over, fromTriggerIn, from: entered }],
      entered: [],
    });
  return switchesOf(sub, nested, {
    ...walked,
    prefix: [...prefix, id],
    fromTriggerIn: fromTriggerIn && forwardsIn(node),
    lists,
    entered: [...entered, { at: here, in: (node.in as Record<string, unknown>) ?? {} }],
  });
}

/**
 * What it takes for a mapped operation to run at all: its list holds at least one element. A demand on the
 * trigger's input when the list is read from it, a stub of the node that holds it otherwise -- a sibling of
 * the map, or, where the map runs over what its frame was handed, the node one hop out that fed the call.
 * Nothing when the list is composed or literal, since a literal list is already what it is.
 */
export function nonEmpty(
  list: FoundList,
  from: Stubbing,
): { stubs: Record<string, unknown>; input: { path: string[]; value: unknown }[] } {
  const { generated, typeOf = () => undefined, seed = 1, inputSeed, inType } = from;
  const src = sourceOf(list.over);
  const want: Domain = { minLen: 1, present: true };
  if (!src) return { stubs: {}, input: [] };
  if (src.ref === 'in' && list.fromTriggerIn)
    return {
      stubs: {},
      input: [
        { path: src.path, value: satisfy(want, getPath(inputSeed, src.path), typeAtPath(inType, src.path), seed) },
      ],
    };
  const held = listHolder(list);
  if (!held) return { stubs: {}, input: [] };
  const { target, path } = held;
  const base = generated(target);
  return {
    stubs: {
      [target]: setPath(base, path, satisfy(want, getPath(base, path), typeAtPath(typeOf(target), path), seed)),
    },
    input: [],
  };
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
 * into that branch. `generated` answers what the seed produced for a node path, so a case only overrides
 * the fields its rule reads.
 */
export function casesFor(found: FoundSwitch, from: Stubbing): Case[] {
  const { generated, typeOf = () => undefined, seed = 1, inputSeed, inType } = from;
  const { node, prefix } = found;
  const steerable = found.fromTriggerIn ?? !prefix.length;
  const branches = branchesOf(
    node.rules.map(rule => ({ when: rule.label, to: rule.to })),
    node.else,
  );
  return branches.map(branch => steer(branch, found, { generated, typeOf, seed, inputSeed, inType }, steerable));
}

/** Where a switch stands: the switch itself, where its siblings are stubbed, and how its `in` can be steered. */
interface At {
  node: KSwitchLike;
  prefix: string[];
  steerable: boolean;
  /** the innermost map enclosing the switch, whose element is what its `in` reads */
  element?: FoundList;
}

/**
 * Which node's output holds the list a map runs over, and where in it. A sibling of the map, usually; but a map
 * whose `over` reads `in` iterates what the frame was handed, so the answer is one hop out -- the call that
 * entered the frame, and the source it was given under that name. Nothing when the list is composed, literal,
 * the request's or the trigger's own: a composed list is no single node's output to stub, and the trigger's
 * input the rehearsal steers is met before this is asked.
 */
function listHolder(list: FoundList): { target: string; path: string[] } | undefined {
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

/**
 * A demand on `in` where `in` is an element a map handed in, met by writing that element into the list the map
 * runs over. The first element stands for all of them, as it does everywhere else in the walk, so the demand
 * lands at index 0.
 */
function ofElement(list: FoundList, within: string[], domain: Domain) {
  const held = listHolder(list);
  if (!held) return 'unreachable' as const;
  return { stub: { target: held.target, path: [...held.path, '0', ...within], value: domain } };
}

/** Where one demand is met: the trigger's input, an element of a mapped list, a node's stub, or nowhere. */
function meet(
  dotted: string,
  domain: Domain,
  at: At,
  from: Required<Pick<Stubbing, 'generated' | 'typeOf' | 'seed'>> & Pick<Stubbing, 'inputSeed' | 'inType'>,
):
  | { input: { path: string[]; value: unknown } }
  | { stub: { target: string; path: string[]; value: unknown } }
  | 'unreachable' {
  const [inputName, ...within] = dotted.split('.');
  const src = sourceOf(at.node.in[inputName]);
  if (!src) return 'unreachable';
  // a switch in the top-level graph reading `in` is steered by the trigger's input, not a stub
  if (src.ref === 'in' && at.steerable) {
    const full = [...src.path, ...within];
    return {
      input: {
        path: full,
        value: satisfy(domain, getPath(from.inputSeed, full), typeAtPath(from.inType, full), from.seed),
      },
    };
  }
  // inside a map, `in` is the element: what steers it is the list the map runs over
  if (src.ref === 'in' && at.element) return ofElement(at.element, [...src.path, ...within], domain);
  if (src.ref === 'in' || src.ref === 'request' || src.ref === 'const') return 'unreachable';
  return { stub: { target: stubTarget(at.prefix, src.ref, from), path: [...src.path, ...within], value: domain } };
}

/**
 * Which stub a demand writes into. An operation met by a delegation lowers to a wrapper spec holding one node `op`,
 * so what the seed recorded for it sits one level deeper.
 */
function stubTarget(prefix: string[], ref: string, from: Pick<Required<Stubbing>, 'generated' | 'typeOf'>): string {
  const direct = [...prefix, ref].join('.');
  const deeper = `${direct}.op`;
  const bare = from.generated(direct) === undefined && !from.typeOf(direct);
  return bare && (from.generated(deeper) !== undefined || from.typeOf(deeper)) ? deeper : direct;
}

/** One demand written into the stub it steers, on top of what earlier demands already wrote there. */
function write(
  stubs: Record<string, unknown>,
  stub: { target: string; path: string[]; value: unknown },
  from: Required<Pick<Stubbing, 'generated' | 'typeOf' | 'seed'>>,
) {
  const { target, path } = stub;
  const base = target in stubs ? stubs[target] : from.generated(target);
  const want = satisfy(stub.value as Domain, getPath(base, path), typeAtPath(from.typeOf(target), path), from.seed);
  stubs[target] = setPath(base, path, want);
}

/**
 * The map whose element this switch reads as `in`, where it reads one at all: the innermost enclosing map, and
 * only when the switch stands directly in the spec that map runs -- its prefix is the map's own plus the index
 * the walk enters an element under. A switch deeper than that sits in a further call, whose `in` is whatever
 * that call was handed rather than the element, and steering the list would not move it.
 */
function elementOf(found: FoundSwitch): FoundList | undefined {
  const innermost = found.lists[found.lists.length - 1];
  if (!innermost) return undefined;
  const directly = [...innermost.at.split('.'), '0'].join('.');
  return found.prefix.join('.') === directly ? innermost : undefined;
}

/** One branch as a case: the stubs and the input that steer a run into it. */
function steer(
  branch: Branch,
  found: FoundSwitch,
  from: Required<Pick<Stubbing, 'generated' | 'typeOf' | 'seed'>> & Pick<Stubbing, 'inputSeed' | 'inType'>,
  steerable: boolean,
): Case {
  const stubs: Record<string, unknown> = {};
  const input: { path: string[]; value: unknown }[] = [];
  const unreachable: string[] = [];
  const at: At = { node: found.node, prefix: found.prefix, steerable, element: elementOf(found) };
  const demands = branch.unsolved ? [] : Object.entries(branch.demands);
  for (const [dotted, domain] of demands) {
    const met = meet(dotted, domain, at, from);
    if (met === 'unreachable') unreachable.push(dotted);
    else if ('input' in met) input.push(met.input);
    else write(stubs, met.stub, from);
  }
  return {
    at: found.at,
    branch,
    stubs,
    ...(input.length ? { input } : {}),
    ...(unreachable.length ? { unreachable } : {}),
  };
}

/** The declared type at a path within a node's output type, as far as the type system can follow it. */
function typeAtPath(type: Type | undefined, path: string[]): Type | undefined {
  if (!type) return undefined;
  // typeAt answers a string when the path cannot be followed into the type
  try {
    const rule = typeAt(type, path);
    return typeof rule === 'string' ? undefined : rule.type;
  } catch {
    return undefined;
  }
}
