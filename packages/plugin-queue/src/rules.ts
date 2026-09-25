/**
 * What only @queue can judge: X401 to X406, its own band. Each rule reads a word the generic families cannot --
 * an outcome is a string to the type system and an instruction to a broker here, and the queue a `publish`
 * names is a string to G005 and the other end of a queue trigger here.
 *
 * A rule here never judges what a queue trigger shares with a route: T001 already holds the settings to the
 * kind's contract (so `onFault` is one of its two words and `message` an edge shape), T005 and T006 hold
 * `outcomes` to the reasons the run can reach, and whether the connection delivers at all, and whether what it
 * fires may run twice, are the T rules' -- they relate compiler words and know nothing of queues.
 *
 * X401 a setting a worker cannot act on: an outcome that is not ack, retry or dead; attempts, a backoff or a
 *      concurrency that is not a whole number in range.
 * X402 a retry on a connection whose kind delivers at most once: nothing will deliver the message again.
 * X403 a publish of a type the trigger consuming that queue does not accept (`publishes.ts`).
 * X404 a message type carrying a blob, whose handle means nothing in another process (`publishes.ts`).
 * X405 a publish in an atomic graph to a broker whose kind is not marked storage, which cannot join the
 *      transaction. It sees the graph that carries the node; an atomic graph that reaches such a publish
 *      through a domain call is refused at run time by the handler, before the broker keeps anything.
 * X406 a second queue trigger receiving from the connection and queue another already receives from: a message
 *      fires one trigger, so the second would never run.
 */
import type { ConnectionKindDoc, PluginCheckContext } from '@wilanis/core';
import { placeOf } from './deliver.js';
import { OUTCOMES } from './outcome.js';
import { checkPublished, checkTriggerMessage } from './publishes.js';
import { consumeSteps, published, type Queued, queued } from './sites.js';

type Scope = PluginCheckContext['scope'];
type Refuse = PluginCheckContext['refuse'];

/** Whether a value is a whole number of at least `low`. */
const whole = (value: unknown, low: number) => Number.isInteger(value) && (value as number) >= low;

/** X401: every value of outcomes is one of the three words a broker acts on. */
function checkOutcomes(one: Queued, refuse: Refuse): void {
  const table = one.settings.outcomes;
  if (!table || typeof table !== 'object') return; // T001 has held it to an object of strings
  for (const [reason, word] of Object.entries(table as Record<string, unknown>)) {
    if (OUTCOMES.some(known => known === word)) continue;
    refuse({
      code: 'X401',
      file: one.file,
      message: `outcomes maps '${reason}' to ${JSON.stringify(word)}, and a broker acts on ack, retry or dead only`,
      at: `settings/outcomes/${reason}`,
      hint: 'an outcome is ack, retry or dead',
    });
  }
}

/** X401: the counts a worker computes a retry from are whole numbers it can count with. */
function checkCounts(one: Queued, refuse: Refuse): void {
  const { maxAttempts, backoffMs } = one.settings;
  if (maxAttempts !== undefined && !whole(maxAttempts, 1))
    refuse({
      code: 'X401',
      file: one.file,
      message: `maxAttempts is ${JSON.stringify(maxAttempts)}; it counts deliveries, the first among them, so it is a whole number of 1 or more`,
      at: 'settings/maxAttempts',
      hint: 'maxAttempts is a whole number, 1 or more',
    });
  if (backoffMs !== undefined && !whole(backoffMs, 0))
    refuse({
      code: 'X401',
      file: one.file,
      message: `backoffMs is ${JSON.stringify(backoffMs)}; it is the wait before a second delivery, so it is a whole number of milliseconds, 0 or more`,
      at: 'settings/backoffMs',
      hint: 'backoffMs is a whole number of milliseconds, 0 or more; drop it for the default of 1000',
    });
}

/** X401: a consume step's concurrency is a number of messages, one or more. */
function checkConcurrency(scope: Scope, refuse: Refuse): void {
  for (const { step, index } of consumeSteps(scope)) {
    const concurrency = step.in?.concurrency;
    if (concurrency === undefined || whole(concurrency, 1)) continue;
    refuse({
      code: 'X401',
      file: '@project.json',
      message: `the consume step's concurrency is ${JSON.stringify(concurrency)}; it is how many messages of one queue run at once, so it is a whole number of 1 or more`,
      at: `startup/${index}/in/concurrency`,
      hint: 'concurrency is a whole number, 1 or more; drop it for one at a time',
    });
  }
}

/** One connection a document names, as it stands under the tree or one profile: its path, its kind, and the kind's document. */
interface Behind {
  profile: string | undefined;
  connection: string;
  kind: string;
  doc: ConnectionKindDoc | undefined;
}

/**
 * What a named connection is under the tree and under every profile: a profile may put a stand-in of another
 * kind behind it, and a rule about what the kind can do is broken under any profile whose kind cannot. A name
 * that is no connection answers nothing; the rules that judge the name say so.
 */
function behind(scope: Scope, named: string): Behind[] {
  const found: Behind[] = [];
  for (const profile of [undefined, ...scope.profiles()]) {
    const connection = scope.connectionFor(named, profile);
    if (typeof connection === 'string') continue;
    const kind = scope.get('connection-kind', connection.doc.kind);
    const doc = kind?.doc as ConnectionKindDoc | undefined;
    found.push({ profile, connection: connection.path, kind: kind?.path ?? connection.doc.kind, doc });
  }
  return found;
}

/** The connection a queue trigger receives from, under the tree or any profile, that delivers at most once, since a retry is a lie there. */
const atMostOnce = (scope: Scope, named: string) =>
  behind(scope, named).find(one => one.doc?.delivery === 'at-most-once');

/** Where a queue trigger asks for a retry: each outcome that says so, and onFault, which says so unless told otherwise. */
function retriesOf(one: Queued): string[] {
  const table = (one.settings.outcomes ?? {}) as Record<string, unknown>;
  const at = Object.entries(table)
    .filter(([, word]) => word === 'retry')
    .map(([reason]) => `settings/outcomes/${reason}`);
  if (one.settings.onFault === undefined || one.settings.onFault === 'retry') at.push('settings/onFault');
  return at;
}

/** X402: a retry asked of a broker that delivers each message once and never again. */
function checkRetryDelivers(scope: Scope, one: Queued, refuse: Refuse): void {
  const named = one.settings.connection;
  if (typeof named !== 'string') return;
  const once = atMostOnce(scope, named);
  if (!once) return;
  for (const at of retriesOf(one))
    refuse({
      code: 'X402',
      file: one.file,
      message: `'${once.connection}' is of kind '${once.kind}', which delivers at most once, so a message asked to be retried is never delivered again${at.endsWith('onFault') ? ' (onFault is retry unless it says dead)' : ''}`,
      at,
      hint: 'a broker that delivers at most once cannot retry; map the reason to ack or dead, and set onFault',
    });
}

/**
 * X405: a publish written in an atomic graph, to a broker whose kind -- under the tree or any profile -- is not
 * marked `storage`. Such a broker keeps its queue outside the store, so it cannot join the transaction, and a
 * message it kept would survive the rollback of the writes it announces.
 */
function checkAtomicPublish(scope: Scope, refuse: Refuse): void {
  for (const call of published(scope)) {
    const named = call.given.connection;
    if (!call.atomic || typeof named !== 'string') continue; // G005 holds a publish's connection to a literal
    const outside = behind(scope, named).find(one => one.doc?.storage !== true);
    if (!outside) continue;
    const under = outside.profile ? ` under profile '${outside.profile}'` : '';
    refuse({
      code: 'X405',
      file: call.file,
      message: `an atomic graph publishes to '${outside.connection}', of kind '${outside.kind}'${under}, which is not marked storage: a broker outside the store cannot join the graph's transaction, so the message would outlive a rollback`,
      at: `${call.at}/connection`,
      hint: 'publish after the atomic graph, in its caller, reached by a data dependency on its answer',
    });
  }
}

/**
 * X406: one queue trigger to a connection and queue. A delivery fires one trigger, the first the tree lists, so
 * each later one receiving from the same place is refused on its own file, in the order the tree lists them.
 * The place is `placeOf`'s, the worker's own: the connection canonical, so two spellings of one are one.
 */
function checkOneReceiver(scope: Scope, triggers: Queued[], refuse: Refuse): void {
  const first = new Map<string, Queued>();
  for (const one of triggers) {
    const place = placeOf(one.doc, scope.canon);
    if (!place) continue; // T001 holds connection and queue to strings
    const key = `${place.connection}\n${place.queue}`;
    const earlier = first.get(key);
    if (!earlier) {
      first.set(key, one);
      continue;
    }
    refuse({
      code: 'X406',
      file: one.file,
      message: `receives from queue '${place.queue}' of '${place.connection}', as ${earlier.file} already does: a message on it fires ${earlier.file}, so this trigger never runs`,
      at: 'settings/queue',
      hint: `one trigger per queue: remove ${one.file}, or change its settings.queue to a queue no other trigger receives from`,
    });
  }
}

/** What only @queue can judge: X401 a setting a worker cannot act on, X402 a retry nothing redelivers, X403 a publish its consumer does not accept, X404 a blob in a message, X405 a publish an atomic graph's transaction cannot take in, X406 two triggers on one queue. */
export function check({ scope, refuse }: PluginCheckContext): void {
  checkConcurrency(scope, refuse);
  const triggers = queued(scope);
  for (const one of triggers) {
    checkOutcomes(one, refuse);
    checkCounts(one, refuse);
    checkRetryDelivers(scope, one, refuse);
    checkTriggerMessage(scope, one, refuse);
  }
  checkOneReceiver(scope, triggers, refuse);
  checkPublished(scope, triggers, refuse);
  checkAtomicPublish(scope, refuse);
}
