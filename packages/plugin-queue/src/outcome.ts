/**
 * What a run's report means to the message that fired it: one function, shared by the worker (which tells the
 * broker) and the trigger kind's `encode` (which tells `wilanis run` and the rehearsal), so the two can never
 * say different things about the same report.
 *
 * An answer is `ack`. A refusal is what the trigger's `outcomes` maps its reason to (T005 has held every
 * reachable reason to a key; one it does not map, which only a reload can bring about, is taken as a fault). A
 * fault, a blocked run or a cancelled one is `onFault`, `retry` by default. A `retry` on the delivery that was
 * the last `maxAttempts` allows is `dead`. The wait before a retry doubles with every attempt.
 */
import type { TriggerDoc } from '@wilanis/core';
import { outcomeOf as endingOf, type Report } from '@wilanis/engine';
import type { Outcome } from './brokers.js';

/** The words an outcome is spelled in, in a trigger's `outcomes` and `onFault`. */
export const OUTCOMES: readonly Outcome[] = ['ack', 'retry', 'dead'];

/** What a queue trigger's settings say about its messages' outcomes, with the defaults the kind declares. */
export interface Outcomes {
  maxAttempts: number;
  backoffMs: number;
  onFault: Outcome;
  outcomes: Record<string, string>;
}

export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_BACKOFF_MS = 1000;

/** A queue trigger's outcome settings, with the defaults filled in; X401 has judged what was written. */
export function outcomesOf(trigger: TriggerDoc): Outcomes {
  const settings = (trigger.settings ?? {}) as Record<string, unknown>;
  return {
    maxAttempts: typeof settings.maxAttempts === 'number' ? settings.maxAttempts : DEFAULT_MAX_ATTEMPTS,
    backoffMs: typeof settings.backoffMs === 'number' ? settings.backoffMs : DEFAULT_BACKOFF_MS,
    onFault: settings.onFault === 'dead' ? 'dead' : 'retry',
    outcomes: (settings.outcomes ?? {}) as Record<string, string>,
  };
}

/** What one report became: the outcome, the refusal behind it where there was one, and how the run ended in words. */
export interface Decided {
  outcome: Outcome;
  /** For `retry`: the least wait before the next delivery. */
  backoffMs?: number;
  reason?: string;
  message?: string;
  /** How the run ended, for the delivery's log line: `done`, `refused upstream (...)`, `failed (...)`. */
  ended: string;
}

/** The outcome a refusal's reason maps to, or nothing where the table does not map it to one of the three words. */
function mapped(table: Record<string, string>, reason: string): Outcome | undefined {
  const word = table[reason];
  return OUTCOMES.find(one => one === word);
}

/** What the report says, before the attempt count has had its say. */
function decidedOf(settings: Outcomes, report: Report): Decided {
  const ending = endingOf(report);
  switch (ending.kind) {
    case 'answered':
      return { outcome: 'ack', ended: 'done' };
    case 'refused': {
      const said = { reason: ending.reason, message: ending.message };
      const outcome = mapped(settings.outcomes, ending.reason);
      if (outcome) return { outcome, ...said, ended: `refused ${ending.reason} (${ending.message})` };
      return { outcome: settings.onFault, ...said, ended: `refused ${ending.reason}, which outcomes does not map` };
    }
    case 'faulted':
      return { outcome: settings.onFault, ended: `failed (${ending.error})` };
    case 'blocked':
      return { outcome: settings.onFault, ended: `blocked (needs ${ending.needs.join(', ')})` };
    default:
      return { outcome: settings.onFault, ended: 'cancelled' };
  }
}

/** A retry held to the attempts the trigger allows: dead on the last one, else with the doubled wait. */
function attempted(decided: Decided, settings: Outcomes, attempt: number): Decided {
  if (decided.outcome !== 'retry') return decided;
  if (attempt >= settings.maxAttempts) return { ...decided, outcome: 'dead' };
  return { ...decided, backoffMs: settings.backoffMs * 2 ** (attempt - 1) };
}

/** What a report means to the message that fired it, on the delivery `attempt` (1 for the first). */
export function outcomeOf(trigger: TriggerDoc, report: Report, attempt = 1): Decided {
  const settings = outcomesOf(trigger);
  return attempted(decidedOf(settings, report), settings, attempt);
}

/** What a run that never answered a report means to its message: the worker's own failure is a fault. */
export function faultOf(trigger: TriggerDoc, error: string, attempt: number): Decided {
  const settings = outcomesOf(trigger);
  return attempted({ outcome: settings.onFault, ended: `failed (${error})` }, settings, attempt);
}
