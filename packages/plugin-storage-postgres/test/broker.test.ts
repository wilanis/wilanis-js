/**
 * The table broker, against a real database. What every broker must answer is not restated here: it is
 * @queue's shared suite, run against this broker, the same list the memory broker runs. What is here is what
 * only a broker kept in a shared table has: two workers over one table never take one message, a lock a worker
 * never gave back expires into a redelivery, and a publish inside a transaction is kept exactly when the
 * transaction commits -- the one a store call on the same connection opened, or one it opened itself.
 *
 * It needs a database, so the database cases are skipped without `WILANIS_TEST_POSTGRES_URL`, as the engine's
 * suite is (`engine.test.ts` says how to run one). That the plugin registers its broker needs none.
 */
import { randomUUID } from 'node:crypto';
import type { Atomic, Participant } from '@wilanis/core';
import { brokers, type Delivery } from '@wilanis/plugin-queue';
import { cases } from '@wilanis/plugin-queue/suite';
import { engines, type Transaction } from '@wilanis/plugin-storage';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TableBroker } from '../src/broker.js';
import { PostgresEngine } from '../src/engine.js';
import plugin from '../src/index.js';
import { closePools, poolFor } from '../src/pool.js';

const url = process.env.WILANIS_TEST_POSTGRES_URL;
const KIND = '@storage-postgres/postgres.connection-kind.json';
const CONNECTION = '@connections/records.connection.json';
const env = { connections: { [CONNECTION]: { kind: KIND, settings: { url } } } };

/** A broker as one process would hold it: its own engine, its own listening session. */
const brokerOf = (settings = {}, over: object = env) => new TableBroker(over, settings, new PostgresEngine(settings));
const made: TableBroker[] = [];
/** A broker closed after every case, so no listening session outlives the file. */
function kept(settings = {}, over: object = env): TableBroker {
  const broker = brokerOf(settings, over);
  made.push(broker);
  return broker;
}

/** A queue no other case names. */
const fresh = () => `q_${randomUUID().slice(0, 8)}`;
const pause = (ms: number) => new Promise(done => setTimeout(done, ms));

/** Wait until a condition holds, looking every few milliseconds, and fail naming what never came. */
async function until(ok: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 5000;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`waited for ${what}`);
    await pause(5);
  }
}

/** Consume one queue with `answer`, keeping every delivery seen. */
async function consuming(broker: TableBroker, queue: string, answer: (one: Delivery) => Promise<'ack' | 'retry'>) {
  const seen: Delivery[] = [];
  const stop = await broker.consume(
    CONNECTION,
    queue,
    async one => {
      seen.push(one);
      return { outcome: await answer(one) };
    },
    { concurrency: 1 },
  );
  return { seen, stop };
}

/** The atomic scope a graph's run carries, cut to what a broker and a store reach: one transaction, joined. */
class OneTransaction implements Atomic {
  opening?: Promise<Participant>;
  join<T extends Participant>(_connection: string, open: () => Promise<T>): Promise<T> {
    this.opening ??= open();
    return this.opening as Promise<T>;
  }
  async settle(commit: boolean): Promise<void> {
    const participant = await this.opening;
    await (commit ? participant?.commit() : participant?.rollback());
  }
}

afterAll(async () => {
  await Promise.all(made.map(one => one.close()));
  if (url) await closePools();
});

describe('the broker this engine registers', () => {
  it('is registered from postLoad under the kind it grants, beside the engine, and opens nothing', async () => {
    const tree = { connections: {} };
    const down = await plugin.postLoad?.({ env: tree, settings: {}, scope: { canon: (ref: string) => ref } } as never);
    expect(brokers(tree).for(KIND)).toBeInstanceOf(TableBroker);
    expect(engines(tree).for(KIND)).toBeInstanceOf(PostgresEngine);
    if (typeof down === 'function') await down();
  });
});

describe.skipIf(!url)('what every broker answers alike', () => {
  const broker = kept();
  beforeAll(() => broker.ensure(CONNECTION));
  const subject = { broker, connection: CONNECTION, parked: (queue: string) => broker.parked(CONNECTION, queue) };
  for (const one of cases) it(one.name, () => one.run(subject), 10_000);
});

describe.skipIf(!url)('a queue kept in a table several workers share', () => {
  beforeAll(() => kept().ensure(CONNECTION));

  it('hands each message to one worker of two, never to both', async () => {
    const queue = fresh();
    const publisher = kept();
    for (let nth = 0; nth < 20; nth++) await publisher.publish(CONNECTION, queue, { body: { nth }, headers: {} });
    const answer = async () => {
      await pause(5);
      return 'ack' as const;
    };
    const one = await consuming(kept(), queue, answer);
    const two = await consuming(kept(), queue, answer);
    try {
      await until(() => one.seen.length + two.seen.length === 20, 'twenty deliveries');
      await pause(100);
      const ids = [...one.seen, ...two.seen].map(seen => seen.id);
      expect(new Set(ids).size).toBe(20);
      expect(ids).toHaveLength(20);
    } finally {
      await Promise.all([one.stop(), two.stop()]);
    }
  });

  it('delivers again, one attempt higher, a message whose worker never answered once its lock expires', async () => {
    const queue = fresh();
    const { id } = await kept().publish(CONNECTION, queue, { body: {}, headers: {} });
    let letGo: () => void = () => {};
    const stuck = await consuming(
      kept({ queueVisibility: 0.2 }),
      queue,
      () =>
        new Promise(done => {
          letGo = () => done('ack');
        }),
    );
    await until(() => stuck.seen.length === 1, 'the first delivery');
    const taker = await consuming(kept({ queueVisibility: 0.2 }), queue, async () => 'ack');
    try {
      await until(() => taker.seen.length === 1, 'the delivery after the lock expired');
      expect(taker.seen.map(one => [one.id, one.attempt])).toEqual([[id, 2]]);
    } finally {
      letGo();
      await Promise.all([stuck.stop(), taker.stop()]);
    }
  });

  it('says which step is missing where ensure never made the table', async () => {
    // a connection of its own, since a pool is one per connection and the schema is the pool's
    const schema = `s_${randomUUID().slice(0, 8)}`;
    const Bare = `@connections/${schema}.connection.json`;
    const bare = { connections: { [Bare]: { kind: KIND, settings: { url, schema } } } };
    const { db } = poolFor({ connection: CONNECTION, kind: KIND, settings: { url } }, {});
    await sql`create schema ${sql.ref(schema)}`.execute(db);
    try {
      const broker = kept({}, bare);
      await expect(broker.publish(Bare, 'q', { body: {}, headers: {} })).rejects.toThrow(/queue\.port\.json#ensure/);
      await expect(broker.consume(Bare, 'q', async () => ({ outcome: 'ack' }), { concurrency: 1 })).rejects.toThrow(
        /no queue table/,
      );
      await broker.ensure(Bare);
      await expect(broker.publish(Bare, 'q', { body: {}, headers: {} })).resolves.toHaveProperty('id');
    } finally {
      await sql`drop schema ${sql.ref(schema)} cascade`.execute(db);
    }
  });
});

describe.skipIf(!url)('a publish inside a transaction', () => {
  beforeAll(() => kept().ensure(CONNECTION));
  const on = { connection: CONNECTION, kind: KIND, settings: { url } };

  /** Whether a message on the queue is delivered within a short wait. */
  async function delivered(queue: string): Promise<Delivery[]> {
    const consumed = await consuming(kept(), queue, async () => 'ack');
    await pause(200);
    await consumed.stop();
    return consumed.seen;
  }

  it('is kept once the transaction commits, and was not before', async () => {
    const queue = fresh();
    const atomic = new OneTransaction();
    const { id } = await kept().publish(CONNECTION, queue, { body: { id: 'golf' }, headers: {} }, atomic);
    expect(await delivered(queue)).toEqual([]);
    await atomic.settle(true);
    expect((await delivered(queue)).map(one => one.id)).toEqual([id]);
  });

  it('is gone once the transaction rolls back', async () => {
    const queue = fresh();
    const atomic = new OneTransaction();
    await kept().publish(CONNECTION, queue, { body: { id: 'golf' }, headers: {} }, atomic);
    await atomic.settle(false);
    expect(await delivered(queue)).toEqual([]);
  });

  it('joins the transaction a store call on the connection opened, and hands a later store call its own', async () => {
    const queue = fresh();
    const engine = new PostgresEngine({});
    const atomic = new OneTransaction();
    const opened = await atomic.join<Transaction>(CONNECTION, () => engine.begin(on));
    await kept().publish(CONNECTION, queue, { body: {}, headers: {} }, atomic);
    expect(await atomic.join<Transaction>(CONNECTION, () => engine.begin(on))).toBe(opened);
    await atomic.settle(false);
    expect(await delivered(queue)).toEqual([]);

    const first = new OneTransaction();
    await kept().publish(CONNECTION, queue, { body: {}, headers: {} }, first);
    const joined = await first.join<Transaction>(CONNECTION, () => engine.begin(on));
    expect(joined.engine).toBeInstanceOf(PostgresEngine);
    await first.settle(true);
    expect(await delivered(queue)).toHaveLength(1);
  });
});
