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

/** A graph: its JSON, and -- where it says so -- what its being atomic means. */
export function graphLines(doc: Loaded, scope: Scope): string[] {
  const lines = [JSON.stringify(doc.doc, null, 2)];
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
