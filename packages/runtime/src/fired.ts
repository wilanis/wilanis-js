/**
 * What one fire left behind, before anyone says it as spans. The embedder assembles it around every fire of a
 * trigger and hands it to whoever is listening; `traceOf` turns it into a `Trace`. It is the record and not
 * the trace on purpose: a `Fired` is the runtime's own words -- the gate's decisions, the guard's timing, the
 * reports -- and a `Trace` is what an exporter reads, so the shape the runtime keeps is free to say more than
 * a span carries.
 */
import { randomUUID } from 'node:crypto';
import { outcomeOf, type Report } from '@wilanis/engine';

/** What the guard's `identify` did, timed: what it added to the context, or the reason it refused. */
export interface Identified {
  startedAt: number;
  endedAt: number;
  /** The context keys the guard established -- request.principal, request.session, request.challenge. */
  added: string[];
  /** The declared reason it refused with, where it did; the run ended here. */
  refused?: string;
}

/** One policy's decision, kept whether it allowed or not: the gate is only readable when it says both. */
export interface Decided {
  /** The policy's canonical path. */
  policy: string;
  /** The decision graph's own run. */
  report: Report;
  /** What the policy's outcome made of a refusal; absent where the policy allowed. */
  effect?: 'deny' | 'challenge';
}

/**
 * One fire of one trigger, whole: the gate as it happened, the operation's run where it got that far, and the
 * report the kind answers from. A startup step is not one of these -- it has no trigger, no kind and no gate --
 * so it is a `Started` instead, and every reader of a record knows which it is holding.
 */
export interface Fired {
  /** New per fire, sorting by time: what names this run wherever it is later found. */
  id: string;
  /** The trigger's canonical path, and its kind's. */
  trigger: string;
  kind: string;
  /** The caller's own trace, read at the kind's `correlation` path and copied opaquely. */
  correlation?: string;
  /** The guard's identification, where a guard ran at all. */
  identify?: Identified;
  /** Every decision the gate made, allowed or not, in the order the trigger attaches them. */
  decisions: Decided[];
  /** The trigger's operation, where the gate let it run. */
  run?: Report;
  /** What `fire` answered: the run's report, or the gate's where the gate ended it. */
  answer: Report;
  startedAt: number;
  endedAt: number;
}

/**
 * One of the project's startup steps, run. It carries the step's place in the list and its label rather than a
 * trigger, because a step is not one: a reader of a record never has to handle a trigger that does not exist.
 */
export interface Started {
  id: string;
  /** The step's index in `project.json → startup`, and what it is called there. */
  at: number;
  label: string;
  /** The port operation the step names. */
  run: string;
  /** What running it answered. */
  answer: Report;
  startedAt: number;
  endedAt: number;
}

/** What one run of a tree left behind: one fire of a trigger, or one of the project's startup steps. */
export type Ran = Fired | Started;

/** Whether what ran was a startup step rather than a fire of a trigger. */
export const isStarted = (ran: Ran): ran is Started => 'at' in ran;

/** A new id for one run, sorting by the time it was made: UUIDv7, so nothing is depended on for it. */
export function runId(now: number): string {
  const uuid = randomUUID();
  const stamp = now.toString(16).padStart(12, '0');
  // v7: 48 bits of milliseconds, then the version nibble, then what randomUUID already made random
  return `${stamp.slice(0, 8)}-${stamp.slice(8, 12)}-7${uuid.slice(15, 18)}-${uuid.slice(19, 23)}-${uuid.slice(24)}`;
}

/** The value at a dotted path within a kind's context, where it is a string; anything else correlates nothing. */
export function correlationOf(request: Record<string, unknown>, path: string | undefined): string | undefined {
  if (!path) return undefined;
  let value: unknown = request;
  for (const step of path.split('.')) {
    if (!value || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[step];
  }
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * How one run ended, in the words a span carries: `ok`, `refused: <reason>`, `failed` or `blocked`. A gate's
 * denial and a challenge are said by the decision's own span, so what the root says is what the run did.
 */
export function statusOf(report: Report): string {
  const outcome = outcomeOf(report);
  if (outcome.kind === 'answered') return 'ok';
  if (outcome.kind === 'refused') return `refused: ${outcome.reason}`;
  return outcome.kind === 'blocked' ? 'blocked' : 'failed';
}
