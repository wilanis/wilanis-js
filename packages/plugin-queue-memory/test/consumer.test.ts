/**
 * The consumer, on a clock the test turns. What it must not do is look at its queue on a beat of its own making:
 * a consumer with every slot busy and a message due has nothing to hand out until a delivery is answered, and
 * the answer is what wakes it, not a timer armed for a message it has no room for.
 */
import type { Answer, Delivery } from '@wilanis/plugin-queue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Consumer } from '../src/consumer.js';
import { MemoryQueue } from '../src/queue.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** A queue with one message due now for each name, in order. */
function queueOf(...names: string[]): MemoryQueue {
  const queue = new MemoryQueue();
  for (const name of names) {
    queue.put({ id: name, attempt: 1, headers: {}, body: JSON.stringify({ name }), availableAt: Date.now() });
  }
  return queue;
}

/** How many times the queue has been looked at so far: a message taken, or the soonest due asked for. */
function lookedAt(queue: MemoryQueue): () => number {
  const take = vi.spyOn(queue, 'take');
  const nextAt = vi.spyOn(queue, 'nextAt');
  return () => take.mock.calls.length + nextAt.mock.calls.length;
}

describe('a saturated consumer', () => {
  it('does not spin on a due message it has no room for, and hands it out as soon as a slot frees', async () => {
    const queue = queueOf('first', 'second');
    const looks = lookedAt(queue);
    const seen: string[] = [];
    let release: (answer: Answer) => void = () => {};
    const handle = (delivery: Delivery): Promise<Answer> => {
      seen.push(delivery.id);
      if (delivery.id !== 'first') return Promise.resolve({ outcome: 'ack' });
      return new Promise(done => {
        release = done;
      });
    };
    const consumer = new Consumer(queue, handle, 1, () => false);
    try {
      expect(seen).toEqual(['first']);
      const before = looks();
      await vi.advanceTimersByTimeAsync(50);
      expect(looks() - before).toBeLessThanOrEqual(2);
      expect(seen).toEqual(['first']);
      release({ outcome: 'ack' });
      await vi.advanceTimersByTimeAsync(1);
      expect(seen).toEqual(['first', 'second']);
    } finally {
      release({ outcome: 'ack' });
      await consumer.stop();
    }
  });
});
