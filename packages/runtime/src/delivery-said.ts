/**
 * What `wilanis describe` and `wilanis map` say about a connection that delivers messages (RFC 0009): what its
 * kind's `delivery` means, the triggers receiving from it, the calls sending to it and where on it, and which
 * trigger receives what each call sends. None of it is in any one document -- the delivery is a hop into the
 * kind, a trigger's connection a hop through its kind's `connection`, and a call is in a graph elsewhere in the
 * tree -- so a reader holding one end of a queue is told where the other end is.
 */
import type { ConnectionKindDoc, Loaded, Scope, TriggerDoc } from '@wilanis/core';
import {
  addressSaid,
  connectionSetting,
  DELIVERY_MEANS,
  deliveryOf,
  receiversOf,
  receivesFrom,
  type Send,
  type Site,
  sendersOf,
  sendOf,
  sendsOf,
} from './delivery.js';
import { settingsSaid } from './trigger-said.js';

/** One call, as the store's call sites are said: the document and, after `#`, the node or the binding's operation. */
const sendSaid = (send: Send): string => `${send.file}#${send.where}`;

/** Where one call's messages go: the triggers of the tree receiving them, or that none does. */
function receivedSaid(send: Send, scope: Scope): string {
  const receivers = receiversOf(send, scope).map(trigger => trigger.path);
  return receivers.length ? receivers.join(', ') : 'no trigger of this tree -- another tree may receive it';
}

/** A connection kind's `delivery`, with what it means; nothing for a kind that delivers nothing. */
export function deliveryKindLines(doc: Loaded): string[] {
  const { delivery } = doc.doc as ConnectionKindDoc;
  return delivery ? [`delivery: ${delivery} -- ${DELIVERY_MEANS[delivery]}`] : [];
}

/** The triggers receiving from one connection, each with the settings `map` says beside it, less the connection. */
function receivedByLines(connection: string, scope: Scope): string[] {
  const receivers = scope.registry.all('trigger').filter(trigger => receivesFrom(trigger.doc, scope) === connection);
  if (!receivers.length) return ['received by  no trigger of this tree'];
  return [
    'received by:',
    ...receivers.map(trigger => {
      const said = settingsSaid(trigger, scope, [connectionSetting(trigger.doc, scope) ?? '']);
      return `    ${trigger.path}${said ? `  ${said}` : ''}`;
    }),
  ];
}

/** The calls sending to one connection, each with where on it and the trigger that receives what it sends. */
function sentToByLines(connection: string, scope: Scope): string[] {
  const sends = sendsOf(scope).filter(send => send.connection === connection);
  if (!sends.length) return ['sent to by  nothing in this tree'];
  return [
    'sent to by (where on it → who receives it):',
    ...sends.map(send => `    ${sendSaid(send)}  ${addressSaid(send)} → ${receivedSaid(send, scope)}`),
  ];
}

/** What a connection delivers, said under its kind, since the kind is where it is declared; nothing where it delivers nothing. */
export function deliveryLines(doc: Loaded, scope: Scope): string[] {
  const delivery = deliveryOf(doc.path, scope);
  return delivery ? [`delivery  ${delivery} -- ${DELIVERY_MEANS[delivery]}`] : [];
}

/**
 * The triggers receiving from a connection that delivers messages and the calls sending to it, paired; nothing
 * for a connection that delivers nothing, whose readers have no queue to find.
 */
export function pairedLines(doc: Loaded, scope: Scope): string[] {
  if (!deliveryOf(doc.path, scope)) return [];
  return [...receivedByLines(doc.path, scope), ...sentToByLines(doc.path, scope)];
}

/**
 * A trigger whose kind receives from a connection: which, what it delivers, and the calls of the tree whose
 * messages it receives -- the other end of the queue, which the trigger document cannot name.
 */
export function receivingLines(trigger: Loaded<TriggerDoc>, scope: Scope): string[] {
  const connection = receivesFrom(trigger.doc, scope);
  if (!connection) return [];
  const delivery = deliveryOf(connection, scope);
  const says = delivery ? `, which delivers ${delivery}` : ', whose kind declares no delivery';
  const senders = sendersOf(trigger.doc, scope).map(sendSaid);
  return [
    `receives from  ${connection}${says}`,
    senders.length ? `sent by  ${senders.join(', ')}` : 'sent by  nothing in this tree -- another tree may send it',
  ];
}

/** The calls whose messages one trigger receives, a line each under the trigger in `wilanis map`; none, nothing. */
export function sentByLines(trigger: Loaded<TriggerDoc>, scope: Scope): string[] {
  return sendersOf(trigger.doc, scope).map(send => `  sent by ${sendSaid(send)}`);
}

/**
 * Where one node's call lands, when it sends to a connection delivering messages: the connection, where on it,
 * and the trigger that receives it, so `wilanis map` ends a publish at the queue and its consumer.
 */
export function sendTail(site: Site, scope: Scope): string {
  const send = sendOf(site, scope);
  return send ? ` → ${send.connection} ${addressSaid(send)} → ${receivedSaid(send, scope)}` : '';
}
