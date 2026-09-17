/**
 * Where a field invariant falls on a graph, and where it falls on the shape it is about. A rule stated once is
 * held everywhere a value of the shape comes into being, and nothing in either document says where those places
 * are: the graph's author never wrote the guard, and the invariant's author never named the graph. So a reader
 * with only the JSON cannot see which node the compiler put a rule in front of, nor which node proved it and
 * costs the tree nothing.
 *
 * Nothing here judges. `sitesOf` says where a value comes into being, `heldAt` how each conjunct of a rule is
 * established there, and `guardsOf` which sites the compiler guarded -- the same three answers the checker
 * (I005), the lowering and the rehearsal read, so the badge on a node and the guard in the spec cannot say
 * different things. This maps those answers onto what a page draws.
 */
import { type Guard, guardsOf, heldAt, type Proof, type Site, siteId, sitesOf } from '@wilanis/compiler';
import type { GraphDoc, InvariantDoc, Loaded, Scope } from '@wilanis/core';
import type { VGuarded, VHeld, VNode, VProved, VSite } from './types.js';
import { labelOf } from './types.js';

/** Every field invariant of a tree, by the canonical shape it holds over: what a site of that shape is held to. */
function heldShapes(scope: Scope): Map<string, Loaded<InvariantDoc>[]> {
  const out = new Map<string, Loaded<InvariantDoc>[]>();
  for (const one of scope.registry.all('invariant')) {
    const on = one.doc.holds?.on;
    if (!on) continue;
    const shape = scope.canon(on);
    out.set(shape, [...(out.get(shape) ?? []), one]);
  }
  return out;
}

/** How one conjunct was established, in the words RFC 0007 asks a reader to be told. */
const heldBy = (proof: Proof): VHeld => {
  if (proof.by === 'narrowed') return { by: 'narrowed', switch: proof.switch };
  if (proof.by === 'through') return { by: 'through', node: proof.node };
  return { by: 'literal' };
};

/** How a site stands against one invariant: every conjunct established, or nothing where one was not. */
function provedBy(scope: Scope, sites: Site[], site: Site, when: string): VHeld[] | undefined {
  const proofs = [...heldAt(scope, sites, site, when).values()];
  if (!proofs.length || proofs.some(proof => proof.by === 'guarded')) return undefined;
  return proofs.map(heldBy);
}

/** One invariant as a badge names it: the label it declares, or its file made readable, and where a click lands. */
const named = (invariant: Loaded<InvariantDoc>) => ({ path: invariant.path, label: labelOf(invariant) });

/** What a guard stands for, as the node it guards carries it: every invariant unproved there, and the one rule. */
const guardedBy = (guard: Guard): VGuarded => ({
  by: guard.unproved.map(one => named(one.invariant)),
  when: guard.when,
  arity: guard.arity,
});

/** Every rule proved at one site, with how each conjunct was established; nothing where none was proved. */
function provedAt(scope: Scope, sites: Site[], site: Site, over: Loaded<InvariantDoc>[]): VProved | undefined {
  const by: VProved['by'] = [];
  for (const invariant of over) {
    const when = invariant.doc.holds?.when;
    if (when === undefined) continue;
    const held = provedBy(scope, sites, site, when);
    if (held) by.push({ ...named(invariant), when, held });
  }
  return by.length ? { by, arity: site.arity } : undefined;
}

/**
 * What one graph's nodes carry: the guard the compiler lowered at a site, or the proof that spared it one. A
 * node is one or the other and never both -- a site every rule was proved at is guarded nowhere, and a site
 * one rule was unproved at carries that guard, where the proof of the others is not what a reader needs. A
 * site is found by the read path it answers at, which is the node's id, or `in` where the graph takes it.
 */
export function markGuards(scope: Scope, graph: Loaded<GraphDoc>, nodes: VNode[]): void {
  const guarded = new Map<string, VGuarded>();
  for (const guard of guardsOf(scope, graph)) guarded.set(siteId(guard.site), guardedBy(guard));
  const proved = provedSites(scope, graph, guarded);
  for (const node of nodes) {
    const guard = guarded.get(node.id);
    if (guard) node.guarded = guard;
    const held = proved.get(node.id);
    if (held) node.proved = held;
  }
}

/** Every site of the graph a rule was proved at, leaving out the ones a guard already stands at. */
function provedSites(scope: Scope, graph: Loaded<GraphDoc>, guarded: Map<string, VGuarded>): Map<string, VProved> {
  const out = new Map<string, VProved>();
  for (const [shape, over] of heldShapes(scope))
    for (const [id, found] of provedIn(scope, graph, shape, over)) if (!guarded.has(id)) out.set(id, found);
  return out;
}

/** Every site of one shape in one graph that its invariants were proved at, by the read path it answers at. */
function provedIn(
  scope: Scope,
  graph: Loaded<GraphDoc>,
  shape: string,
  over: Loaded<InvariantDoc>[],
): Map<string, VProved> {
  const out = new Map<string, VProved>();
  const sites = sitesOf(scope, shape);
  for (const site of sites) {
    if (site.graph.path !== graph.path) continue;
    const found = provedAt(scope, sites, site, over);
    if (found) out.set(siteId(site), found);
  }
  return out;
}

/**
 * Every site of one field invariant's shape, and where each stands: proved, with how each conjunct was
 * established, or guarded. This is the table RFC 0007 asks the invariant's own page for -- a rule stated once
 * is worth nothing if a reader cannot see the thirteen places it landed and which of them cost the tree a
 * switch. The order is `sitesOf`'s, so the page and the rehearsal count the same sites in the same order.
 */
export function sitesOfInvariant(scope: Scope, invariant: Loaded<InvariantDoc>): VSite[] {
  const holds = invariant.doc.holds;
  if (!holds) return [];
  const sites = sitesOf(scope, holds.on);
  return sites.map(site => {
    const held = provedBy(scope, sites, site, holds.when);
    return {
      graph: site.graph.path,
      graphLabel: labelOf(site.graph),
      node: siteId(site),
      kind: site.kind,
      arity: site.arity,
      ...(held ? { held } : {}),
    };
  });
}
