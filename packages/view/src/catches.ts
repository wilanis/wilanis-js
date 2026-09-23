/**
 * What a page is told about a switch's `catch` (RFC 0014): where the switch routes a node that broke. A catch is
 * routing about an outcome rather than a value, so it is drawn beside the rule edges and not as a rule: one edge
 * per caught node, from the top of the switch's ladder (a fault is caught before any rule is tried) to its target,
 * labelled `<node> broke`. Every rule of the switch carries the catch on its decision, since the ladder is the
 * switch, and the caught node carries the switch that catches it, so its panel can say so.
 */
import { type GraphDoc, isSwitch, type SwitchNode } from '@wilanis/core';
import { WHOLE } from './ports.js';
import type { VEdge, VNode } from './types.js';

/** What a switch's decision carries: its `catch` as written, a node it reads to where it routes when that breaks. */
export interface VCatches {
  catch?: Record<string, string>;
}

/** What a node a switch catches carries: the switch whose catch routes it when it breaks. */
export interface VCaught {
  caughtBy?: string;
}

/** The edge a switch's catch draws: from its first rule to where the fault is routed, labelled with what broke. */
const catchEdge = (id: string, broke: string, to: string): VEdge => ({
  from: `${id}/1`,
  fromPort: WHOLE,
  to,
  toPort: WHOLE,
  kind: 'catch',
  label: `${broke} broke`,
});

/** One switch's catch, marked on its rules and on each node it catches, with the edge each draws. */
function markCatch(node: SwitchNode, catches: Record<string, string>, view: { nodes: VNode[]; edges: VEdge[] }) {
  for (const drawn of view.nodes) {
    if (drawn.decision?.id === node.id) drawn.decision.catch = catches;
    if (Object.hasOwn(catches, drawn.id)) drawn.caughtBy = node.id;
  }
  for (const [broke, to] of Object.entries(catches)) view.edges.push(catchEdge(node.id, broke, to));
}

/** Every switch's catch of a graph, marked on the view: the rules, the caught nodes and the catch edges. */
export function markCatches(doc: GraphDoc, view: { nodes: VNode[]; edges: VEdge[] }): void {
  for (const node of doc.nodes) if (isSwitch(node) && node.catch) markCatch(node, node.catch, view);
}
