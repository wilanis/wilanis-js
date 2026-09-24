/**
 * worker.port.json#consume: what works this tree's queues. A project's startup list names it, as it names the
 * listener, the watcher and the scheduler; nothing consumes a queue on its own, so a tree that names no step
 * works none.
 *
 * The queues are the queue triggers themselves, grouped by the canonical connection and the queue each receives
 * from, and each is consumed once however many triggers name it -- as one socket answers every route. Every
 * broker is found before anything is consumed, so a tree naming a kind no broker registered stops the start
 * with nothing half-held. The trigger a message fires is found afresh on every delivery (`deliver.ts`), so a
 * reload is seen by the next message; which queues are consumed is fixed when the step runs, so a queue a
 * reload adds is consumed from the next start.
 */
import type { Hold, Serving, TriggerDoc } from '@wilanis/core';
import type { Handler } from '@wilanis/engine';
import { brokerFor, type Delivery, type Reached } from './brokers.js';
import { type Consumed, deliver, triggerFor, type Worked } from './deliver.js';
import { CONSUME, KIND } from './paths.js';

/** What a tree hands a held operation, and what this one reads of it. */
type WorkerEnv = Record<string, unknown> & {
  serving?: Serving;
  hold?: Hold;
  canon?: (ref: string) => string;
};

/** How many messages of one queue run at once: what the step says, a whole number of 1 or more, else 1. */
function concurrencyOf(given: unknown): number {
  if (given === undefined) return 1;
  if (Number.isInteger(given) && (given as number) >= 1) return given as number;
  throw new Error(`'${CONSUME}' was given concurrency ${JSON.stringify(given)}; it is a whole number, 1 or more`);
}

/** Where a queue trigger receives from, where its settings name both a connection and a queue. */
function placeOf(trigger: TriggerDoc): { connection: string; queue: string } | undefined {
  const { connection, queue } = (trigger.settings ?? {}) as { connection?: unknown; queue?: unknown };
  return typeof connection === 'string' && typeof queue === 'string' ? { connection, queue } : undefined;
}

/** The queues this step works, by canonical connection: every queue a queue trigger receives from, narrowed to `queues`. */
function queuesOf(worked: Worked, wanted: unknown): Map<string, string[]> {
  const narrowed = Array.isArray(wanted) ? new Set(wanted.map(String)) : undefined;
  const byConnection = new Map<string, string[]>();
  for (const place of worked.serving.triggers(KIND).map(placeOf)) {
    if (!place || (narrowed && !narrowed.has(place.queue))) continue;
    const canonical = worked.canon(place.connection);
    const queues = byConnection.get(canonical) ?? [];
    if (!queues.includes(place.queue)) queues.push(place.queue);
    byConnection.set(canonical, queues);
  }
  return byConnection;
}

/** Start consuming every queue of one connection, and answer the way to stop them all. */
async function consumeOn(
  worked: Worked,
  reached: Reached,
  queues: string[],
  concurrency: number,
): Promise<() => Promise<void>> {
  const stops: (() => Promise<void>)[] = [];
  const stopAll = async () => {
    await Promise.all(stops.map(stop => stop()));
  };
  try {
    for (const queue of queues) {
      const at: Consumed = { connection: reached.connection, queue };
      const handle = (delivery: Delivery) => deliver(worked, at, delivery);
      stops.push(await reached.broker.consume(at.connection, queue, handle, { concurrency }));
      worked.serving.log(`queue: consuming ${queue} on ${at.connection} → ${triggerFor(worked, at)?.fire.run}`);
    }
  } catch (error) {
    // what this connection already consumes is held by nothing yet, so it is stopped here before the start fails
    await stopAll();
    throw error;
  }
  return stopAll;
}

/**
 * Work every queue of this tree until the process stops. Answers once every queue is being consumed; the
 * consuming itself outlives the run, so the runtime holds it -- one hold per connection -- and stops it when the
 * process stops, which takes no further message and waits for every one in flight to be answered.
 */
export const consume: Handler = async ({ in: input, ctx }) => {
  const env = ctx.env as WorkerEnv;
  const { serving, hold } = env;
  if (!serving || !hold)
    throw new Error(
      `'${CONSUME}' works the queues while the tree is served, so it runs from a project's startup list -- not from a graph`,
    );
  const concurrency = concurrencyOf(input.concurrency);
  const worked: Worked = { serving, canon: env.canon ?? (ref => ref) };
  const byConnection = queuesOf(worked, input.queues);
  // every broker first: a connection no broker answers stops the start before anything is held
  const reached = [...byConnection.keys()].map(connection => brokerFor(env, connection, CONSUME));
  let queues = 0;
  for (const one of reached) {
    const named = byConnection.get(one.connection) ?? [];
    hold({ label: `queue ${one.connection}`, stop: await consumeOn(worked, one, named, concurrency) });
    queues += named.length;
  }
  if (!queues) serving.log('queue: no queue trigger to consume');
  return { queues, connections: reached.length };
};
