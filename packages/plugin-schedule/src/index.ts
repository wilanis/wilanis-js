/**
 * @wilanis/plugin-schedule, the @schedule plugin: a trigger fired by the clock.
 *
 * What runs the schedule is the `holds` operation a project's startup list names, not this module's own
 * doing: a tree that names no step schedules nothing, as a tree that names no listener serves nothing. The
 * trigger kind's runtime is here for `encode` alone -- `wilanis run` and the tick's log line then say the
 * same thing about the same report.
 */
import { fileURLToPath } from 'node:url';
import type { PluginModule, TriggerRuntime } from '@wilanis/core';
import { refusalOf } from '@wilanis/engine';
import { KIND, ROOT, RUN } from './paths.js';
import { check } from './rules.js';
import { run } from './run.js';

export type { Clock } from './clock.js';
export { systemClock } from './clock.js';
export type { Cron } from './cron.js';
export { knownZone, nextInterval, nextTick, parseCron } from './cron.js';
export type { Tick } from './fire.js';
export type { Lease } from './holds.js';
export type { Schedule, Settings } from './schedule.js';
export { scheduleOf } from './schedule.js';
export type { SchedulerOptions } from './scheduler.js';
export { Scheduler } from './scheduler.js';

const DOCS = fileURLToPath(new URL('../docs', import.meta.url));

const runtime: TriggerRuntime = {
  // the work is the `run` step's: the runtime does not call this hook today, and a schedule that started
  // itself here would fire on a tree that never asked to be scheduled
  async start(triggers, _fire, { log }) {
    if (triggers.length) log(`schedule: ${triggers.length} trigger(s) -- fired while a startup step names ${RUN}`);
    return async () => {};
  },
  // an answer is the report's output; a refusal is { reason, message } plus whatever it carries, so the
  // tick's log line and `wilanis run` say the same thing
  encode: (_trigger, report) => {
    const refused = refusalOf(report);
    return refused ? { reason: refused.reason, message: refused.message, ...(refused.detail ?? {}) } : report.output;
  },
};

const schedule: PluginModule = {
  root: ROOT,
  docs: DOCS,
  handlers: { [RUN]: run },
  triggers: { [KIND]: runtime },
  check,
};

export default schedule;
