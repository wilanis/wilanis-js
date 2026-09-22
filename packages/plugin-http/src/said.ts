/**
 * What the listener says of one request besides its answer: which run it was, found in the record the runtime
 * hands its observers, and the one log line, in the words a trace uses for how the run ended.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Serving, Trace } from '@wilanis/core';
import { outcomeOf, type Report } from '@wilanis/engine';

/** What one request learnt of the run it fired: its id, and the word the gate ended it on where it did. */
export interface Heard {
  run?: string;
  gate?: 'denied' | 'challenged';
}

/**
 * The request a fire belongs to. The runtime tells every observer of a fire before `fire` answers, and it does
 * so inside the request's own async context, so the record lands on the request that fired it and never on one
 * answered beside it. A fire nested inside another is told first and the outer one last, so what stays is the
 * run the request fired.
 */
const hearing = new AsyncLocalStorage<Heard>();

/** Run `fire` with `heard` as the place its run's record is written to. */
export const heardIn = <T>(heard: Heard, fire: () => Promise<T>): Promise<T> => hearing.run(heard, fire);

/** The policy that ended the run, by what it made of the refusal; nothing where no policy did. */
function gateOf(trace: Trace): Heard['gate'] {
  const outcomes = trace.children.map(child => child.attributes['wilanis.policy.outcome']);
  return outcomes.find(
    (outcome): outcome is 'denied' | 'challenged' => outcome === 'denied' || outcome === 'challenged',
  );
}

/** Listen for every fire and write its id, and the gate's word, onto the request that fired it. */
export function hear(serving: Serving): () => void {
  return serving.observe(trace => {
    const heard = hearing.getStore();
    const run = trace.attributes['wilanis.run.id'];
    if (!heard || typeof run !== 'string') return;
    heard.run = run;
    heard.gate = gateOf(trace);
  });
}

/**
 * How a run ended, in the trace's words: `ok`, `refused: <reason>`, `denied: <reason>` and `challenged: <reason>`
 * where the gate ended it, `failed at '<node>': <message>`, `blocked: needs <roots>`. A reason the route does not
 * map is said as one, since its answer was a fault's and this line is where an operator finds out why.
 */
export function outcomeWords(report: Report, heard: Heard, mapped: (reason: string) => boolean): string {
  const outcome = outcomeOf(report);
  if (outcome.kind === 'answered') return 'ok';
  if (outcome.kind === 'refused') {
    const words = `${heard.gate ?? 'refused'}: ${outcome.reason}`;
    return mapped(outcome.reason) ? words : `${words}, which response.refusals does not map: ${outcome.message}`;
  }
  if (outcome.kind === 'blocked') return `blocked: needs ${outcome.needs.join(', ')}`;
  return outcome.at ? `failed at '${outcome.at}': ${outcome.error}` : `failed: ${outcome.error}`;
}

/** One request's line: what was asked, what it was answered, how long it took and why, and the run a fault names. */
export function lineOf(asked: string, status: number, took: number, said: { why: string; run?: string }): string {
  return `${asked} → ${status} (${took}ms, ${said.why})${said.run ? `  run=${said.run}` : ''}`;
}
