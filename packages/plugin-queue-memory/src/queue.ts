/**
 * One queue of one connection, as the memory broker keeps it: the messages waiting, each with the moment it may
 * next be handed out, and the messages parked as dead. A message in flight is in neither list -- it was taken
 * from the waiting one and is put back, or parked, or forgotten, once its answer is known.
 *
 * A body is kept as the JSON text it was published as and decoded afresh on every delivery, so what a handle
 * does with the body it was given never reaches what is kept, and a body that would not survive a broker that
 * really encodes it does not survive this one either.
 */
import type { Delivery } from '@wilanis/plugin-queue';

/** One message as the queue keeps it: a delivery's id, attempt and headers, its body encoded, and when it is due. */
export interface Kept {
  id: string;
  attempt: number;
  headers: Record<string, string>;
  body: string;
  availableAt: number;
}

/** A message parked as dead, as an operator reads it back. */
export interface Parked {
  id: string;
  body: unknown;
}

/** One queue of one connection: what waits to be handed out, and what was parked as dead. */
export class MemoryQueue {
  private readonly waiting: Kept[] = [];
  private readonly dead: Kept[] = [];
  private readonly wakers = new Set<() => void>();

  /** Keep a message until it is taken, and wake whoever consumes this queue so it need not wait for its timer. */
  put(kept: Kept): void {
    this.waiting.push(kept);
    for (const wake of this.wakers) wake();
  }

  /** Take the first message that may be handed out now, out of the waiting list; nothing when none is due. */
  take(now: number): Kept | undefined {
    const index = this.waiting.findIndex(one => one.availableAt <= now);
    return index < 0 ? undefined : this.waiting.splice(index, 1)[0];
  }

  /** The soonest moment a message waiting here may be handed out, or nothing when none waits. */
  nextAt(): number | undefined {
    if (!this.waiting.length) return undefined;
    return Math.min(...this.waiting.map(one => one.availableAt));
  }

  /** Park a message where an operator can find it; it is never handed out again. */
  park(kept: Kept): void {
    this.dead.push(kept);
  }

  /** Be woken whenever a message is put here; answers the way to stop being woken. */
  onPut(wake: () => void): () => void {
    this.wakers.add(wake);
    return () => {
      this.wakers.delete(wake);
    };
  }

  /** What waits to be handed out, due or not, as a delivery of it would carry it. */
  queued(): Delivery[] {
    return this.waiting.map(deliveryOf);
  }

  /** What was parked as dead, in the order it was parked. */
  parked(): Parked[] {
    return this.dead.map(one => ({ id: one.id, body: JSON.parse(one.body) }));
  }
}

/** A kept message as a handle is given it: the body decoded afresh, the headers a copy of their own. */
export function deliveryOf(kept: Kept): Delivery {
  return { id: kept.id, attempt: kept.attempt, headers: { ...kept.headers }, body: JSON.parse(kept.body) };
}
