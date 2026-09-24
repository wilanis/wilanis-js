/**
 * What @queue judges about a message's type: X403, that what a graph publishes on a queue is what the trigger
 * consuming that queue accepts, and X404, that no message carries a blob. They live apart from `rules.ts`
 * because each is a judgement over a type a document names rather than over a trigger's settings.
 *
 * X403 says nothing where no trigger of this tree consumes the queue: another tree may, and a rule here would
 * forbid publishing to anything but oneself. Only a literal connection and queue can be paired; G005 has
 * already held both to static values, so a template there is refused before this runs.
 */
import { assignable, type PluginCheckContext, type Type } from '@wilanis/core';
import { type Published, published, type Queued, typeOf } from './sites.js';

type Scope = PluginCheckContext['scope'];
type Refuse = PluginCheckContext['refuse'];

const HINT_BLOB =
  "bytes live in the blob registry and a handle is process-local; publish the handle's id as a string and read the bytes where the message is consumed";

/** A path from a step and what lies below it: `rows` and `[].file` are `rows[].file`, `file` and `` are `file`. */
function joined(head: string, tail: string): string {
  if (!tail) return head;
  return tail.startsWith('[]') ? `${head}${tail}` : `${head}.${tail}`;
}

/** Where one step below a type carries a blob, joined onto the step, or nothing where it carries none. */
function below(head: string, type: Type, seen: Set<Type>): string | undefined {
  const inner = blobAt(type, seen);
  return inner === undefined ? undefined : joined(head, inner);
}

/** Where a type carries a blob, as a dotted path from its root (`file`, `rows[].file`, `` for the whole), or nothing where it carries none. */
export function blobAt(type: Type, seen: Set<Type> = new Set()): string | undefined {
  if (type.kind === 'blob') return '';
  if (seen.has(type)) return undefined; // a shape that names itself has been walked once already
  seen.add(type);
  if (type.kind === 'list') return below('[]', type.of, seen);
  if (type.kind !== 'object') return undefined;
  for (const [name, field] of Object.entries(type.fields)) {
    const found = below(name, field.type, seen);
    if (found !== undefined) return found;
  }
  return type.open ? below('*', type.open, seen) : undefined;
}

/** Where a message type is named: the document, the place in it, and the reference as written. */
interface Naming {
  file: string;
  at: string;
  ref: string;
}

/** X404: a message type that carries a blob anywhere in it. */
function checkBlob(naming: Naming, type: Type, refuse: Refuse): void {
  const where = blobAt(type);
  if (where === undefined) return;
  refuse({
    code: 'X404',
    file: naming.file,
    message: `'${naming.ref}' carries a blob${where ? ` at ${where}` : ''}, and a message leaves the process whose blob registry holds its bytes`,
    at: naming.at,
    hint: HINT_BLOB,
  });
}

/** X404: the message type a queue trigger consumes. */
export function checkTriggerMessage(scope: Scope, one: Queued, refuse: Refuse): void {
  const ref = one.settings.message;
  const type = typeOf(scope, ref);
  if (type) checkBlob({ file: one.file, at: 'settings/message', ref: String(ref) }, type, refuse);
}

/** The queue triggers of this tree that consume what one publish puts on a queue: the same connection and queue. */
function consumersOf(scope: Scope, call: Published, triggers: Queued[]): Queued[] {
  const { connection, queue } = call.given;
  if (typeof connection !== 'string' || typeof queue !== 'string') return [];
  const at = scope.canon(connection);
  return triggers.filter(
    one =>
      typeof one.settings.connection === 'string' &&
      scope.canon(one.settings.connection) === at &&
      one.settings.queue === queue,
  );
}

/** What the pairing of publishes with their consumers is judged against: the tree, its queue triggers, and the way to refuse. */
interface Pairing {
  scope: Scope;
  triggers: Queued[];
  refuse: Refuse;
}

/** X403: what one publish puts on a queue is what every trigger of this tree consuming it accepts. */
function checkPaired({ scope, triggers, refuse }: Pairing, call: Published, sent: Type): void {
  for (const consumer of consumersOf(scope, call, triggers)) {
    const accepted = typeOf(scope, consumer.settings.message);
    if (!accepted) continue; // T001 or R001, where the trigger is judged
    const why = assignable(sent, accepted);
    if (!why) continue;
    const consumes = String(consumer.settings.message);
    refuse({
      code: 'X403',
      file: call.file,
      message: `publishes '${String(call.given.type)}' on queue '${String(call.given.queue)}' of '${String(call.given.connection)}', which ${consumer.file} consumes as '${consumes}': ${why}`,
      at: `${call.at}/type`,
      hint: `publish the shape the trigger consumes: ${consumes}, or name another queue`,
    });
  }
}

/** X403, X404: every publish of the tree, against the triggers that consume what it publishes and against blobs. */
export function checkPublished(scope: Scope, triggers: Queued[], refuse: Refuse): void {
  for (const call of published(scope)) {
    const sent = typeOf(scope, call.given.type);
    if (!sent) continue; // G005 or R001, where the call is judged
    checkBlob({ file: call.file, at: `${call.at}/type`, ref: String(call.given.type) }, sent, refuse);
    checkPaired({ scope, triggers, refuse }, call, sent);
  }
}
