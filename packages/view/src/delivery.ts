/**
 * What a connection page and a trigger page show of a queue (RFC 0009): what the connection's kind delivers, the
 * triggers receiving from it, the calls sending to it and where on it, and which trigger receives what each call
 * sends. The walks live in the runtime, so `wilanis describe` and these pages cannot pair a call with a different
 * trigger; nothing here knows a queue, only a kind's `connection` and a connection kind's `delivery`.
 */
import type { Loaded, Scope, TriggerDoc } from '@wilanis/core';
import {
  addressSaid,
  connectionSetting,
  DELIVERY_MEANS,
  type Delivery,
  deliveryOf,
  receiversOf,
  receivesFrom,
  type Send,
  sendersOf,
  sendsOf,
  settingsSaid,
} from '@wilanis/runtime';
import { labelOf } from './types.js';

/** A document a page links: where it is, and what it is called. */
export interface VLinked {
  path: string;
  label: string;
}

/** One call that sends to a connection delivering messages: where it is written, where on the connection, and who receives it. */
export interface VSend {
  /** The graph or binding the call is written in. */
  file: string;
  label: string;
  /** The node of the graph, or the operation of the binding. */
  where: string;
  /** Whether `where` is a node of a graph, which the page opens at that node, or an operation of a binding. */
  node: boolean;
  /** Where on the connection it sends, as `wilanis map` says it: `queue "removals"`. */
  address: string;
  /** The triggers of this tree receiving what it sends; empty where another tree may. */
  receivers: VLinked[];
}

/** On a connection whose kind declares `delivery`: what that means, who receives from it and who sends to it. */
export interface VDelivery {
  delivery: Delivery;
  /** What the delivery means to what a receiving trigger fires. */
  means: string;
  /** The triggers receiving from it, each with its settings as `wilanis map` says them, less the connection. */
  receivers: (VLinked & { said: string })[];
  /** The calls sending to it. */
  senders: VSend[];
}

/** On a trigger whose kind receives from a connection: which, what it delivers, and the calls whose messages it receives. */
export interface VReceives {
  connection: string;
  label: string;
  /** Absent where the connection's kind declares none, which the checker refuses. */
  delivery?: Delivery;
  senders: VSend[];
}

/** A document of the tree as a page links it. */
const linked = (scope: Scope, path: string): VLinked => ({ path, label: labelOf(scope.registry.any(path)) });

/** One call as a page shows it, with the triggers receiving what it sends. */
function sendView(scope: Scope, send: Send): VSend {
  return {
    file: send.file,
    label: labelOf(scope.registry.any(send.file)),
    where: send.where,
    node: scope.registry.get('graph', send.file) !== undefined,
    address: addressSaid(send),
    receivers: receiversOf(send, scope).map(trigger => linked(scope, trigger.path)),
  };
}

/** What a connection page adds for a broker; nothing for a connection whose kind delivers nothing. */
export function deliveryView(scope: Scope, doc: Loaded): VDelivery | undefined {
  const delivery = deliveryOf(doc.path, scope);
  if (!delivery) return undefined;
  const receivers = scope.registry
    .all('trigger')
    .filter(trigger => receivesFrom(trigger.doc, scope) === doc.path)
    .map(trigger => ({
      ...linked(scope, trigger.path),
      said: settingsSaid(trigger, scope, [connectionSetting(trigger.doc, scope) ?? '']),
    }));
  const senders = sendsOf(scope)
    .filter(send => send.connection === doc.path)
    .map(send => sendView(scope, send));
  return { delivery, means: DELIVERY_MEANS[delivery], receivers, senders };
}

/** What a trigger page adds for a trigger that receives from a connection; nothing for one whose kind receives from none. */
export function receivesView(scope: Scope, doc: Loaded<TriggerDoc>): VReceives | undefined {
  const connection = receivesFrom(doc.doc, scope);
  if (!connection) return undefined;
  const delivery = deliveryOf(connection, scope);
  const senders = sendersOf(doc.doc, scope).map(send => sendView(scope, send));
  const label = labelOf(scope.registry.any(connection));
  return { connection, label, ...(delivery ? { delivery } : {}), senders };
}
