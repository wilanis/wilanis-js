/**
 * What `wilanis describe` says about a graph: what it takes and answers, the nodes it runs, and whether its
 * effects move together. A graph that declares `atomic` commits when it answers and rolls back on every reason
 * a refusal below it can give, so the lines name the connection the transaction falls on, the nodes of the
 * graph that take part, and those reasons.
 *
 * The nodes are not only the ones an author wrote. Where a field invariant could not be proved at a site, the
 * compiler lowers a guard there (RFC 0007), and the graph a run walks has nodes the file does not: the made
 * node moved aside to `<id>:made`, a switch on the rule, the value it lets through, the refusal it ends in. A
 * reader told only the authored nodes would be told a graph that does not exist -- would see no `invariant`
 * among the reasons and no branch the value can fail on -- so `describe` prints the lowered nodes too, each
 * marked `(guard)` and naming the invariant it stands for.
 *
 * Nothing is computed here: `atomicOf` reads the same per-profile walk the checker judges by and `guardsOf`
 * the same sites the compiler lowers at, so what a reader is told and what the tree was held to are one answer.
 */
import { atomicOf, type Guard, guardsOf, idsOf } from '@wilanis/compiler';
import type { GraphDoc, Loaded, Scope } from '@wilanis/core';
import { invariantName } from './invariant-lines.js';

/** The connection a transaction falls on, said for a reader: one, or the several the profiles disagree about. */
function whereLine(connections: string[]): string[] {
  if (!connections.length) return [];
  return connections.length === 1
    ? [`    on  ${connections[0]}`]
    : [`    on  ${connections.join(' or ')}  (one per profile; a run falls on the one its profile binds)`];
}

/**
 * Where the answer is read from, the guards counted in. A graph answering with a guarded value also answers
 * with that guard's refusal -- `lowerGuards` appends `<id>:violated` after `<id>` -- so a reader told only
 * the candidates the file names would be told a graph that cannot refuse where its own rule fails.
 */
function fromSaid(out: NonNullable<GraphDoc['out']>, guards: Guard[]): string {
  const from = Array.isArray(out.from) ? out.from : [out.from];
  const violated = new Map(guards.filter(one => one.arity !== 'list').map(one => [one.id, idsOf(one).violated]));
  return from.flatMap(one => [one, ...(violated.has(one) ? [violated.get(one) ?? one] : [])]).join(' | ');
}

/** What a graph takes, what it answers, and where the answer is read from. */
function contractLines(graph: GraphDoc, guards: Guard[]): string[] {
  const lines = graph.in ? [`takes   ${graph.in}`] : [];
  if (graph.resolvers) lines.push(`reads   ${graph.resolvers}`);
  if (graph.constants) lines.push(`constants  ${Object.keys(graph.constants).join(', ')}`);
  if (!graph.out) return lines;
  return [...lines, `answers ${graph.out.type}  from ${fromSaid(graph.out, guards)}`];
}

/**
 * One node as a reader meets it: what it runs, or the branches it routes to, under whatever id it has once
 * the guards are lowered. A `switch` that routed to a guarded node routes to the node that moved aside, since
 * the value is made where it was made before and the guard stands between it and everything downstream.
 */
function nodeLine(node: GraphDoc['nodes'][number], id: string, made: Map<string, string>): string {
  if (!('run' in node)) {
    const rules = (node as unknown as { rules: { to: string }[] }).rules.map(rule => rule.to);
    const otherwise = (node as unknown as { else?: string }).else;
    const routes = [...rules, otherwise].filter(Boolean).map(to => (to ? (made.get(to) ?? to) : to));
    return `    ${id}  switch → ${routes.join(' | ')}`;
  }
  return `    ${id}  ${node.run}`;
}

// ---- the nodes the compiler lowered, which the file does not have -------------------------------

/**
 * The header over one guard's nodes: which invariants it stands for, and the rule it tests. A site is guarded
 * once however many rules were unproved there, so the header names every one of them and joins their rules the
 * way the switch conjoins them -- a reader told only the first would go looking for a rule the guard tests and
 * the line never named. Saying it here rather than on each node keeps a fact the three share above the three.
 */
const guardHead = (guard: Guard): string =>
  `    guard for ${guard.unproved.map(one => invariantName(one.invariant)).join(' and ')}, when ${guard.when}:`;

/**
 * The three nodes a guard of one value is: the switch on the rule, the value it answers with, and the refusal
 * it ends in. Each is marked `(guard)`, because a reader meeting an id the file does not have should be told
 * on that line why, rather than having to find the header above it.
 */
const oneLines = (ids: ReturnType<typeof idsOf>): string[] => [
  `        ${ids.check}  switch → ${ids.ok} | ${ids.violated}  (guard)`,
  `        ${ids.ok}  answers ${ids.made}, which the rule let through  (guard)`,
  `        ${ids.violated}  refuses 'invariant'  (guard)`,
];

/**
 * A list of the shape, guarded element by element: the outer graph gains one node, a `map` running each element
 * through the three nodes above as a nested spec. The spec is named the way the compiler keys it, since that
 * name is what a rehearsal and the viewer read the guard by, and the map fails on the first element to violate.
 */
const listLines = (guard: Guard, ids: ReturnType<typeof idsOf>, graph: string): string[] => [
  `        ${ids.ok}  maps ${ids.made} through guard:${graph}#${guard.id}, element by element  (guard)`,
];

/** The nodes one guard adds, under the header that says what it guards: a list's one, or a single value's three. */
const guardLines = (guard: Guard, graph: string): string[] => {
  const ids = idsOf(guard);
  return [guardHead(guard), ...(guard.arity === 'list' ? listLines(guard, ids, graph) : oneLines(ids))];
};

/**
 * Every node of a graph as a run meets it: the ones its author wrote, and the ones a guard put in their place.
 * A made site's node is printed under `<id>:made`, where the compiler moved it, and the guard's nodes follow it;
 * a taken site has no authored node to move, since the value is the kernel's `in`, so its guard opens the list.
 */
function nodeLines(graph: GraphDoc, guards: Guard[], path: string): string[] {
  const at = new Map(guards.filter(one => one.site.kind === 'made').map(one => [one.id, one]));
  const moved = new Map([...at].map(([id, guard]) => [id, idsOf(guard).made]));
  const lines = guards.filter(one => one.site.kind === 'taken').flatMap(one => guardLines(one, path));
  for (const node of graph.nodes) {
    const guard = at.get(node.id);
    lines.push(nodeLine(node, moved.get(node.id) ?? node.id, moved));
    if (guard) lines.push(...guardLines(guard, path));
  }
  return lines;
}

/**
 * A graph: what it takes and answers, the nodes it runs -- the compiler's guards among them -- and, where it
 * says so, what its being atomic means. The document itself is the file named on the line above; what a reader
 * asked for is what it does.
 */
export function graphLines(doc: Loaded, scope: Scope): string[] {
  const graph = doc.doc as GraphDoc;
  const guards = guardsOf(scope, doc as Loaded<GraphDoc>);
  const lines = [...contractLines(graph, guards), 'nodes:', ...nodeLines(graph, guards, doc.path)];
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
