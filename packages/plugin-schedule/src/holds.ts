/**
 * Who may fire a tick, and what becomes of the hold once it has run. Where a project's `run` step named a
 * lease, every tick is taken through a keeper: one process gets the hold, the others go on. This is that
 * side of the scheduler -- take, renew, settle, and what the keeper last remembers -- kept apart from the
 * loop, which is only ever about *when*.
 *
 * A keeper is a store, and a store has bad moments. Every call here answers rather than throws: a tick that
 * cannot be taken is let go and said out loud, and the schedule goes on. One transient failure must never be
 * the end of scheduling.
 */

import type { Leases } from '@wilanis/plugin-storage';
import type { Clock } from './clock.js';

/** How the scheduler takes a hold, where the run step named a lease. */
export interface Lease {
  keeper: Leases;
  connection: string;
  ttlMs: number;
}

/** What `Holds` needs of the world besides the keeper: the time, and somewhere to say what happened. */
export interface HoldsOptions {
  lease?: Lease;
  clock: Clock;
  log: (line: string) => void;
  /** aborted when the scheduler is stopping, so a renewal in flight ends with it */
  stopping: AbortSignal;
}

/** What went wrong, in one line a log can carry, whatever was thrown. */
const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The lease side of one scheduler: every tick that is taken, renewed and settled goes through here. Without a
 * lease it answers as the only process there is -- every tick is this one's, and nothing is recorded.
 */
export class Holds {
  private readonly lease?: Lease;
  private readonly clock: Clock;
  private readonly log: (line: string) => void;
  private readonly stopping: AbortSignal;

  constructor(opts: HoldsOptions) {
    this.lease = opts.lease;
    this.clock = opts.clock;
    this.log = opts.log;
    this.stopping = opts.stopping;
  }

  /** Whether a lease decides who fires at all, or this process is simply the only one. */
  get leased(): boolean {
    return this.lease !== undefined;
  }

  /**
   * Whether this process may fire this tick: always, alone; the keeper's answer where a lease was named. A
   * keeper that throws is a store briefly out of reach, not the end of the schedule -- the tick is let go and
   * logged, and the loop goes on to the next one.
   */
  async take(name: string, scheduled: string): Promise<boolean> {
    const lease = this.lease;
    if (!lease) return true;
    try {
      return await lease.keeper.acquire(lease.connection, name, scheduled, lease.ttlMs);
    } catch (error) {
      this.log(`schedule ${name} ${scheduled} → not taken (the lease keeper refused: ${reasonOf(error)})`);
      return false;
    }
  }

  /**
   * Renew the hold every half-ttl while the run is in flight, so a run outlasting the ttl does not lose its
   * own tick to another process. It waits on the `Clock` like every other wait in this plugin, so a test that
   * steps a fake clock sees the renewals really happen rather than assuming them.
   */
  async renew(name: string, scheduled: string, until: AbortSignal): Promise<void> {
    const lease = this.lease;
    if (!lease) return;
    const every = Math.max(1, Math.floor(lease.ttlMs / 2));
    while (!until.aborted && !this.stopping.aborted) {
      await this.clock.wait(every, until);
      if (until.aborted || this.stopping.aborted) return;
      try {
        await lease.keeper.acquire(lease.connection, name, scheduled, lease.ttlMs);
      } catch (error) {
        this.log(`schedule ${name} ${scheduled} → the hold was not renewed (${reasonOf(error)})`);
      }
    }
  }

  /**
   * Record the tick as fired and let the hold go, so the next process to ask finds it done rather than free.
   * A keeper that throws here has already let the run happen: the tick is logged as unsettled and the hold is
   * left to expire on its own, which is what the ttl is for.
   */
  async settle(name: string, scheduled: string): Promise<void> {
    const lease = this.lease;
    if (!lease) return;
    try {
      await lease.keeper.markFired(lease.connection, name, scheduled);
      await lease.keeper.release(lease.connection, name);
    } catch (error) {
      this.log(
        `schedule ${name} ${scheduled} → ran, but the lease keeper did not settle it (${reasonOf(error)}): the hold expires on its own`,
      );
    }
  }

  /**
   * The tick the keeper last recorded for this schedule, or nothing where it could not say. A keeper that
   * throws at a start is no reason to refuse to schedule: nothing is caught up, and the ordinary ticks run.
   */
  async lastFired(name: string): Promise<string | undefined> {
    const lease = this.lease;
    if (!lease) return undefined;
    try {
      return await lease.keeper.lastFired(lease.connection, name);
    } catch (error) {
      this.log(`schedule ${name} → not caught up (the lease keeper refused: ${reasonOf(error)})`);
      return undefined;
    }
  }
}
