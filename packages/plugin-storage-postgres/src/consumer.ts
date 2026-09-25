/**
 * One `consume` of one table queue: what hands its messages to the worker's handle, at most `concurrency` at
 * once, and does in the table what each answer says.
 *
 * It looks at the table only when something could have become deliverable: when it starts, when a notification
 * says the queue changed (a publish, a retry), when a delivery of its own is answered, and when the soonest
 * waiting message falls due by the database's clock. There is no fixed beat. While every slot is busy it arms no
 * timer at all -- a message falling due then has nowhere to go, and the delivery that ends next looks again --
 * and over a queue with nothing waiting it arms none either, since the next publish notifies. What keeps a
 * process whose only work is its queues alive meanwhile is the listening session, not a timer.
 *
 * A look that fails -- the database went away -- is tried again after a pause that doubles to a bound, so a
 * consumer outlives an outage without hammering the server; the first look is not, so a table `ensure` never
 * made fails the `consume` step instead of a worker that consumes nothing.
 */
import type { Answer, Handle } from '@wilanis/plugin-queue';
import { forget, park, release, type Table, type Taken, takeDue, untake } from './queue-table.js';

/** The first pause after a look failed; each further failure doubles it, up to `FAILED_MAX_MS`. */
const FAILED_MS = 1000;
const FAILED_MAX_MS = 30_000;
/** The longest a timer can be armed for; a message due later is looked at again then, and waited for again. */
const TIMER_MAX_MS = 2 ** 31 - 1;

/** The queue a consumer works: the table it is kept in, its name, and how long a delivery holds its lock. */
export interface Worked {
  table: Table;
  queue: string;
  visibilityMs: number;
}

/** What a consumer listens through: `wake` is called on every notification about its queue; answers the way to stop. */
export type Listen = (wake: () => void) => Promise<() => Promise<void>>;

/** One queue being consumed: its messages handed to a handle, as many at once as allowed, until stopped. */
export class TableConsumer {
  private readonly inFlight = new Set<Promise<void>>();
  private stopping = false;
  private timer: NodeJS.Timeout | undefined;
  private looking: Promise<void> | undefined;
  private again = false;
  private failures = 0;
  private unlisten: (() => Promise<void>) | undefined;

  constructor(
    private readonly worked: Worked,
    private readonly handle: Handle,
    private readonly concurrency: number,
  ) {}

  /** Listen for the queue, then look once; a look that fails here fails the start, and nothing is left listening. */
  async start(listen: Listen): Promise<void> {
    this.unlisten = await listen(() => this.wake());
    this.looking = this.looks();
    try {
      await this.looking;
    } catch (error) {
      this.stopping = true;
      await this.unlisten();
      throw error;
    } finally {
      this.looking = undefined;
    }
  }

  /** Take no further message, and resolve once every delivery in flight has been answered and its answer kept. */
  async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.timer);
    await this.unlisten?.();
    await this.looking;
    await Promise.all([...this.inFlight]);
  }

  /** Look at the queue now, or once the look under way ends, since what woke this may be newer than it. */
  private wake(): void {
    if (this.stopping) return;
    if (this.looking) {
      this.again = true;
      return;
    }
    this.looking = this.looks()
      .catch(() => this.failed())
      .finally(() => {
        this.looking = undefined;
      });
  }

  /** Look, and look again for as long as something woke the consumer while it was looking. */
  private async looks(): Promise<void> {
    do {
      this.again = false;
      await this.look();
    } while (this.again && !this.stopping);
  }

  /** Take what is due into the free slots, and sleep until the next message falls due while a slot is free. */
  private async look(): Promise<void> {
    clearTimeout(this.timer);
    const room = this.concurrency - this.inFlight.size;
    if (room <= 0) return; // every slot busy: the delivery that ends next looks again, so no timer is armed
    const { table, queue, visibilityMs } = this.worked;
    const { taken, nextMs } = await takeDue(table, queue, room, visibilityMs);
    this.failures = 0;
    if (this.stopping) {
      await Promise.all(taken.map(one => untake(table, one)));
      return;
    }
    for (const one of taken) this.handOut(one);
    if (taken.length < room && nextMs !== undefined) this.sleep(nextMs);
  }

  /** Arm the one timer, for the moment the soonest waiting message may be handed out. */
  private sleep(ms: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.wake(), Math.min(ms, TIMER_MAX_MS));
  }

  /** A look failed: look again after a pause, longer after each failure in a row, never longer than the bound. */
  private failed(): void {
    const wait = Math.min(FAILED_MS * 2 ** this.failures, FAILED_MAX_MS);
    this.failures++;
    this.sleep(wait);
  }

  /** Run one delivery in a slot of its own, and look again once it has been answered. */
  private handOut(taken: Taken): void {
    const running: Promise<void> = this.deliver(taken).finally(() => {
      this.inFlight.delete(running);
      this.wake();
    });
    this.inFlight.add(running);
  }

  /** Hand one message to the handle and keep what its answer says; a handle that throws is a retry with no wait. */
  private async deliver(taken: Taken): Promise<void> {
    let answer: Answer;
    try {
      answer = await this.handle({ ...taken, headers: { ...taken.headers } });
    } catch {
      answer = { outcome: 'retry' };
    }
    try {
      await this.settle(taken, answer);
    } catch {
      // the answer never reached the table: the lock expires and the message is delivered again, at least once
    }
  }

  /** Forget, redeliver or park one message as its answer says. */
  private async settle(taken: Taken, answer: Answer): Promise<void> {
    const { table, queue } = this.worked;
    if (answer.outcome === 'ack') await forget(table, taken);
    else if (answer.outcome === 'dead') await park(table, taken);
    else await release(table, taken, queue, answer.backoffMs ?? 0);
  }
}
