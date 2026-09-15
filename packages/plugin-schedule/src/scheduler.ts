/**
 * The loop that keeps a tree's schedule: read the scheduled triggers afresh so a reload is seen, sleep until
 * the earliest tick or a minute, whichever is first, and fire what has come due. Everything it waits on is a
 * `Clock`, so a test hands a fake and steps it and no test sleeps.
 *
 * What it does *at* a tick is `fire.ts`'s; how a schedule reads is `schedule.ts`'s; who may fire a tick when
 * several processes run the tree is a lease keeper's. This is when, and nothing else.
 */
import type { Serving } from '@wilanis/core';
import type { Clock } from './clock.js';
import { systemClock } from './clock.js';
import { type Fired, fireTick, lineOf, type Tick } from './fire.js';
import type { Leases } from './leases.js';
import { KIND } from './paths.js';
import { betweenOf, lastBefore, nextOf, type Schedule, scheduleOf } from './schedule.js';

/** How the scheduler takes a hold, where the run step named a lease. */
export interface Lease {
  keeper: Leases;
  connection: string;
  ttlMs: number;
}

/** What a scheduler is built with: where the tree is, what time it is, and who decides who fires. */
export interface SchedulerOptions {
  serving: Serving;
  clock?: Clock;
  lease?: Lease;
  /** the zone a cron trigger with none of its own is read in */
  timezone?: string;
}

/** What one schedule's runs are, as the loop keeps track of them: what is going, and what is waiting. */
interface State {
  /** the runs of this schedule that have not answered */
  inFlight: number;
  /** the last tick this process fired, so `missed` can count from it */
  lastFired?: number;
  /** the one tick `overlap: wait` keeps back, fired when the run in flight ends */
  waiting?: Tick;
  /** the tick the hold is held for, so a renewal asks for the same one */
  holding?: string;
}

/** A minute: cron's own resolution, and how long the loop sleeps when the next tick is further off than that. */
const MINUTE = 60_000;

/** The instant, as a graph reads it: ISO 8601 in UTC, whatever zone the expression was read in. */
const iso = (at: number) => new Date(at).toISOString();

/**
 * Let whatever a tick just started run as far as it can without waiting on anything outside. A run that
 * answers at once has then answered before the next tick of the same schedule is judged, so `overlap` reads
 * the runs that are really still going rather than one this same wake-up started a moment ago.
 */
const drain = () => new Promise<void>(done => setImmediate(done));

/** Keeps a tree's schedule: one loop, one state per schedule, and every wait through the clock it was given. */
export class Scheduler {
  private readonly serving: Serving;
  private readonly clock: Clock;
  private readonly lease?: Lease;
  private readonly timezone: string;
  private readonly states = new Map<string, State>();
  private readonly stopping = new AbortController();
  private readonly runs = new Set<Promise<void>>();
  /** the instant each schedule is next due at, so a tick is taken once however often the loop wakes */
  private readonly due = new Map<string, number>();
  private looping?: Promise<void>;

  constructor(opts: SchedulerOptions) {
    this.serving = opts.serving;
    this.clock = opts.clock ?? systemClock;
    this.lease = opts.lease;
    this.timezone = opts.timezone ?? 'UTC';
  }

  /** Every scheduled trigger of the tree as it now stands, so a reload is seen at the next wake-up. */
  schedules(): Schedule[] {
    const out: Schedule[] = [];
    for (const trigger of this.serving.triggers(KIND)) {
      const one = scheduleOf(trigger, this.timezone);
      if (one) out.push(one);
    }
    return out;
  }

  /** The state this schedule's runs are kept in, made on first sight of it. */
  private stateOf(name: string): State {
    let state = this.states.get(name);
    if (!state) {
      state = { inFlight: 0 };
      this.states.set(name, state);
    }
    return state;
  }

  /** The tick each schedule is next due at, seeded from now so the first tick of a run is a future one. */
  private seed(now: number): void {
    for (const schedule of this.schedules())
      if (!this.due.has(schedule.name)) {
        const next = nextOf(schedule, now);
        if (next !== undefined) this.due.set(schedule.name, next);
      }
  }

  /** What the `run` step answers and logs: how many triggers are scheduled, and the earliest next tick. */
  start(): { triggers: number; next?: string } {
    const now = this.clock.now();
    const schedules = this.schedules();
    this.seed(now);
    if (!schedules.length) this.serving.log('schedule: no scheduled trigger in the tree');
    else {
      this.serving.log(`schedule: ${schedules.length} trigger(s)`);
      for (const one of schedules) {
        const next = this.due.get(one.name);
        this.serving.log(`schedule: ${one.name} at ${one.says}${next ? `, next ${iso(next)}` : ''}`);
      }
    }
    const nexts = [...this.due.values()].filter(at => at !== undefined);
    const soonest = nexts.length ? Math.min(...nexts) : undefined;
    this.looping = this.loop();
    return { triggers: schedules.length, ...(soonest !== undefined ? { next: iso(soonest) } : {}) };
  }

  /** Read the tree afresh, fire what has come due, and sleep until the next one or a minute, whichever is first. */
  private async loop(): Promise<void> {
    await this.catchUp();
    while (!this.stopping.signal.aborted) {
      const now = this.clock.now();
      const schedules = this.schedules();
      this.forget(schedules);
      this.seed(now);
      for (const schedule of schedules) await this.advance(schedule, now);
      if (this.stopping.signal.aborted) break;
      await this.clock.wait(this.sleepFor(this.clock.now()), this.stopping.signal);
    }
  }

  /**
   * Let go of the schedules the tree no longer has. A reload replaces the set underneath, and a tick still
   * due for a trigger that is gone would otherwise keep the loop awake for a schedule nothing declares.
   */
  private forget(schedules: Schedule[]): void {
    const names = new Set(schedules.map(one => one.name));
    for (const name of [...this.due.keys()]) if (!names.has(name)) this.due.delete(name);
  }

  /** How long to sleep: until the earliest tick due, or a minute, whichever is first and never below zero. */
  private sleepFor(now: number): number {
    const nexts = [...this.due.values()];
    const soonest = nexts.length ? Math.min(...nexts) : now + MINUTE;
    return Math.max(0, Math.min(soonest - now, now + MINUTE - now));
  }

  /**
   * Every tick of one schedule that has come due by now: each is taken once, and the next is worked out from
   * it. A run that answers at once is let answer before the next tick is judged, so `overlap` reads the runs
   * that are really still going rather than one this same wake-up started a moment ago.
   */
  private async advance(schedule: Schedule, now: number): Promise<void> {
    let at = this.due.get(schedule.name);
    while (at !== undefined && at <= now && !this.stopping.signal.aborted) {
      await this.reached(schedule, at);
      await drain();
      const next = nextOf(schedule, at);
      if (next === undefined) {
        this.due.delete(schedule.name);
        return;
      }
      this.due.set(schedule.name, next);
      at = next;
    }
  }

  /** A tick has come: take the hold where there is one, then let `overlap` say whether it fires. */
  private async reached(schedule: Schedule, at: number): Promise<void> {
    if (!(await this.hold(schedule, at))) return; // another process holds this tick, or it is already fired
    const state = this.stateOf(schedule.name);
    const tick: Tick = {
      scheduled: iso(at),
      fired: iso(this.clock.now()),
      missed: state.lastFired === undefined ? 0 : betweenOf(schedule, state.lastFired, at),
    };
    this.dispatch(schedule, tick);
  }

  /** Whether this process may fire this tick: always, alone; the keeper's answer where the run step named a lease. */
  private async hold(schedule: Schedule, at: number): Promise<boolean> {
    if (!this.lease) return true;
    const { keeper, connection, ttlMs } = this.lease;
    const scheduled = iso(at);
    const held = await keeper.acquire(connection, schedule.name, scheduled, ttlMs);
    if (held) this.stateOf(schedule.name).holding = scheduled;
    return held;
  }

  /** What `overlap` says when a tick comes while a run of the same schedule is still going. */
  private dispatch(schedule: Schedule, tick: Tick): void {
    const state = this.stateOf(schedule.name);
    if (state.inFlight === 0 || schedule.overlap === 'concurrent') {
      this.run(schedule, tick);
      return;
    }
    if (schedule.overlap === 'wait' && !state.waiting) {
      state.waiting = tick;
      return;
    }
    // skip, and wait with one tick already waiting: the tick is dropped and counted in the next one's missed
    this.serving.log(`schedule ${schedule.name} ${tick.scheduled} → skipped (previous run still going)`);
  }

  /** Fire one tick and keep the promise, so `stop` can wait for every run in flight to answer. */
  private run(schedule: Schedule, tick: Tick): void {
    const state = this.stateOf(schedule.name);
    state.inFlight++;
    const promise = this.fireAndSettle(schedule, tick).finally(() => {
      state.inFlight--;
      this.runs.delete(promise);
      const waiting = state.waiting;
      if (waiting && state.inFlight === 0) {
        state.waiting = undefined;
        this.run(schedule, { ...waiting, fired: iso(this.clock.now()) });
      }
    });
    this.runs.add(promise);
  }

  /** One run, from the fire to the log line, the mark and the release: a refusal is an answer and is marked too. */
  private async fireAndSettle(schedule: Schedule, tick: Tick): Promise<void> {
    const renewing = this.renew(schedule, tick);
    let fired: Fired;
    try {
      fired = await fireTick(this.serving, schedule.trigger, tick);
    } catch (error) {
      fired = { error: (error as Error).message, ms: 0 };
    } finally {
      clearInterval(renewing);
    }
    this.serving.log(lineOf(schedule.name, tick, fired));
    this.stateOf(schedule.name).lastFired = Date.parse(tick.scheduled);
    await this.settle(schedule, tick);
  }

  /** Renew the hold while the run is in flight, so a run longer than the ttl does not lose its own tick. */
  private renew(schedule: Schedule, tick: Tick): ReturnType<typeof setInterval> | undefined {
    const lease = this.lease;
    if (!lease) return undefined;
    const every = Math.max(1, Math.floor(lease.ttlMs / 2));
    const timer = setInterval(() => {
      void lease.keeper.acquire(lease.connection, schedule.name, tick.scheduled, lease.ttlMs).catch(() => {});
    }, every);
    timer.unref?.();
    return timer;
  }

  /** Record the tick as fired and let the hold go, so the next process to ask finds it done rather than free. */
  private async settle(schedule: Schedule, tick: Tick): Promise<void> {
    const lease = this.lease;
    if (!lease) return;
    await lease.keeper.markFired(lease.connection, schedule.name, tick.scheduled);
    await lease.keeper.release(lease.connection, schedule.name);
    this.stateOf(schedule.name).holding = undefined;
  }

  /**
   * At start, with a lease and `catchUp`: a tick that fell while no process ran is fired once, as the most
   * recent such tick, with the earlier ones counted in `missed`. Without a lease there is nothing to remember
   * the last tick by, which X253 has already refused.
   */
  private async catchUp(): Promise<void> {
    const lease = this.lease;
    if (!lease) return;
    const now = this.clock.now();
    for (const schedule of this.schedules()) {
      if (!schedule.catchUp) continue;
      const last = await lease.keeper.lastFired(lease.connection, schedule.name);
      const recent = lastBefore(schedule, now);
      if (recent === undefined || last === undefined || Date.parse(last) >= recent) continue;
      // the ticks between the last one fired and this one were missed while no process ran: say how many
      this.stateOf(schedule.name).lastFired = Date.parse(last);
      await this.reached(schedule, recent);
    }
  }

  /** Stop taking ticks, cut the sleep, and answer once every run in flight has answered. */
  async stop(): Promise<void> {
    this.stopping.abort();
    await this.looping;
    await Promise.allSettled([...this.runs]);
  }
}
