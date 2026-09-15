/**
 * One trigger's schedule, read off its settings: when it next fires, how many of its ticks fell between two
 * instants, and what it is called where a lease is kept. Everything here is a pure reading of the document,
 * so the scheduler's loop holds no arithmetic of its own and a test can step a schedule without a clock.
 */
import type { TriggerDoc } from '@wilanis/core';
import { type Cron, intervalsBetween, nextInterval, nextTick, parseCron, ticksBetween } from './cron.js';

/** What a tick does when the previous tick's run is still going. */
export type Overlap = 'skip' | 'wait' | 'concurrent';

/** A scheduled trigger's settings, as the kind declares them. */
export interface Settings {
  cron?: string;
  everyMs?: number;
  timezone?: string;
  overlap?: Overlap;
  catchUp?: boolean;
}

/** One trigger's schedule: the trigger itself, how it is named, and when it fires. */
export interface Schedule {
  trigger: TriggerDoc;
  /** What a lease holds and a log line names: stable across processes and restarts. */
  name: string;
  settings: Settings;
  overlap: Overlap;
  catchUp: boolean;
  /** the parsed expression, where the schedule is a cron one */
  cron?: Cron;
  timezone: string;
  /** the interval in milliseconds, where the schedule is an interval one */
  everyMs?: number;
  /** the schedule as it was written, for a log line */
  says: string;
}

/**
 * What a lease holds a tick of, and what a log line names. `Serving.triggers` hands a plugin the trigger
 * documents and not the paths they are written at, and this RFC changes no runtime contract to add one -- so
 * a schedule is named by the operation it fires and the schedule it declares, which is as stable across
 * processes and restarts as the path is, and which the checker has already held to be a schedule.
 */
export function nameOf(trigger: TriggerDoc, says: string): string {
  return `${trigger.fire.run} @ ${says}`;
}

/** How a schedule reads, for the line `start` logs and the name a lease holds. */
function saysOf(settings: Settings, timezone: string): string {
  return settings.cron ? `${settings.cron} ${timezone}` : `every ${settings.everyMs} ms`;
}

/**
 * One trigger's schedule, or nothing where its settings are not one. The checker has already refused a
 * schedule that is neither (X251), so nothing here reports: a tree that reaches the scheduler is a judged one.
 */
export function scheduleOf(trigger: TriggerDoc, fallbackZone: string): Schedule | undefined {
  const settings = (trigger.settings ?? {}) as Settings;
  const timezone = settings.timezone ?? fallbackZone;
  const says = saysOf(settings, timezone);
  const common = {
    trigger,
    name: nameOf(trigger, says),
    settings,
    overlap: settings.overlap ?? 'skip',
    catchUp: settings.catchUp === true,
    timezone,
    says,
  };
  if (typeof settings.everyMs === 'number') return { ...common, everyMs: settings.everyMs };
  if (typeof settings.cron !== 'string') return undefined;
  const cron = parseCron(settings.cron);
  return typeof cron === 'string' ? undefined : { ...common, cron };
}

/** The first instant this schedule names strictly after `after`, in epoch milliseconds, or nothing where it names none. */
export function nextOf(schedule: Schedule, after: number): number | undefined {
  if (schedule.everyMs) return nextInterval(schedule.everyMs, after);
  if (!schedule.cron) return undefined;
  return nextTick(schedule.cron, new Date(after), schedule.timezone)?.getTime();
}

/** How many ticks this schedule names strictly between two instants: what `missed` counts. */
export function betweenOf(schedule: Schedule, from: number, to: number): number {
  if (schedule.everyMs) return intervalsBetween(schedule.everyMs, from, to);
  if (!schedule.cron) return 0;
  return ticksBetween(schedule.cron, { from: new Date(from), to: new Date(to), timezone: schedule.timezone });
}

/** The most recent instant this schedule names at or before `at`, for the one tick a catchUp fires. */
export function lastBefore(schedule: Schedule, at: number): number | undefined {
  if (schedule.everyMs) return Math.floor(at / schedule.everyMs) * schedule.everyMs;
  if (!schedule.cron) return undefined;
  // a day back covers every five-field expression that fires at all within one; a rarer one simply catches up
  // at its next ordinary tick, which is what a schedule that fires monthly means by "the most recent tick"
  const day = 24 * 60 * 60_000;
  let found: number | undefined;
  let walk = at - day;
  for (;;) {
    const next = nextOf({ ...schedule }, walk);
    if (next === undefined || next > at) return found;
    found = next;
    walk = next;
  }
}
