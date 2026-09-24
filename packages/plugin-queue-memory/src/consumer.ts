/**
 * One `consume` of one memory queue: what hands its messages to the worker's handle, at most `concurrency` at
 * once, and does what each answer says.
 *
 * It looks at the queue whenever something could have become deliverable -- a message put, a delivery
 * answered, the moment the soonest waiting message falls due -- rather than on a fixed beat, so a message is
 * handed out as soon as it may be and a backoff is kept to the millisecond the timer allows. One timer is always
 * armed while it consumes, even over an empty queue: a consumer is something the runtime holds until it is
 * stopped, and a process whose only work is its queues must not end because nothing happens to be queued.
 */
import type { Answer, Handle } from '@wilanis/plugin-queue';
import { deliveryOf, type Kept, type MemoryQueue } from './queue.js';

/** The longest the consumer sleeps over a queue with nothing due; a put wakes it sooner. */
const IDLE_MS = 1000;

/** What a consumer asks of the broker once a delivery is answered `ack`: whether that acknowledgement is lost. */
export type LosesAck = () => boolean;

/** One queue being consumed: its messages handed to a handle, as many at once as allowed, until stopped. */
export class Consumer {
  private readonly inFlight = new Set<Promise<void>>();
  private stopping = false;
  private timer: NodeJS.Timeout | undefined;
  private readonly unwake: () => void;

  constructor(
    private readonly queue: MemoryQueue,
    private readonly handle: Handle,
    private readonly concurrency: number,
    private readonly losesAck: LosesAck,
  ) {
    this.unwake = queue.onPut(() => this.pump());
    this.pump();
  }

  /** Take no further message, and resolve once every delivery in flight has been answered and its answer done. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.unwake();
    clearTimeout(this.timer);
    await Promise.all([...this.inFlight]);
  }

  /** Hand out every message that is due, while there is room, then sleep until the next could be. */
  private pump(): void {
    if (this.stopping) return;
    while (this.inFlight.size < this.concurrency) {
      const due = this.queue.take(Date.now());
      if (!due) break;
      const running: Promise<void> = this.handOut(due).finally(() => {
        this.inFlight.delete(running);
        this.pump();
      });
      this.inFlight.add(running);
    }
    this.sleep();
  }

  /** Arm the one timer: for the soonest message waiting, or for the idle beat when none is. */
  private sleep(): void {
    clearTimeout(this.timer);
    const next = this.queue.nextAt();
    const wait = next === undefined ? IDLE_MS : Math.min(IDLE_MS, Math.max(0, next - Date.now()));
    this.timer = setTimeout(() => this.pump(), wait);
  }

  /** Hand one message to the handle and do what its answer says; a handle that throws is a retry with no wait. */
  private async handOut(kept: Kept): Promise<void> {
    let answer: Answer;
    try {
      answer = await this.handle(deliveryOf(kept));
    } catch {
      answer = { outcome: 'retry' };
    }
    this.settle(kept, answer);
  }

  /** Forget, redeliver or park one message as its answer says, and an acknowledgement lost as a redelivery. */
  private settle(kept: Kept, answer: Answer): void {
    if (answer.outcome === 'dead') this.queue.park(kept);
    else if (answer.outcome === 'retry') this.redeliver(kept, answer.backoffMs ?? 0);
    // an ack that never reached the broker: the message is handed out again at once, as after a lock expired
    else if (this.losesAck()) this.redeliver(kept, 0);
  }

  /** Put a message back to be delivered again, one attempt higher, no sooner than `afterMs` from now. */
  private redeliver(kept: Kept, afterMs: number): void {
    this.queue.put({ ...kept, attempt: kept.attempt + 1, availableAt: Date.now() + afterMs });
  }
}
