/**
 * What a node's `after` may name (RFC 0041). A run or a map waits for the nodes it names there, without reading
 * their answers. Each one is another node of this graph, and not a switch: a switch answers on every branch, so
 * waiting for it holds nothing back (G029). And none is a node this one already reads, since a node waits for
 * whatever it reads (G030). Only a direct read is judged: a node that reads a reader of `x` and waits for `x`
 * says one wait twice, but the edge is still true, and finding it would take a walk over the whole graph.
 */
import { afterOf, isSwitch, type Node, type Scope, type SwitchNode } from '@wilanis/core';
import { targetsOf } from './graph-routing.js';
import { type Refuser, readValuesOf } from './judge.js';

/** The graph whose nodes' `after` is judged: where to refuse, its nodes, and the scope that parses a read. */
export interface AfterSite {
  refuse: Refuser;
  nodes: Map<string, Node>;
  scope: Scope;
}

/** G029 and G030, for each entry of each node's `after`: a node this one may wait for and does not already read. */
export function checkAfter(site: AfterSite): void {
  for (const node of site.nodes.values())
    for (const [index, id] of afterOf(node).entries()) checkEntry(site, node, id, `nodes/${node.id}/after/${index}`);
}

/** One entry of a node's `after`, refused where it is written. */
function checkEntry(site: AfterSite, node: Node, id: string, at: string): void {
  const named = site.nodes.get(id);
  if (!named) {
    const hint = `name a node of this graph that must answer before '${node.id}' starts`;
    site.refuse('G029', `after names unknown node '${id}'`, at, hint);
  } else if (id === node.id) site.refuse('G029', `'${id}' waits for itself`, at, `drop '${id}' from its own after`);
  else if (isSwitch(named))
    site.refuse('G029', `after names switch '${id}', which answers on every branch`, at, switchHint(named, node.id));
  else checkNotRead(site, node, id, at);
}

/**
 * G029's hint for a switch: wait for a node one of its rules routes to, since that node runs only where the rule
 * held. A node the switch itself routes waits for it already, and is told so.
 */
function switchHint(named: SwitchNode, waiter: string): string {
  if (targetsOf(named).includes(waiter))
    return `drop '${named.id}' from after: '${waiter}' already runs only where '${named.id}' routes to it`;
  const targets = [...new Set(named.rules.map(rule => rule.to))];
  return `wait for the node its rule routes to: ${targets.map(target => `"after": ["${target}"]`).join(' or ')}`;
}

/** G030: the node already reads the one it names, in its `in` or a map's `over`, so it waits for it already. */
function checkNotRead(site: AfterSite, node: Node, id: string, at: string): void {
  const read = site.scope.templateReads(readValuesOf(node)).find(path => path[0] === id);
  if (!read) return;
  const message = `'${node.id}' already waits for '${id}': it reads {{${read.join('.')}}}`;
  site.refuse('G030', message, at, `drop '${id}' from after; a node waits for whatever it reads`);
}
