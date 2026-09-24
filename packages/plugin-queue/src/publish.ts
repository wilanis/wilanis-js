/**
 * queue.port.json: what a data graph asks of a broker. Both operations find the broker the connection's kind
 * registered and hand it what the call gave; neither knows how the broker keeps a queue. The body is the
 * `message` value as the graph made it -- the checker has held it to the type `type` names -- and the broker
 * encodes it.
 *
 * Inside an atomic graph, `publish` takes part in the transaction as `@storage`'s operations do: it hands the
 * broker the run's `env.atomic`, and a broker whose queue is kept in the store enqueues on the transaction's
 * session, so a rollback leaves nothing published. Which brokers can is their connection kind's fact --
 * `storage`, the marker a store's connection carries -- read here as X405 reads it in the checker.
 */
import type { Atomic, ConnectionKindDoc, Resolves } from '@wilanis/core';
import type { Handler } from '@wilanis/engine';
import { brokerFor, type Message } from './brokers.js';
import { ENSURE, PUBLISH } from './paths.js';

/** The headers a call gave, each a string, since that is all a header is on any broker. */
function headersOf(given: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!given || typeof given !== 'object') return headers;
  for (const [name, value] of Object.entries(given as Record<string, unknown>))
    if (value !== undefined && value !== null) headers[name] = String(value);
  return headers;
}

/** Whether a connection kind keeps what it holds in a store, and so can take part in the store's transaction. */
function inStore(env: Record<string, unknown>, kind: string): boolean {
  const doc = (env.resolving as Resolves | undefined)?.document(kind) as ConnectionKindDoc | undefined;
  return doc?.storage === true;
}

/**
 * The transaction a publish joins: the atomic graph's, where it runs in one. X405 refuses an atomic graph that
 * publishes itself to a broker outside the store; one that reaches such a publish through a domain call is
 * refused here, before anything is kept, since a message kept outside the transaction would survive its
 * rollback.
 */
function transactionOf(env: Record<string, unknown>, connection: string, kind: string): Atomic | undefined {
  const atomic = env.atomic as Atomic | undefined;
  if (!atomic || inStore(env, kind)) return atomic;
  throw new Error(`'${connection}' cannot take part in a transaction: publish after the atomic graph`);
}

/** Put one message on a queue and answer the broker's id for it, inside the atomic graph's transaction where there is one. */
export const publish: Handler = async ({ in: input, ctx }) => {
  const { connection, kind, broker } = brokerFor(ctx.env, input.connection, PUBLISH);
  const atomic = transactionOf(ctx.env, connection, kind);
  const message: Message = { body: input.message, headers: headersOf(input.headers) };
  if (typeof input.delayMs === 'number') message.delayMs = input.delayMs;
  const { id } = await broker.publish(connection, String(input.queue), message, atomic);
  return { id };
};

/** Prepare what the broker needs on the connection, and answer that it is ready. */
export const ensure: Handler = async ({ in: input, ctx }) => {
  const { connection, broker } = brokerFor(ctx.env, input.connection, ENSURE);
  await broker.ensure(connection);
  return { ready: true };
};
