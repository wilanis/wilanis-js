/**
 * What `wilanis run` says of a fired trigger. There the operator is the caller, so stdout carries the tree's
 * answer or its refusal -- what the cli kind encoded -- and stderr what broke, in the startup runner's words.
 * A script telling a refusal from a fault reads stdout: the tree spoke, or it did not.
 */
import { type Outcome, outcomeOf, type Report } from '@wilanis/engine';

/** The two streams a run prints on; a stream left out prints nothing. */
export interface RunSaid {
  stdout?: string;
  stderr?: string;
}

/** Where a fault broke: the node itself, followed down through the nested runs that carried it up. */
function faultIn(report: Report): Outcome {
  const outcome = outcomeOf(report);
  if (outcome.kind !== 'faulted') return outcome;
  const sub = report.nodes[outcome.at]?.sub;
  const below = sub ? faultIn(sub) : undefined;
  return below?.kind === 'faulted' && below.at ? below : outcome;
}

/** What `wilanis run` prints for a report and the answer the cli kind encoded from it. */
export function runSaid(report: Report, answer: unknown): RunSaid {
  const outcome = faultIn(report);
  if (outcome.kind === 'faulted') return { stderr: `fault at '${outcome.at}': ${outcome.error}` };
  if (outcome.kind === 'blocked') return { stderr: `blocked: needs ${outcome.needs.join(', ')}` };
  if (answer === undefined) return {};
  return { stdout: typeof answer === 'string' ? answer : JSON.stringify(answer, null, 2) };
}
