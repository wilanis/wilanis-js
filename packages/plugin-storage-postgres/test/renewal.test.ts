/**
 * A delivery's lock, held while its run goes on (#907), on a clock the test turns and over a table the test
 * stands in for, so it needs no database. A run longer than the window keeps its lock: every half window the
 * consumer extends it, and the beat stops once the run is answered, whatever the answer, before the answer is
 * kept. An extension that fails is said and tried again; it never stops the run.
 */
import type { Answer, Delivery } from '@wilanis/plugin-queue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TableConsumer } from '../src/consumer.js';
import type { Table, Taken } from '../src/queue-table.js';

const table = vi.hoisted(() => ({
  takeDue: vi.fn(),
  forget: vi.fn(async () => {}),
  park: vi.fn(async () => {}),
  release: vi.fn(async () => {}),
  untake: vi.fn(async () => {}),
  extend: vi.fn(async () => true),
}));
vi.mock('../src/queue-table.js', () => table);

const WINDOW = 1000;
const TABLE = { db: {}, schema: 'public' } as unknown as Table;
const taken = (id: string): Taken => ({ id, attempt: 1, headers: {}, body: { id } });
const listen = async () => async () => {};

/** A table whose first look takes `ids`, and whose later looks find nothing. */
function taking(...ids: string[]): void {
  table.takeDue.mockReset();
  table.takeDue.mockResolvedValueOnce({ taken: ids.map(taken) });
  table.takeDue.mockResolvedValue({ taken: [] });
}

/** A handle that answers each delivery after `ms` of the test's clock, as `answers` says (ack by default). */
function running(ms: number, answers: Record<string, () => Answer> = {}) {
  return (delivery: Delivery): Promise<Answer> =>
    new Promise((done, fail) => {
      setTimeout(() => {
        try {
          done(answers[delivery.id]?.() ?? { outcome: 'ack' });
        } catch (error) {
          fail(error);
        }
      }, ms);
    });
}

/** A consumer of one slot per delivery, over a window of `WINDOW`, saying failed extensions into `lines`. */
function consumerOf(handle: (delivery: Delivery) => Promise<Answer>, slots = 1, lines: string[] = []) {
  const log = (line: string) => lines.push(line);
  return new TableConsumer({ table: TABLE, queue: 'removals', visibilityMs: WINDOW, log }, handle, slots);
}

beforeEach(() => {
  vi.useFakeTimers();
  for (const one of Object.values(table)) one.mockClear();
  table.extend.mockReset();
  table.extend.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a run longer than the window', () => {
  it('extends its lock every half window while it runs, and not once it is answered', async () => {
    taking('long');
    const consumer = consumerOf(running(2.5 * WINDOW));
    await consumer.start(listen);
    await vi.advanceTimersByTimeAsync(2.5 * WINDOW);
    expect(table.extend.mock.calls.map(call => [call[1].id, call[2]])).toEqual([
      ['long', WINDOW],
      ['long', WINDOW],
      ['long', WINDOW],
      ['long', WINDOW],
    ]);
    expect(table.forget).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5 * WINDOW);
    expect(table.extend).toHaveBeenCalledTimes(4);
    await consumer.stop();
  });

  it('holds the answer until an extension under way has ended, so the extension never lands after it', async () => {
    taking('raced');
    let extended: (held: boolean) => void = () => {};
    table.extend.mockImplementationOnce(
      () =>
        new Promise(done => {
          extended = done;
        }),
    );
    const consumer = consumerOf(running(0.6 * WINDOW));
    await consumer.start(listen);
    await vi.advanceTimersByTimeAsync(0.6 * WINDOW);
    expect(table.extend).toHaveBeenCalledTimes(1);
    expect(table.forget).not.toHaveBeenCalled();
    extended(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(table.forget).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await consumer.stop();
  });
});

describe('an extension that does not hold', () => {
  it('is said, and tried again at the next beat, and the run goes on to its answer', async () => {
    taking('shaky');
    table.extend.mockRejectedValueOnce(new Error('connection reset'));
    const lines: string[] = [];
    const consumer = consumerOf(running(1.2 * WINDOW), 1, lines);
    await consumer.start(listen);
    await vi.advanceTimersByTimeAsync(1.2 * WINDOW);
    expect(table.extend).toHaveBeenCalledTimes(2);
    expect(lines).toEqual([
      'queue removals shaky attempt 1: the lock was not extended (connection reset); the run goes on',
    ]);
    expect(table.forget).toHaveBeenCalledTimes(1);
    await consumer.stop();
  });

  it('stops where the row is no longer this delivery’s, since another worker holds it now', async () => {
    taking('lost');
    table.extend.mockResolvedValueOnce(false);
    const consumer = consumerOf(running(2.5 * WINDOW));
    await consumer.start(listen);
    await vi.advanceTimersByTimeAsync(2.5 * WINDOW);
    expect(table.extend).toHaveBeenCalledTimes(1);
    await consumer.stop();
  });
});

describe('the beat ends with the delivery', () => {
  it('on a retry, a dead letter and a handle that throws, as on an ack', async () => {
    taking('later', 'never', 'broke');
    const answers: Record<string, () => Answer> = {
      later: () => ({ outcome: 'retry', backoffMs: 40 }),
      never: () => ({ outcome: 'dead' }),
      broke: () => {
        throw new Error('the worker broke');
      },
    };
    const consumer = consumerOf(running(0.7 * WINDOW, answers), 3);
    await consumer.start(listen);
    await vi.advanceTimersByTimeAsync(0.7 * WINDOW);
    expect(table.extend).toHaveBeenCalledTimes(3);
    expect(table.release).toHaveBeenCalledTimes(2);
    expect(table.park).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5 * WINDOW);
    expect(table.extend).toHaveBeenCalledTimes(3);
    await consumer.stop();
  });

  it('on a stop: the run being drained keeps its lock until it is answered, and no timer is left after', async () => {
    taking('draining');
    const consumer = consumerOf(running(1.2 * WINDOW));
    await consumer.start(listen);
    let stopped = false;
    const stopping = consumer.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(WINDOW);
    expect(stopped).toBe(false);
    expect(table.extend).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(0.2 * WINDOW);
    await stopping;
    expect(table.forget).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
