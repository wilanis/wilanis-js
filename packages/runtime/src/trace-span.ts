/**
 * The parts every span of a trace is made of: the one constructor, and what a node's span says about itself
 * whatever kind of node it is. `trace.ts` walks the run and decides which spans there are; this says what one
 * carries, so the rule for what may leave the process at each level is written once.
 */
import { isSwitch, type Scope, type Trace, type TraceAttributes, type TraceLevel } from '@wilanis/core';
import type { NodeReport, Report } from '@wilanis/engine';

/** What a walk of one run carries down: the tree it reads contracts from, and how much a span may say. */
export interface Walk {
  scope: Scope;
  level: TraceLevel;
}

/** A span built from its parts, so every one of them is made in one place and carries the same shape. */
export function span(what: {
  name: string;
  status: string;
  at: { startedAt?: number; endedAt?: number };
  attributes: TraceAttributes;
  children?: Trace[];
}): Trace {
  return {
    name: what.name,
    startedAt: what.at.startedAt ?? 0,
    endedAt: what.at.endedAt ?? what.at.startedAt ?? 0,
    status: what.status,
    attributes: what.attributes,
    children: what.children ?? [],
  };
}

/** What `wilanis.in`, `wilanis.out` and `wilanis.error` a node may carry: all of them at `full`, none at `summary`. */
export function valued(node: Pick<NodeReport, 'in' | 'out' | 'error'>, level: TraceLevel): TraceAttributes {
  if (level !== 'full') return {};
  const out: TraceAttributes = {};
  if (node.in !== undefined) out['wilanis.in'] = JSON.stringify(node.in);
  if (node.out !== undefined) out['wilanis.out'] = JSON.stringify(node.out);
  if (node.error !== undefined) out['wilanis.error'] = node.error;
  return out;
}

/**
 * The connection an effect used and the status an HTTP call answered, read off the node's own `in` and `out`.
 * It is a lookup and never a branch that spreads: the engine knows nothing of connections or of HTTP, so the
 * two names a reader searches on are read here, where the tree's words are already known.
 */
function looked(node: NodeReport): TraceAttributes {
  const out: TraceAttributes = {};
  const connection = node.in?.connection;
  if (typeof connection === 'string') out['wilanis.connection'] = connection;
  const answered = node.out as Record<string, unknown> | undefined;
  const status = answered && typeof answered === 'object' ? answered.status : undefined;
  if (node.handler === HTTP_REQUEST && typeof status === 'number') out['http.response.status_code'] = status;
  return out;
}

/** The one handler whose answer carries a status a reader of a trace expects to find under its own name. */
const HTTP_REQUEST = '@http/http.port.json#request';

/**
 * How a node ended, in the words a span carries: a refusal says its reason, a fault a switch caught says so --
 * it broke, and the run went on -- and anything else says its status.
 */
export function nodeStatus(node: NodeReport): string {
  if (node.status !== 'failed') return node.status === 'done' ? 'ok' : node.status;
  if (node.reason) return `refused: ${node.reason}`;
  return node.caught ? 'failed (caught)' : 'failed';
}

/**
 * The node whose fault a switch routed, as `wilanis.caught`: a node id the author wrote, so it is said at
 * `summary` beside `wilanis.selected`. Where two of its caught nodes broke, the switch routed on the first in
 * its `catch`, which the graph document says; a report the tree no longer holds falls back to report order.
 */
export function caughtAt(id: string, within: Report | undefined, scope: Scope): TraceAttributes {
  const caught = Object.keys(within?.nodes ?? {}).filter(other => within?.nodes[other].caught === id);
  if (!within || caught.length === 0) return {};
  const routed = catchOrder(within.graph, id, scope).find(one => caught.includes(one)) ?? caught[0];
  return { 'wilanis.caught': routed };
}

/** The nodes a switch catches, in the order its document names them; none where the tree does not hold it. */
function catchOrder(graph: string, id: string, scope: Scope): string[] {
  const node = scope.get('graph', graph)?.doc.nodes.find(one => one.id === id);
  return node && isSwitch(node) ? Object.keys(node.catch ?? {}) : [];
}

/** Whether the operation a node ran is an effect: not `pure`, as the port that declares it says. */
function isEffect(handler: string | undefined, scope: Scope): boolean {
  if (!handler || handler.startsWith('graph:')) return false;
  const hit = scope.op(handler);
  return typeof hit === 'string' ? false : hit.op.pure !== true;
}

/** Where a node is, as a refusal would address it: its id, and `nodes/<id>` inside its graph. */
export const addressOf = (id: string): TraceAttributes => ({ 'wilanis.node': id, 'wilanis.at': `nodes/${id}` });

/** Where a binding operation is, as a refusal would address it: `operations/<name>` inside the binding. */
export const operationAddressOf = (name: string): TraceAttributes => ({ 'wilanis.at': `operations/${name}` });

/** What a node span says about itself whatever kind of node it is: where it is, and what it carried. */
export function nodeAttributes(id: string, node: NodeReport, walk: Walk): TraceAttributes {
  return {
    ...addressOf(id),
    ...(node.handler && !node.handler.startsWith('graph:')
      ? { 'wilanis.effect': isEffect(node.handler, walk.scope) }
      : {}),
    ...looked(node),
    ...valued(node, walk.level),
  };
}
