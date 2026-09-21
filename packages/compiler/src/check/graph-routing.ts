/**
 * Where a node sits in a graph's routing. A node runs when what it reads is ready, whatever a switch chose:
 * the switch decides who answers, not who runs. So a node sits behind a switch when a rule or `else` names
 * it, or when it reads something that does, and a node reached neither way runs on every branch. `routed`
 * answers whether a node sits behind any switch; `branchesOf` answers behind which branch of which; and
 * `readOnSomeBranchesOnly` puts the two together for G015, over the one walk G008 and G010 make.
 */
import { isSwitch, type Node } from '@wilanis/core';
import { targetsOf } from './graph-nodes.js';

/** Who routes whom and who reads whom: what every question about a graph's routing is asked over. */
export interface Routing {
  /** node id -> the switch whose rule or else names it */
  routedBy: Map<string, string>;
  /** node id -> the nodes it reads */
  dependencies: Map<string, Set<string>>;
}

/** Does a node sit behind a switch: routed itself, or reading something that is? Otherwise it runs on every branch. */
export function routed(routing: Routing, id: string, seen = new Set<string>()): boolean {
  if (seen.has(id)) return false;
  seen.add(id);
  if (routing.routedBy.has(id)) return true;
  return [...(routing.dependencies.get(id) ?? [])].some(dependency => routed(routing, dependency, seen));
}

/** Who reads whom: the dependency table the other way round, node id -> the nodes that read its answer. */
export function readersOf(dependencies: Map<string, Set<string>>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [reader, read] of dependencies) {
    for (const id of read) {
      const readers = out.get(id) ?? new Set<string>();
      readers.add(reader);
      out.set(id, readers);
    }
  }
  return out;
}

/**
 * The branches a node sits behind, added to `out`: each switch that routes it or anything it reads, with the
 * targets of that switch the node is reached through. Two nodes behind one rule share a branch; two behind
 * different rules of one switch do not, which is what G015 tells them apart by.
 */
export function branchesOf(
  routing: Routing,
  id: string,
  out = new Map<string, Set<string>>(),
  seen = new Set<string>(),
): Map<string, Set<string>> {
  if (seen.has(id)) return out;
  seen.add(id);
  const router = routing.routedBy.get(id);
  if (router !== undefined) {
    const targets = out.get(router) ?? new Set<string>();
    targets.add(id);
    out.set(router, targets);
    branchesOf(routing, router, out, seen);
  }
  for (const dependency of routing.dependencies.get(id) ?? []) branchesOf(routing, dependency, out, seen);
  return out;
}

/** Everything a node runs after: what it reads, the switch that routes it, and theirs in turn. */
function upstreamOf(routing: Routing, id: string, out = new Set<string>()): Set<string> {
  const router = routing.routedBy.get(id);
  const above = [...(routing.dependencies.get(id) ?? []), ...(router === undefined ? [] : [router])];
  for (const one of above) {
    if (out.has(one)) continue;
    out.add(one);
    upstreamOf(routing, one, out);
  }
  return out;
}

/**
 * The readers none of the others runs after: where an answer first enters a branch. A hint that sends an
 * effect under the branch reading it names these, since whatever reads the answer further down sits behind
 * them already.
 */
export function firstReaders(routing: Routing, readers: string[]): string[] {
  const upstream = new Map(readers.map(reader => [reader, upstreamOf(routing, reader)]));
  return readers.filter(reader => !readers.some(other => other !== reader && upstream.get(reader)?.has(other)));
}

/**
 * Is some switch that always runs reached through every one of its targets? Then, taken together, what sits
 * behind those branches runs on every run. A reader behind a further switch under one of the targets is not
 * looked into, so this errs toward yes, and G015 toward silence.
 */
function coversEveryBranch(routing: Routing, nodes: Map<string, Node>, branches: Map<string, Set<string>>): boolean {
  for (const [router, targets] of branches) {
    const node = nodes.get(router);
    if (!node || !isSwitch(node) || routed(routing, router)) continue;
    if (targetsOf(node).every(target => targets.has(target))) return true;
  }
  return false;
}

/**
 * Is a node's answer read on some branches only? Every reader sits behind a switch, and no switch that always
 * runs is reached through all of its targets. An answer nothing reads is not that (G008 says so), and one a
 * reader no switch routes takes is read on every run.
 */
export function readOnSomeBranchesOnly(routing: Routing, nodes: Map<string, Node>, readers: string[]): boolean {
  if (readers.length === 0 || readers.some(reader => !routed(routing, reader))) return false;
  const branches = new Map<string, Set<string>>();
  for (const reader of readers) branchesOf(routing, reader, branches);
  return !coversEveryBranch(routing, nodes, branches);
}
