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
  /**
   * What a lease holds and a log line names: the trigger's canonical path. It is the one thing that tells
   * two triggers apart -- two may fire one operation on one schedule and differ only in their inputs -- and
   * it is as stable across processes and restarts as the document is.
   */
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

/** How a schedule reads, for the line `start` logs and the name a lease holds. */
function saysOf(settings: Settings, timezone: string): string {
  return settings.cron ? `${settings.cron} ${timezone}` : `every ${settings.everyMs} ms`;
}

/**
 * One trigger's schedule, named by the canonical path it is written at, or nothing where its settings are
 * not one. The checker has already refused a schedule that is neither (X251), so nothing here reports: a
 * tree that reaches the scheduler is a judged one.
 */
export function scheduleOf(trigger: TriggerDoc, path: string, fallbackZone: string): Schedule | undefined {
  const settings = (trigger.settings ?? {}) as Settings;
  const timezone = settings.timezone ?? fallbackZone;
  const says = saysOf(settings, timezone);
  const common = {
    trigger,
    name: path,
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

/**
 * The most recent instant this schedule names at or before `at`, for the one tick a catchUp fires. The search
 * walks forward from `since` -- the tick last recorded as fired -- so a weekly or a monthly schedule is caught
 * up as surely as an hourly one: looking a fixed window back would never find the tick of a schedule whose
 * ticks are further apart than the window, which is what the kind's description promises it does.
 */
export function lastBefore(schedule: Schedule, at: number, since: number): number | undefined {
  if (schedule.everyMs) return Math.floor(at / schedule.everyMs) * schedule.everyMs;
  if (!schedule.cron) return undefined;
  let found: number | undefined;
  let walk = since;
  // a ceiling on the walk: `missed` is a number for a log line, not a list, and a schedule left unrun for
  // years should still start rather than spin. The most recent tick found stands.
  for (let step = 0; step < 10_000; step++) {
    const next = nextOf(schedule, walk);
    if (next === undefined || next > at) return found;
    found = next;
    walk = next;
  }
  return found;
}
