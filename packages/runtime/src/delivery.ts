/**
 * Which triggers receive from a connection that delivers messages, which calls send to one, and which of those
 * meet (RFC 0009). Nothing here knows a queue. A trigger receives from the connection its kind's `connection`
 * names among its settings; a call sends to one when the static `connection` it is given names a connection
 * whose kind declares `delivery`, and the other static strings it is given -- `queue "removals"` -- say where on
 * that connection it sends. A trigger receives what a call sends when both name the same connection and the
 * trigger's settings of those names say the same: the pairing X403 judges, read off the documents, so a broker
 * published later is paired the day it ships.
 */
import type { ConnectionKindDoc, Loaded, Scope, TriggerDoc, Values } from '@wilanis/core';

/** How many times a connection may hand one message to a trigger receiving from it. */
export type Delivery = NonNullable<ConnectionKindDoc['delivery']>;

/** What each `delivery` means to what a trigger receiving from the connection fires, in the schema's words. */
export const DELIVERY_MEANS: Record<Delivery, string> = {
  'at-least-once': 'a message not acknowledged is delivered again, so what it fires may run twice',
  'at-most-once': 'a message is handed once and never again, so what it fires may not run at all',
};

/** What a connection delivers: its kind's `delivery`, or nothing where the kind declares none or is not there. */
export function deliveryOf(connection: string, scope: Scope): Delivery | undefined {
  const doc = scope.get('connection', connection);
  return doc ? scope.get('connection-kind', doc.doc.kind)?.doc.delivery : undefined;
}

/** The dotted path, among a trigger's settings, of the connection its kind receives from; nothing for a kind that receives from none. */
export function connectionSetting(trigger: TriggerDoc, scope: Scope): string | undefined {
  return scope.get('trigger-kind', trigger.kind)?.doc.connection;
}

/** The value at a dotted path of a settings object, or nothing where a step is missing. */
function valueAt(settings: Record<string, unknown> | undefined, path: string): unknown {
  let held: unknown = settings;
  for (const step of path.split('.')) held = held && typeof held === 'object' ? (held as Values)[step] : undefined;
  return held;
}

/**
 * The connection one trigger receives from, canonical, where its kind declares where the trigger names one and
 * the trigger names it as a literal the tree has; nothing otherwise -- T001 and R001 say why where it is judged.
 */
export function receivesFrom(trigger: TriggerDoc, scope: Scope): string | undefined {
  const at = connectionSetting(trigger, scope);
  const named = at ? valueAt(trigger.settings, at) : undefined;
  return typeof named === 'string' && scope.get('connection', named) ? scope.canon(named) : undefined;
}

/** One call that sends to a connection delivering messages: where it is written, the connection, and where on it. */
export interface Send {
  /** The graph or binding the call is written in. */
  file: string;
  /** The node of the graph, or the operation of the binding. */
  where: string;
  /** The connection it sends to, canonical. */
  connection: string;
  /** The other static strings it is given, by name: where on the connection it sends (`queue: "removals"`). */
  address: Record<string, string>;
}

/** Where one call is written, what it runs and what it is given. */
export interface Site {
  file: string;
  where: string;
  run: string;
  given: Values | undefined;
}

/** One call, when it sends to a connection delivering messages at an address its static strings give. */
export function sendOf(site: Site, scope: Scope): Send | undefined {
  const found = scope.op(site.run);
  if (typeof found === 'string') return undefined;
  const accepted = scope.types.accepted(found.op.accepts);
  const connection = site.given?.connection;
  if (!accepted.connection?.static || typeof connection !== 'string' || !deliveryOf(connection, scope))
    return undefined;
  const address: Record<string, string> = {};
  for (const [name, value] of Object.entries(site.given ?? {}))
    if (name !== 'connection' && accepted[name]?.static && typeof value === 'string') address[name] = value;
  // a call naming the connection and nothing on it prepares the broker rather than sending anything through it
  if (!Object.keys(address).length) return undefined;
  return { file: site.file, where: site.where, connection: scope.canon(connection), address };
}

/** Every graph node of the tree that runs an operation, itself or once per element. */
const nodeSites = (scope: Scope): Site[] =>
  scope.registry
    .all('graph')
    .flatMap(graph =>
      graph.doc.nodes.flatMap(node =>
        'run' in node ? [{ file: graph.path, where: node.id, run: node.run, given: node.in }] : [],
      ),
    );

/** Every binding operation of the tree that delegates to another operation. */
const delegationSites = (scope: Scope): Site[] =>
  scope.registry
    .all('binding')
    .flatMap(binding =>
      Object.entries(binding.doc.operations).flatMap(([name, op]) =>
        op.run ? [{ file: binding.path, where: name, run: op.run, given: op.in }] : [],
      ),
    );

/** Every site of the tree that runs an operation: each graph node that runs one, then each binding's delegation. */
const sitesOf = (scope: Scope): Site[] => [...nodeSites(scope), ...delegationSites(scope)];

/** Every call of the tree that sends to a connection delivering messages, in document order: graphs, then bindings. */
export function sendsOf(scope: Scope): Send[] {
  return sitesOf(scope).flatMap(site => sendOf(site, scope) ?? []);
}

/** Whether one trigger receives what one call sends: the same connection, and its settings saying the same where the call says where. */
export function receives(trigger: TriggerDoc, send: Send, scope: Scope): boolean {
  if (receivesFrom(trigger, scope) !== send.connection) return false;
  return Object.entries(send.address).every(([name, value]) => trigger.settings?.[name] === value);
}

/** The triggers of the tree that receive what one call sends. */
export function receiversOf(send: Send, scope: Scope): Loaded<TriggerDoc>[] {
  return scope.registry.all('trigger').filter(trigger => receives(trigger.doc, send, scope));
}

/** The calls of the tree whose messages one trigger receives. */
export function sendersOf(trigger: TriggerDoc, scope: Scope): Send[] {
  return sendsOf(scope).filter(send => receives(trigger, send, scope));
}

/** Where a call sends, said as `wilanis map` says a trigger's settings: `queue "removals"`. */
export const addressSaid = (send: Send): string =>
  Object.entries(send.address)
    .map(([name, value]) => `${name} ${JSON.stringify(value)}`)
    .join(', ');
