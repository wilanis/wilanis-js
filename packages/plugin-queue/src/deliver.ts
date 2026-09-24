/**
 * One delivery, handled. The trigger is found afresh from `serving` -- so a reload puts a new trigger behind a
 * queue that keeps being consumed -- the context is built from the delivery, the runtime builds and judges the
 * input from it and gates the run exactly as it gates a request, and the report becomes the message's outcome
 * through `outcomeOf`. Nothing here waits on a broker: the broker decides when a message arrives, and this
 * decides what becomes of it.
 */
import type { Serving, TriggerDoc } from '@wilanis/core';
import type { Answer, Delivery } from './brokers.js';
import { DEFAULT_BACKOFF_MS, DEFAULT_MAX_ATTEMPTS, type Decided, faultOf, outcomeOf } from './outcome.js';
import { KIND } from './paths.js';

/** Where a delivery came from: the canonical connection of the broker, and the queue on it. */
export interface Consumed {
  connection: string;
  queue: string;
}

/** What a delivery is handled with: the tree being served, and how a written connection is made canonical. */
export interface Worked {
  serving: Serving;
  canon: (ref: string) => string;
}

/** A queue trigger's settings, as far as where it receives from is concerned. */
const placeOf = (trigger: TriggerDoc) => (trigger.settings ?? {}) as { connection?: unknown; queue?: unknown };

/** Whether a queue trigger receives from this connection and queue. */
export function receives(trigger: TriggerDoc, at: Consumed, canon: (ref: string) => string): boolean {
  const { connection, queue } = placeOf(trigger);
  return typeof connection === 'string' && canon(connection) === at.connection && queue === at.queue;
}

/**
 * The trigger a message on this queue fires, as the tree now stands: the first queue trigger that receives
 * from it, in the order the tree lists them.
 */
export function triggerFor(worked: Worked, at: Consumed): TriggerDoc | undefined {
  return worked.serving.triggers(KIND).find(trigger => receives(trigger, at, worked.canon));
}

/** The context a delivery hands a graph, as the kind declares it. */
export function contextOf(at: Consumed, delivery: Delivery): Record<string, unknown> {
  return {
    id: delivery.id,
    attempt: delivery.attempt,
    queue: at.queue,
    headers: delivery.headers,
    message: delivery.body,
  };
}

/** The line one delivery is logged as: which message, which attempt, what became of it, and why. */
function lineOf(at: Consumed, delivery: Delivery, decided: Decided, ms: number): string {
  return `queue ${at.queue} ${delivery.id} attempt ${delivery.attempt} → ${decided.outcome} (${ms}ms, ${decided.ended})`;
}

/** What the broker is told: the outcome, and for a retry the wait before the next delivery. */
const answerOf = (decided: Decided): Answer =>
  decided.backoffMs === undefined
    ? { outcome: decided.outcome }
    : { outcome: decided.outcome, backoffMs: decided.backoffMs };

/** A message no trigger receives any more, across a reload: delivered again later, and dead once the default attempts are spent. */
function unreceived(delivery: Delivery): Decided {
  const ended = 'no queue trigger receives it';
  if (delivery.attempt >= DEFAULT_MAX_ATTEMPTS) return { outcome: 'dead', ended };
  return { outcome: 'retry', backoffMs: DEFAULT_BACKOFF_MS, ended };
}

/** The decision about a run, said with the operation it ran, so the line names what was fired. */
const naming = (trigger: TriggerDoc, decided: Decided): Decided => ({
  ...decided,
  ended: `${trigger.fire.run} ${decided.ended}`,
});

/** Fire the trigger for one delivery, in a blob scope of its own, and decide the outcome of its report. */
async function fired(worked: Worked, trigger: TriggerDoc, request: Record<string, unknown>, attempt: number) {
  const built = worked.serving.inputFor(trigger, request);
  // a message whose input does not fit will not fit on any later delivery either, so it is parked at once
  if ('error' in built) return { outcome: 'dead', ended: `input does not conform: ${built.error}` } as Decided;
  const scope = worked.serving.blobs.scope();
  try {
    const report = await worked.serving.fire({ trigger, input: built.input, request, blobs: scope });
    return naming(trigger, outcomeOf(trigger, report, attempt));
  } catch (error) {
    return naming(trigger, faultOf(trigger, (error as Error).message, attempt));
  } finally {
    await scope.release();
  }
}

/** Handle one delivery of a consumed queue: fire its trigger, log one line, and answer the broker. */
export async function deliver(worked: Worked, at: Consumed, delivery: Delivery): Promise<Answer> {
  const started = Date.now();
  const trigger = triggerFor(worked, at);
  const decided = trigger
    ? await fired(worked, trigger, contextOf(at, delivery), delivery.attempt)
    : unreceived(delivery);
  worked.serving.log(lineOf(at, delivery, decided, Date.now() - started));
  return answerOf(decided);
}
