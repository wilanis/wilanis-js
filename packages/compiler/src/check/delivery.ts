/**
 * What a trigger receives from (RFC 0009). A kind that declares `connection` names the setting its triggers write
 * a connection in; that connection's kind says how many times it may hand one message (`delivery`), and where it
 * may hand one twice, the operation the trigger fires must promise it is safe to run twice (T009). T010 refuses
 * a setting that names no such connection. Whether the promise holds under each profile that runs the operation
 * is B011's, not this.
 */
import type { ConnectionKindDoc, Loaded, Operation, TriggerDoc } from '@wilanis/core';
import { readPath } from '@wilanis/engine';
import type { Judge, Refuser } from './judge.js';

/** A trigger whose kind receives from a connection: the setting that names it, and the operation it fires. */
export interface Receiving {
  trigger: Loaded<TriggerDoc>;
  setting: string;
  op: Operation;
}

const RECEIVE = 'receive from a connection whose kind declares delivery';

/** T009, T010: the connection a trigger receives from delivers, and what it fires may run as often as it delivers. */
export function checkDelivery(judge: Judge, receiving: Receiving): void {
  const { trigger, op } = receiving;
  const refuse = judge.refuser(trigger.path);
  const from = receivedFrom(judge, receiving, refuse);
  if (from?.delivery !== 'at-least-once' || op.pure === true || op.idempotent === true) return;
  const run = trigger.doc.fire.run;
  refuse(
    'T009',
    `'${from.path}' delivers a message at least once, so '${run}' may run twice for one message, and the operation does not promise idempotent`,
    'fire/run',
    `declare "idempotent": true on ${run} (the checker then holds each profile that runs it to the promise, B011), or receive from a connection whose kind delivers at most once`,
  );
}

/**
 * T010: the connection the kind's setting names, and what its kind delivers -- or nothing, refused, where the
 * setting is a read, names no connection document, or names one whose kind declares no `delivery`. A setting
 * that is absent or not a string is T001's, and a connection whose kind is unknown is that connection's R001.
 */
function receivedFrom(
  judge: Judge,
  { trigger, setting }: Receiving,
  refuse: Refuser,
): { path: string; delivery: NonNullable<ConnectionKindDoc['delivery']> } | undefined {
  const path = readPath(trigger.doc.settings, setting.split('.'));
  if (typeof path !== 'string') return undefined;
  const at = `settings/${setting.replace(/\./g, '/')}`;
  if (!judge.scope.literal(path)) {
    const message = `settings.${setting} reads ${path}, but the connection a trigger receives from is written as its path`;
    refuse('T010', message, at, `write the path of a connection whose kind declares delivery; wilanis ls connection`);
    return undefined;
  }
  const connection = judge.scope.get('connection', path);
  if (!connection) {
    refuse('T010', `settings.${setting} names no connection: '${path}'`, at, `${RECEIVE}; wilanis ls connection`);
    return undefined;
  }
  const kind = judge.scope.get('connection-kind', connection.doc.kind);
  if (!kind) return undefined;
  const delivery = kind.doc.delivery;
  if (delivery) return { path, delivery };
  const message = `'${path}' is a connection of kind '${connection.doc.kind}', which declares no delivery: it hands a trigger no messages`;
  refuse('T010', message, at, `${RECEIVE}; wilanis ls connection-kind`);
  return undefined;
}
