/**
 * The broker. What every broker must answer is not restated here -- it is @queue's shared suite, run against
 * this broker, which is what makes "this is a broker" one executable meaning rather than a promise in a README.
 * What is here is what only this broker has: the acknowledgement it can be told to lose, so at-least-once is
 * something a test can make happen, and what it keeps being its own and nobody else's.
 */
import type { Delivery } from '@wilanis/plugin-queue';
import { cases } from '@wilanis/plugin-queue/suite';
import { describe, expect, it } from 'vitest';
import { MemoryBroker } from '../src/index.js';

const CONNECTION = '@connections/jobs.connection.json';

describe('what every broker answers alike', () => {
  const broker = new MemoryBroker();
  const subject = { broker, connection: CONNECTION, parked: async (queue: string) => broker.parked(CONNECTION, queue) };
  for (const one of cases) it(one.name, () => one.run(subject), 10_000);
});

/** Wait until a condition holds, looking every few milliseconds, and fail naming what never came. */
async function until(ok: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 3000;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`waited for ${what}`);
    await new Promise(done => setTimeout(done, 5));
  }
}

/** Consume one queue, acknowledging every delivery, and keep what was seen. */
async function acking(broker: MemoryBroker, queue: string, connection = CONNECTION) {
  const seen: Delivery[] = [];
  const stop = await broker.consume(
    connection,
    queue,
    async delivery => {
      seen.push(delivery);
      return { outcome: 'ack' };
    },
    { concurrency: 1 },
  );
  return { seen, stop };
}

describe('at least once, on purpose', () => {
  it('an acknowledgement it is told to drop is lost: the message is delivered again, one attempt higher', async () => {
    const broker = new MemoryBroker();
    const { id } = await broker.publish(CONNECTION, 'removals', { body: { id: 'golf' }, headers: {} });
    broker.dropAcks();
    const consumed = await acking(broker, 'removals');
    try {
      await until(() => consumed.seen.length === 2, 'a redelivery');
      expect(consumed.seen.map(one => [one.id, one.attempt])).toEqual([
        [id, 1],
        [id, 2],
      ]);
      await new Promise(done => setTimeout(done, 100));
      expect(consumed.seen).toHaveLength(2);
      expect(broker.waiting(CONNECTION, 'removals')).toEqual([]);
    } finally {
      await consumed.stop();
    }
  });

  it('only as many acknowledgements as it was told are lost', async () => {
    const broker = new MemoryBroker();
    for (const nth of [1, 2]) await broker.publish(CONNECTION, 'removals', { body: { nth }, headers: {} });
    broker.dropAcks(1);
    const consumed = await acking(broker, 'removals');
    try {
      await until(() => consumed.seen.length === 3, 'two messages and one redelivery');
      await new Promise(done => setTimeout(done, 100));
      expect(consumed.seen.map(one => one.attempt).sort()).toEqual([1, 1, 2]);
    } finally {
      await consumed.stop();
    }
  });
});

describe('what it keeps is its own', () => {
  it('a body changed after it was published, or by the handle it was given to, is not what is kept', async () => {
    const broker = new MemoryBroker();
    const body = { id: 'golf', tags: ['a'] };
    await broker.publish(CONNECTION, 'removals', { body, headers: { authorization: 'Bearer abc' } });
    body.tags.push('b');
    const [waiting] = broker.waiting(CONNECTION, 'removals');
    (waiting.body as { tags: string[] }).tags.push('c');
    waiting.headers.authorization = 'Bearer other';
    expect(broker.waiting(CONNECTION, 'removals')[0]).toMatchObject({
      body: { id: 'golf', tags: ['a'] },
      headers: { authorization: 'Bearer abc' },
    });
  });

  it('a body is kept as JSON, so what JSON cannot carry does not arrive', async () => {
    const broker = new MemoryBroker();
    await broker.publish(CONNECTION, 'removals', { body: { id: 'golf', dropped: undefined }, headers: {} });
    expect(broker.waiting(CONNECTION, 'removals')[0].body).toEqual({ id: 'golf' });
  });

  it('a queue is its connection and its name: the same name on another connection is another queue', async () => {
    const broker = new MemoryBroker();
    await broker.publish(CONNECTION, 'removals', { body: { id: 'golf' }, headers: {} });
    const other = await acking(broker, 'removals', '@connections/other.connection.json');
    try {
      await new Promise(done => setTimeout(done, 50));
      expect(other.seen).toEqual([]);
      expect(broker.waiting(CONNECTION, 'removals')).toHaveLength(1);
    } finally {
      await other.stop();
    }
  });
});
