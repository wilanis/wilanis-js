/**
 * The table consumer, on a clock the test turns and over a table the test stands in for, so it needs no
 * database. What it must not do is look at its table on a beat of its own making: a consumer with every slot
 * busy and a message due has nothing to hand out until a delivery is answered, and the answer is what wakes it;
 * a consumer over an empty queue waits for a notification; and a timer is armed only for a message that will
 * fall due while a slot is free.
 */
import type { Answer, Delivery } from '@wilanis/plugin-queue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TableConsumer } from '../src/consumer.js';
import type { Looked, Table, Taken } from '../src/queue-table.js';

const table = vi.hoisted(() => ({
  takeDue: vi.fn(),
  forget: vi.fn(async () => {}),
  park: vi.fn(async () => {}),
  release: vi.fn(async () => {}),
  untake: vi.fn(async () => {}),
}));
vi.mock('../src/queue-table.js', () => table);

const TABLE = { db: {}, schema: 'public' } as unknown as Table;
const worked = { table: TABLE, queue: 'removals', visibilityMs: 30_000 };
const taken = (id: string): Taken => ({ id, attempt: 1, headers: {}, body: { id } });

/** A table whose looks answer, in turn, what `looks` lists, and nothing after. */
function answering(...looks: Looked[]): void {
  table.takeDue.mockReset();
  for (const look of looks) table.takeDue.mockResolvedValueOnce(look);
  table.takeDue.mockResolvedValue({ taken: [] });
}

/** A listen that hands the test the consumer's wake. */
function listening() {
  const heard = { wake: () => {}, stopped: false };
  const listen = async (wake: () => void) => {
    heard.wake = wake;
    return async () => {
      heard.stopped = true;
    };
  };
  return { heard, listen };
}

beforeEach(() => {
  vi.useFakeTimers();
  for (const one of Object.values(table)) one.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a saturated consumer', () => {
  it('arms no timer and does not look again while every slot is busy, and looks once a delivery is answered', async () => {
    answering({ taken: [taken('first')], nextMs: 0 }, { taken: [taken('second')] });
    let answer: (answer: Answer) => void = () => {};
    const seen: string[] = [];
    const handle = (delivery: Delivery): Promise<Answer> => {
      seen.push(delivery.id);
      if (delivery.id !== 'first') return Promise.resolve({ outcome: 'ack' });
      return new Promise(done => {
        answer = done;
      });
    };
    const consumer = new TableConsumer(worked, handle, 1);
    await consumer.start(listening().listen);
    try {
      expect(seen).toEqual(['first']);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(5000);
      expect(table.takeDue).toHaveBeenCalledTimes(1);
      answer({ outcome: 'ack' });
      await vi.advanceTimersByTimeAsync(1);
      expect(seen).toEqual(['first', 'second']);
      expect(table.forget).toHaveBeenCalledTimes(2);
    } finally {
      answer({ outcome: 'ack' });
      await consumer.stop();
    }
  });
});

describe('an idle consumer', () => {
  it('arms no timer over a queue with nothing waiting, and looks when a notification wakes it', async () => {
    answering({ taken: [] }, { taken: [taken('late')] });
    const seen: string[] = [];
    const { heard, listen } = listening();
    const consumer = new TableConsumer(
      worked,
      async delivery => {
        seen.push(delivery.id);
        return { outcome: 'ack' };
      },
      1,
    );
    await consumer.start(listen);
    try {
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(table.takeDue).toHaveBeenCalledTimes(1);
      heard.wake();
      await vi.advanceTimersByTimeAsync(1);
      expect(seen).toEqual(['late']);
    } finally {
      await consumer.stop();
    }
    expect(heard.stopped).toBe(true);
  });

  it('arms one timer for the soonest message, and looks when it falls due', async () => {
    answering({ taken: [], nextMs: 250 });
    const consumer = new TableConsumer(worked, async () => ({ outcome: 'ack' }), 2);
    await consumer.start(listening().listen);
    try {
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(249);
      expect(table.takeDue).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(table.takeDue).toHaveBeenCalledTimes(2);
    } finally {
      await consumer.stop();
    }
  });
});

describe('what the answer does to the table', () => {
  it('retries with the backoff asked, parks a dead one, and takes a handle that throws as a retry at once', async () => {
    answering({ taken: [taken('later'), taken('never'), taken('broke')] });
    const answers: Record<string, () => Answer> = {
      later: () => ({ outcome: 'retry', backoffMs: 40 }),
      never: () => ({ outcome: 'dead' }),
      broke: () => {
        throw new Error('the worker broke');
      },
    };
    const consumer = new TableConsumer(worked, async delivery => answers[delivery.id](), 3);
    await consumer.start(listening().listen);
    await consumer.stop();
    expect(table.release.mock.calls.map(call => [call[1].id, call[3]])).toEqual([
      ['later', 40],
      ['broke', 0],
    ]);
    expect(table.park.mock.calls.map(call => call[1].id)).toEqual(['never']);
  });
});

describe('a consumer the database fails', () => {
  it('fails its start where the first look fails, and listens no more', async () => {
    table.takeDue.mockReset();
    table.takeDue.mockRejectedValue(new Error('no table'));
    const { heard, listen } = listening();
    await expect(new TableConsumer(worked, async () => ({ outcome: 'ack' }), 1).start(listen)).rejects.toThrow(
      'no table',
    );
    expect(heard.stopped).toBe(true);
  });

  it('looks again after a pause that doubles to a bound when a later look fails', async () => {
    answering({ taken: [] });
    const { heard, listen } = listening();
    const consumer = new TableConsumer(worked, async () => ({ outcome: 'ack' }), 1);
    await consumer.start(listen);
    try {
      table.takeDue.mockRejectedValue(new Error('the database went away'));
      heard.wake();
      await vi.advanceTimersByTimeAsync(0);
      expect(table.takeDue).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1000);
      expect(table.takeDue).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1999);
      expect(table.takeDue).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(table.takeDue).toHaveBeenCalledTimes(4);
      await vi.advanceTimersByTimeAsync(120_000);
      const calls = table.takeDue.mock.calls.length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(table.takeDue.mock.calls.length - calls).toBe(1);
    } finally {
      await consumer.stop();
    }
  });
});

describe('a stop', () => {
  it('gives back what a look under way took, since nothing ran', async () => {
    answering({ taken: [] });
    const { heard, listen } = listening();
    const consumer = new TableConsumer(worked, async () => ({ outcome: 'ack' }), 1);
    await consumer.start(listen);
    let look: (looked: Looked) => void = () => {};
    table.takeDue.mockImplementationOnce(
      () =>
        new Promise(done => {
          look = done;
        }),
    );
    heard.wake();
    const stopping = consumer.stop();
    look({ taken: [taken('raced')] });
    await stopping;
    expect(table.untake.mock.calls.map(call => call[1].id)).toEqual(['raced']);
    expect(table.forget).not.toHaveBeenCalled();
  });
});
