/**
 * The guard a field invariant lowers to (RFC 0007). Where the checker could not prove that a rule already
 * holds at a site -- a node that makes a value of the shape, a graph that takes one -- the compiler puts the
 * rule in the graph itself: a `switch` on the rule, routing to the value when it holds and to a `refuse` with
 * the reason `invariant` when it does not. The author writes nothing; the trigger maps the reason the way it
 * maps every other (T005), and a proved site adds nothing at all.
 *
 * Which sites those are is never re-derived here: `guardsOf` asks `heldWhollyAt` in `check/prove.ts`, the same
 * question the checker asks of the same sites, so the compiler cannot guard a site the checker proved nor
 * leave one it could not. Nothing is added to the engine -- a guard is a `switch` and two calls the kernel
 * already runs -- and nothing to the vocabulary but the one reserved reason word.
 *
 * A site is guarded once, not once per invariant: where two rules over one shape are both unproved there, the
 * one guard tests their conjunction, and where that fails it routes to the refusal of the first rule that did
 * not hold, so the caller is told the rule that broke and not every rule the site is held to (#492). One switch
 * per site keeps the ids the RFC names exactly one each -- `<id>:check`, `<id>`, `<id>:violated` -- which is
 * what the rehearsal, `describe` and the viewer read a guard by; a second rule adds only its own refusal,
 * `<id>:violated:2`, as one more branch of the same switch.
 */
import { expr, type GraphDoc, type InvariantDoc, type Loaded, type Scope } from '@wilanis/core';
import type { KCall, KernelSpec, KNode, KSwitch } from '@wilanis/engine';
import { conjunctsOf } from './check/narrowing.js';
import { heldWhollyAt, rootsOf } from './check/prove.js';
import { type Site, type SiteArity, siteId, sitesOf } from './sites.js';

/** The two native operations a guard is built from; both exist, so the guard adds nothing to any port. */
export const MAKE = '@std/object.port.json#make';
export const REFUSE = '@std/outcome.port.json#refuse';

/** The one word a guard refuses with, reserved so that a mapped `invariant` always means a guard (I006). */
export const INVARIANT = 'invariant';

/** One rule a site was not proved to satisfy: the invariant that states it, and the rule in the shape's fields. */
export interface Unproved {
  invariant: Loaded<InvariantDoc>;
  when: string;
}

/** One site a guard is lowered at: where the value comes into being, and every rule it is held to there. */
export interface Guard {
  site: Site;
  /** the read path the value has in its graph: the node's id, or `in` */
  id: string;
  arity: SiteArity;
  /** the shape the guarded value has, as the `make` and the `refuse` declare it */
  shape: string;
  /** every rule unproved here, in the order the registry holds the invariants */
  unproved: Unproved[];
  /** the one rule the switch tests: each unproved rule bracketed, joined by `&&` */
  when: string;
}

/** The four ids one guard occupies: where the judged value is read, and the three nodes that judge it. */
export type GuardIds = { made: string; check: string; ok: string; violated: string };

/**
 * The four ids a made site's guard occupies. The original node moves aside to `<id>:made` so that `<id>` still
 * answers the value and every read of it elsewhere is untouched. A colon cannot collide with an authored id,
 * which is an `ident`, so the four are the compiler's alone.
 */
export const guardIds = (id: string) => ({
  made: `${id}:made`,
  check: `${id}:check`,
  ok: id,
  violated: `${id}:violated`,
});

/**
 * The ids a taken site's guard occupies. The value already answers at `in`, which the kernel supplies and no
 * node may be named, so the guarded value takes `in:ok` and every authored read of `{{in}}` is renamed to it.
 */
export const TAKEN_IDS = { made: 'in', check: 'in:check', ok: 'in:ok', violated: 'in:violated' } as const;

/** The ids one guard occupies, whichever kind of site it stands at. */
export const idsOf = (guard: Guard) => (guard.site.kind === 'taken' ? TAKEN_IDS : guardIds(guard.id));

/** What one refusal of a guard says: the invariant it stands for, and the rule the value did not satisfy. */
export function guardMessage(one: Unproved): string {
  return `'${one.invariant.doc.label ?? one.invariant.path}' does not hold: ${one.when}`;
}

/**
 * The refusals one guard occupies, one per rule unproved at the site, in the order the rules are held: the
 * first is the frame's own `<id>:violated`, and each further rule's is suffixed `:2`, `:3`, ... A guard of one
 * rule therefore has exactly the ids it always had, and a reader who walks a guard by them still finds one.
 */
export function violatedIds(ids: GuardIds, count: number): string[] {
  return Array.from({ length: count }, (_, at) => (at === 0 ? ids.violated : `${ids.violated}:${at + 1}`));
}

/** The field names a rule reads, without repeats: one switch input per root, each read off the made value. */
export function guardRoots(when: string): string[] {
  const out = new Set<string>();
  let parsed: expr.Expr;
  try {
    parsed = expr.parse(when);
  } catch {
    return []; // I004 where the rule is judged
  }
  for (const conjunct of conjunctsOf(parsed)) for (const root of rootsOf(conjunct)) out.add(root);
  return [...out];
}

/** Every field invariant over one shape, in registry order; what a site of that shape is held to. */
function invariantsOn(scope: Scope, shape: string): Loaded<InvariantDoc>[] {
  const want = scope.canon(shape);
  const out: Loaded<InvariantDoc>[] = [];
  for (const one of scope.registry.all('invariant'))
    if (one.doc.holds && scope.canon(one.doc.holds.on) === want) out.push(one);
  return out;
}

/** The shapes a field invariant of this tree holds over, each canonical and named once. */
function heldShapes(scope: Scope): string[] {
  const out = new Set<string>();
  for (const one of scope.registry.all('invariant')) if (one.doc.holds) out.add(scope.canon(one.doc.holds.on));
  return [...out];
}

/** Every rule over a shape that one of its sites was not proved to satisfy, in registry order. */
function unprovedAt(scope: Scope, sites: Site[], site: Site, over: Loaded<InvariantDoc>[]): Unproved[] {
  const out: Unproved[] = [];
  for (const invariant of over) {
    const when = invariant.doc.holds?.when;
    if (when === undefined || heldWhollyAt(scope, sites, site, when)) continue;
    out.push({ invariant, when });
  }
  return out;
}

/** Every guard of a tree, by the graph that carries it: the walk over the shapes, made once per scope. */
function allGuards(scope: Scope): Map<string, Guard[]> {
  const out = new Map<string, Guard[]>();
  for (const shape of heldShapes(scope)) {
    const over = invariantsOn(scope, shape);
    const sites = sitesOf(scope, shape);
    for (const site of sites) {
      const unproved = unprovedAt(scope, sites, site, over);
      if (!unproved.length) continue;
      const when = unproved.map(one => `(${one.when})`).join(' && ');
      const guard: Guard = { site, id: siteId(site), arity: site.arity, shape, unproved, when };
      out.set(site.graph.path, [...(out.get(site.graph.path) ?? []), guard]);
    }
  }
  return out;
}

/**
 * The guards of a tree, found once per scope. Both the reason walk and the compiler ask this of graph after
 * graph, and the answer is a walk of every site of every guarded shape, so re-deriving it per graph would
 * cost the tree squared. A scope stands for one loaded tree and nothing in it changes, so the answer cannot
 * go stale; a scope that is dropped takes its answer with it.
 */
const CACHE = new WeakMap<Scope, Map<string, Guard[]>>();

/**
 * Every guard one graph carries: each site in it of a shape some invariant holds over, with the rules the
 * checker could not prove there. A site every rule was proved at yields nothing, which is the incentive the
 * design wants -- proving a rule costs the graph nothing and relieves its triggers of the reason. The order is
 * `sitesOf`'s, which is the graph's own node order, so two compilations of one tree agree.
 */
export function guardsOf(scope: Scope, graph: Loaded<GraphDoc>): Guard[] {
  let found = CACHE.get(scope);
  if (!found) {
    found = allGuards(scope);
    CACHE.set(scope, found);
  }
  return found.get(graph.path) ?? [];
}

/** Whether a graph carries a guard at all: what a walk of the reasons asks before reading the sites. */
export const hasGuard = (scope: Scope, graph: Loaded<GraphDoc>): boolean => guardsOf(scope, graph).length > 0;

// ---- the nodes a guard lowers to -----------------------------------------------------------------

/**
 * The name a list site's nested spec is registered and called under: the graph it stands in and the site in it,
 * which together name one guard of one tree. Spelled here alone, because three readers depend on it agreeing --
 * the lowering that registers the spec, `describe` that prints the map's handler, and the rehearsal that asks
 * for the spec back by name. A name invented at one of them and matched at another is the gap #437 was.
 */
export const guardSpecName = (graph: string, id: string): string => `guard:${graph}#${id}`;

/** Whether a handler names a guard's nested spec, and the graph and site it belongs to when it does. */
export function guardSpecAt(handler: string): { graph: string; id: string } | undefined {
  if (!handler.startsWith('guard:')) return undefined;
  const rest = handler.slice('guard:'.length);
  const hash = rest.lastIndexOf('#');
  if (hash < 0) return undefined;
  return { graph: rest.slice(0, hash), id: rest.slice(hash + 1) };
}

/** The handlers a guard needs, named by the compiler that owns them: it alone knows what a plugin answers. */
export interface GuardHandlers {
  /** the handler behind `@std/object.port.json#make` */
  make: string;
  /** the handler behind `@std/outcome.port.json#refuse` */
  refuse: string;
  /**
   * Register a nested spec, to be run with the element handed whole under `in`: what a list site's `map` calls
   * once per element. The spec is called by its own `name`, which `guardSpecName` gave it, so the compiler
   * registers rather than keys -- nothing invents a second name, and a reader who has the name has the spec.
   */
  nested: (spec: KernelSpec) => void;
}

/**
 * The switch that tests the rules: one input per root, read off the value. Its first rule is the conjunction,
 * routing to the value; where that fails, one rule per invariant but the last asks whether that invariant's
 * rule is what did not hold and routes to its own refusal, and the last invariant's refusal is the `else`,
 * since what remains once every other rule held is that one. The refusals are reached in the order the
 * invariants are held, so where two rules fail at once the first is the one named. A guard of one rule is the
 * switch it always was: the rule to the value, the else to the refusal.
 */
function checkNode(guard: Guard, from: string, ids: GuardIds): KSwitch {
  const inputs: Record<string, KSwitch['in'][string]> = {};
  for (const root of guardRoots(guard.when)) inputs[root] = { ref: from, path: [root] };
  const violated = violatedIds(ids, guard.unproved.length);
  const rules: KSwitch['rules'] = [{ when: expr.compilePredicate(guard.when), to: ids.ok, label: guard.when }];
  for (let at = 0; at < guard.unproved.length - 1; at++) {
    const failed = `!(${guard.unproved[at].when})`;
    rules.push({ when: expr.compilePredicate(failed), to: violated[at], label: failed });
  }
  return { kind: 'switch', in: inputs, rules, else: violated[violated.length - 1] };
}

/**
 * The call that answers the value once the rule held: the value exactly as it stands. It declares no type,
 * unlike every `make` an author writes, because it is not making a value -- the node it reads already made
 * one of the shape and was judged against it. Declaring the shape again would judge the same value twice and
 * make the guard the place a value fails for a reason that has nothing to do with the rule it tests.
 */
const okNode = (from: string, handlers: GuardHandlers): KCall => ({
  kind: 'call',
  handler: handlers.make,
  in: { value: { ref: from, path: [] } },
});

/** The call that refuses where one rule did not hold: the one reserved reason, and what that invariant says. */
const violatedNode = (one: Unproved, shape: string, handlers: GuardHandlers): KCall => ({
  kind: 'call',
  handler: handlers.refuse,
  in: {
    reason: { value: INVARIANT },
    message: { value: guardMessage(one) },
    type: { value: shape },
  },
});

/**
 * The nodes a guard of one value is: the switch on the rules, the value it answers with, and the refusal it
 * ends in -- one refusal per rule unproved at the site, each saying its own invariant. The judged value is read
 * from `ids.made` -- the node the original moved aside to, or `in`.
 */
export function guardNodes(guard: Guard, ids: GuardIds, handlers: GuardHandlers): Record<string, KNode> {
  const nodes: Record<string, KNode> = {
    [ids.check]: checkNode(guard, ids.made, ids),
    [ids.ok]: okNode(ids.made, handlers),
  };
  const violated = violatedIds(ids, guard.unproved.length);
  guard.unproved.forEach((one, at) => {
    nodes[violated[at]] = violatedNode(one, guard.shape, handlers);
  });
  return nodes;
}

/**
 * A list site's guard, as the nested spec one element runs through. The element arrives whole as `in`, so the
 * nodes are the ones a single value gets, read from the pseudo-node the kernel supplies. The map that runs it
 * fails on the first element that refuses, so the list refuses with that element's reason.
 */
export function guardSpec(guard: Guard, name: string, handlers: GuardHandlers): KernelSpec {
  return {
    name,
    nodes: guardNodes(guard, TAKEN_IDS, handlers),
    output: [TAKEN_IDS.ok, ...violatedIds(TAKEN_IDS, guard.unproved.length)],
  };
}
