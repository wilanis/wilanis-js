/** What the scheduler knows before anything runs: who waits for whom, which switch routes each node, and which catches its fault. */

import { nodeRefs, PSEUDO } from './sources.js';
import type { KernelSpec, KNode, KSwitch } from './spec.js';

export interface Plan {
  /** node id -> the switch that names it; such a node runs only when that switch selects it */
  routedBy: Map<string, string>;
  /** node id -> the nodes it waits for: what it reads, and the switch that routes it */
  dependencies: Map<string, Set<string>>;
  /** node id -> the nodes that wait for it */
  dependents: Map<string, Set<string>>;
  /** node id -> the switch whose `catch` names it; that switch routes the node's fault instead of the run ending */
  catchers: Map<string, string>;
}

/** Every node a switch can route to: a rule's, the fallback, and where each caught fault goes. */
export function targetsOf(node: KSwitch): string[] {
  return [...node.rules.map(rule => rule.to), node.else, ...Object.values(node.catch ?? {})];
}

/** The switch that catches each caught node, from every switch's `catch`. */
function catchersOf(spec: KernelSpec): Map<string, string> {
  const catchers = new Map<string, string>();
  for (const [id, node] of Object.entries(spec.nodes))
    if (node.kind === 'switch') for (const caught of Object.keys(node.catch ?? {})) catchers.set(caught, id);
  return catchers;
}

/** The routing, dependency and catching tables of a spec. */
export function planOf(spec: KernelSpec): Plan {
  const routedBy = new Map<string, string>();
  for (const [id, node] of Object.entries(spec.nodes)) {
    if (node.kind !== 'switch') continue;
    for (const target of targetsOf(node)) routedBy.set(target, id);
  }
  const dependencies = new Map<string, Set<string>>();
  for (const [id, node] of Object.entries(spec.nodes)) dependencies.set(id, waitsFor(spec, routedBy, id, node));
  return { routedBy, dependencies, dependents: invert(dependencies), catchers: catchersOf(spec) };
}

/** What one node waits for: the nodes it reads, the switch that routes it, and for a switch what it catches. */
function waitsFor(spec: KernelSpec, routedBy: Map<string, string>, id: string, node: KNode): Set<string> {
  const waits = new Set([...nodeRefs(node)].filter(ref => !PSEUDO.has(ref) && ref in spec.nodes));
  const router = routedBy.get(id);
  if (router) waits.add(router);
  if (node.kind === 'switch') for (const caught of Object.keys(node.catch ?? {})) waits.add(caught);
  return waits;
}

/** The reverse of a dependency table. */
function invert(dependencies: Map<string, Set<string>>): Map<string, Set<string>> {
  const dependents = new Map<string, Set<string>>();
  for (const [id, waitsFor] of dependencies) {
    for (const dependency of waitsFor) {
      const set = dependents.get(dependency) ?? new Set<string>();
      set.add(id);
      dependents.set(dependency, set);
    }
  }
  return dependents;
}
