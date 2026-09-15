/**
 * One tick, fired. The context this kind hands, the input the runtime builds and judges from it, the run
 * itself with a blob scope of its own, and the line the run is logged as. Nothing here waits on time: the
 * scheduler decides *when* and this decides *what happens then*, so a test can fire a tick without a clock.
 */
import type { Serving, TriggerDoc } from '@wilanis/core';
import type { Report } from '@wilanis/engine';
import { refusalOf } from '@wilanis/engine';

/** The context a tick hands a graph, as the kind declares it. */
export interface Tick {
  /** the tick's instant, ISO 8601 in UTC */
  scheduled: string;
  /** when this run began, ISO 8601 in UTC: later than scheduled when the process was busy or catching up */
  fired: string;
  /** ticks between the last fired one and this one that were not fired */
  missed: number;
}

/** What one tick's run answered, for the line it is logged as and for whoever waits on it. */
export interface Fired {
  report?: Report;
  /** why the input could not be built, where the tick never reached a graph */
  error?: string;
  ms: number;
}

/** How a tick's run ended, in the words the log line uses. */
function outcome(fired: Fired): string {
  if (fired.error) return `→ refused at the edge (${fired.error})`;
  const report = fired.report;
  if (!report) return '→ failed';
  const refused = refusalOf(report);
  if (refused) return `→ refused ${refused.reason} (${refused.message})`;
  if (report.status !== 'done') return `→ ${report.status}`;
  return '→ done';
}

/** The line one tick is logged as: what fired, for when, how it ended and what it answered. */
export function lineOf(name: string, tick: Tick, fired: Fired): string {
  const answer = fired.report?.status === 'done' ? ` ${JSON.stringify(fired.report.output)}` : '';
  return `schedule ${name} ${tick.scheduled} ${outcome(fired)} (${fired.ms}ms)${answer}`;
}

/**
 * Fire one tick: the runtime builds and judges the input from the context, the gate runs as it does for any
 * trigger, and the run gets a blob scope of its own that is released once it has answered. A trigger that
 * declares no `in` fires with none; an `in` without a `fire.in` is X252 and never reaches here.
 */
export async function fireTick(serving: Serving, trigger: TriggerDoc, tick: Tick): Promise<Fired> {
  const started = Date.now();
  const request = { ...tick } as Record<string, unknown>;
  const built = serving.inputFor(trigger, request);
  if ('error' in built) return { error: built.error, ms: Date.now() - started };
  const scope = serving.blobs.scope();
  try {
    const report = await serving.fire({ trigger, input: built.input, request, blobs: scope });
    return { report, ms: Date.now() - started };
  } finally {
    await scope.release();
  }
}
