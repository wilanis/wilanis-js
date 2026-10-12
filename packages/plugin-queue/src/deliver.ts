/**
 * One delivery, handled. The trigger is found afresh from `serving` -- so a reload puts a new trigger behind a
 * queue that keeps being consumed -- the context is built from the delivery, the runtime builds and judges the
 * input from it and gates the run exactly as it gates a request, and the report becomes the message's outcome
 * through `outcomeOf`. Nothing here waits on a broker: the broker decides when a message arrives, and this
 * decides what becomes of it.
 *
 * Where the trigger says `deadlineMs`, the run is handed a signal that aborts once the deadline passes (RFC 0044),
 * as an http route's is (RFC 0012). The worker still waits for the report: a cancelled run answers one, and it is
 * a fault to its message, so it becomes `onFault`.
 */
import type { Serving, TriggerDoc } from '@wilanis/core';
import type { Report } from '@wilanis/engine';
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

/**
 * Where a queue trigger receives from, the connection canonical, where its settings name both a connection and a
 * queue. The one answer to "which queue is this": the worker groups by it, a delivery finds its trigger by it,
 * and X406 refuses two triggers that answer the same.
 */
export function placeOf(trigger: TriggerDoc, canon: (ref: string) => string): Consumed | undefined {
  const { connection, queue } = (trigger.settings ?? {}) as { connection?: unknown; queue?: unknown };
  return typeof connection === 'string' && typeof queue === 'string'
    ? { connection: canon(connection), queue }
    : undefined;
}

/** Whether a queue trigger receives from this connection and queue. */
export function receives(trigger: TriggerDoc, at: Consumed, canon: (ref: string) => string): boolean {
  const place = placeOf(trigger, canon);
  return place !== undefined && place.connection === at.connection && place.queue === at.queue;
}

/**
 * The trigger a message on this queue fires, as the tree now stands: the one queue trigger that receives from
 * it. X406 refuses a tree where two do, so the first in the order the tree lists them is the only one.
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

/** A queue trigger's deadline, where its settings write one; X401 has held it to a whole number a timer can wait. */
function deadlineOf(trigger: TriggerDoc): number | undefined {
  const { deadlineMs } = (trigger.settings ?? {}) as { deadlineMs?: unknown };
  return typeof deadlineMs === 'number' ? deadlineMs : undefined;
}

/** A deadline armed at the fire: the signal that aborts once it passes, and how to clear it once the run answers. */
interface Armed {
  signal?: AbortSignal;
  clear: () => void;
}

/** A deadline armed, as an http route's `withDeadline` arms one; with none, no signal and nothing to clear. */
function armed(deadlineMs: number | undefined): Armed {
  if (deadlineMs === undefined) return { clear: () => undefined };
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), deadlineMs);
  return { signal: control.signal, clear: () => clearTimeout(timer) };
}

/** What a report means to its message, with a run the deadline cancelled said so, as a scheduled tick's line says it. */
function decidedFor(trigger: TriggerDoc, report: Report, attempt: number, signal?: AbortSignal): Decided {
  const decided = outcomeOf(trigger, report, attempt);
  return report.status === 'cancelled' && signal?.aborted ? { ...decided, ended: 'cancelled (deadline)' } : decided;
}

/** Fire the trigger for one delivery, in a blob scope of its own and under its deadline, and decide the outcome of its report. */
async function fired(worked: Worked, trigger: TriggerDoc, context: Record<string, unknown>, attempt: number) {
  const built = worked.serving.inputFor(trigger, context);
  // a message whose input does not fit will not fit on any later delivery either, so it is parked at once
  if ('error' in built) return { outcome: 'dead', ended: `input does not conform: ${built.error}` } as Decided;
  const scope = worked.serving.blobs.scope();
  // the clock starts here, after the input is built and judged, and covers the gate and the run
  const { signal, clear } = armed(deadlineOf(trigger));
  try {
    const args = { trigger, input: built.input, context, blobs: scope };
    const report = await worked.serving.fire(signal ? { ...args, signal } : args);
    return naming(trigger, decidedFor(trigger, report, attempt, signal));
  } catch (error) {
    return naming(trigger, faultOf(trigger, (error as Error).message, attempt));
  } finally {
    clear();
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
