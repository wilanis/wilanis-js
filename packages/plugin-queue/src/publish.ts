/**
 * queue.port.json: what a data graph asks of a broker. Both operations find the broker the connection's kind
 * registered and hand it what the call gave; neither knows how the broker keeps a queue. The body is the
 * `message` value as the graph made it -- the checker has held it to the type `type` names -- and the broker
 * encodes it.
 */
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

/** Put one message on a queue and answer the broker's id for it. */
export const publish: Handler = async ({ in: input, ctx }) => {
  const { connection, broker } = brokerFor(ctx.env, input.connection, PUBLISH);
  const message: Message = { body: input.message, headers: headersOf(input.headers) };
  if (typeof input.delayMs === 'number') message.delayMs = input.delayMs;
  const { id } = await broker.publish(connection, String(input.queue), message);
  return { id };
};

/** Prepare what the broker needs on the connection, and answer that it is ready. */
export const ensure: Handler = async ({ in: input, ctx }) => {
  const { connection, broker } = brokerFor(ctx.env, input.connection, ENSURE);
  await broker.ensure(connection);
  return { ready: true };
};
