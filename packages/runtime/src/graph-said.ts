/**
 * What `wilanis describe` says about a graph beyond its JSON: whether its effects move together. A graph that
 * declares `atomic` commits when it answers and rolls back on every reason a refusal below it can give, so the
 * lines name the connection the transaction falls on, the nodes of the graph that take part, and those reasons.
 *
 * Nothing is computed here: `atomicOf` reads the same per-profile walk the checker judges by, so what a reader
 * is told and what the tree was held to are one answer.
 */
import { atomicOf } from '@wilanis/compiler';
import type { GraphDoc, Loaded, Scope } from '@wilanis/core';

/** The connection a transaction falls on, said for a reader: one, or the several the profiles disagree about. */
function whereLine(connections: string[]): string[] {
  if (!connections.length) return [];
  return connections.length === 1
    ? [`    on  ${connections[0]}`]
    : [`    on  ${connections.join(' or ')}  (one per profile; a run falls on the one its profile binds)`];
}

/** What a graph takes, what it answers, and where the answer is read from. */
function contractLines(graph: GraphDoc): string[] {
  const lines = graph.in ? [`takes   ${graph.in}`] : [];
  if (graph.resolvers) lines.push(`reads   ${graph.resolvers}`);
  if (graph.constants) lines.push(`constants  ${Object.keys(graph.constants).join(', ')}`);
  if (!graph.out) return lines;
  const from = Array.isArray(graph.out.from) ? graph.out.from.join(' | ') : graph.out.from;
  return [...lines, `answers ${graph.out.type}  from ${from}`];
}

/** One node as a reader meets it: what it runs, or the branches it routes to. */
function nodeLine(node: GraphDoc['nodes'][number]): string {
  if (!('run' in node)) {
    const rules = (node as unknown as { rules: { to: string }[]; else?: string }).rules.map(rule => rule.to);
    const otherwise = (node as unknown as { else?: string }).else;
    return `    ${node.id}  switch → ${[...rules, otherwise].filter(Boolean).join(' | ')}`;
  }
  return `    ${node.id}  ${node.run}`;
}

/**
 * A graph: what it takes and answers, the nodes it runs, and -- where it says so -- what its being atomic
 * means. The document itself is the file named on the line above; what a reader asked for is what it does.
 */
export function graphLines(doc: Loaded, scope: Scope): string[] {
  const graph = doc.doc as GraphDoc;
  const lines = [...contractLines(graph), 'nodes:', ...graph.nodes.map(nodeLine)];
  const atomic = atomicOf(scope, doc as Loaded<GraphDoc>);
  if (!atomic) return lines;
  const rolls = atomic.rollsBackOn.length
    ? `${atomic.rollsBackOn.map(reason => `'${reason}'`).join(', ')}, or a fault`
    : 'a fault';
  lines.push('', `atomic: commits when it answers; rolls back on ${rolls}`);
  lines.push(...whereLine(atomic.connections));
  if (atomic.participants.length) lines.push(`    taken part in by  ${atomic.participants.join(', ')}`);
  return lines;
}
