/**
 * What every broker must answer alike, as cases a package exports and a broker's tests import -- so that "this
 * is a broker" has one meaning, and it is executable. No test framework is named here: a case is a name and a
 * function, and a broker's test file turns each into whatever `it` it has.
 *
 *   import { cases } from '@wilanis/plugin-queue/suite';
 *   for (const one of cases) it(one.name, () => one.run(subject));
 *
 * The cases are what the worker relies on: a message published is delivered with what was published beside
 * it; an ack forgets it; a retry delivers it again, one attempt higher and no sooner than asked; a dead one is
 * parked and never delivered again; a handle that throws loses nothing; concurrency bounds what is in flight;
 * a stop drains. Each keeps its messages on a queue of its own, so a broker that really persists them can run
 * the whole suite against one store without the cases reaching each other. The waits are real time, and
 * short: a broker that polls is expected to look again within a few tens of milliseconds.
 */
import { strict as assert } from 'node:assert';
import { type Case, consuming, Gate, pause, queueFor, until } from './suite-fixture.js';

export type { Case, Subject } from './suite-fixture.js';

/** Publishing, and the plainest consuming: delivered once, as published, and forgotten on an ack. */
const deliveryCases: Case[] = [
  {
    name: 'a message published is delivered once, with its id, body and headers, as attempt 1',
    async run(subject) {
      const queue = queueFor('publish');
      const body = { id: 'golf', tags: ['a', 'b'], count: 3 };
      const headers = { authorization: 'Bearer abc', traceparent: '00-1-2-01' };
      const { id } = await subject.broker.publish(subject.connection, queue, { body, headers });
      assert.equal(typeof id, 'string');
      const consumed = await consuming(subject, queue, () => ({ outcome: 'ack' }));
      try {
        await until(() => consumed.seen.length === 1, 'the message');
        const [seen] = consumed.seen;
        assert.deepEqual(
          { id: seen.id, attempt: seen.attempt, body: seen.body, headers: seen.headers },
          {
            id,
            attempt: 1,
            body,
            headers,
          },
        );
        await pause(150);
        assert.equal(consumed.seen.length, 1, 'an acknowledged message is not delivered again');
      } finally {
        await consumed.stop();
      }
    },
  },
  {
    name: 'every message published is delivered, each under an id of its own',
    async run(subject) {
      const queue = queueFor('many');
      const ids: string[] = [];
      for (const nth of [1, 2, 3])
        ids.push((await subject.broker.publish(subject.connection, queue, { body: { nth }, headers: {} })).id);
      assert.equal(new Set(ids).size, 3);
      const consumed = await consuming(subject, queue, () => ({ outcome: 'ack' }));
      try {
        await until(() => consumed.seen.length === 3, 'three messages');
        assert.deepEqual(consumed.seen.map(one => one.id).sort(), [...ids].sort());
        assert.deepEqual(consumed.seen.map(one => (one.body as { nth: number }).nth).sort(), [1, 2, 3]);
      } finally {
        await consumed.stop();
      }
    },
  },
  {
    name: 'a message published while the queue is consumed is delivered too',
    async run(subject) {
      const queue = queueFor('live');
      const consumed = await consuming(subject, queue, () => ({ outcome: 'ack' }));
      try {
        const { id } = await subject.broker.publish(subject.connection, queue, { body: 'late', headers: {} });
        await until(() => consumed.seen.length === 1, 'the message published after consuming began');
        assert.equal(consumed.seen[0].id, id);
      } finally {
        await consumed.stop();
      }
    },
  },
  {
    name: 'a message published with delayMs is not delivered before it',
    async run(subject) {
      const queue = queueFor('delay');
      const published = Date.now();
      await subject.broker.publish(subject.connection, queue, { body: {}, headers: {}, delayMs: 120 });
      const consumed = await consuming(subject, queue, () => ({ outcome: 'ack' }));
      try {
        await until(() => consumed.seen.length === 1, 'the delayed message');
        assert.ok(
          consumed.seen[0].at - published >= 115,
          `delivered ${consumed.seen[0].at - published}ms after publishing`,
        );
      } finally {
        await consumed.stop();
      }
    },
  },
  {
    name: 'ensure prepares the connection, and asking again changes nothing',
    async run(subject) {
      await subject.broker.ensure(subject.connection);
      await subject.broker.ensure(subject.connection);
    },
  },
];

/** What the answer to a delivery makes of the message: delivered again, parked, or kept when the handle broke. */
const outcomeCases: Case[] = [
  {
    name: 'a retry is delivered again under the same id, one attempt higher, and no sooner than its backoff',
    async run(subject) {
      const queue = queueFor('retry');
      const { id } = await subject.broker.publish(subject.connection, queue, { body: {}, headers: {} });
      const consumed = await consuming(subject, queue, delivery =>
        delivery.attempt < 3 ? { outcome: 'retry', backoffMs: 60 * delivery.attempt } : { outcome: 'ack' },
      );
      try {
        await until(() => consumed.seen.length === 3, 'three deliveries of one message');
        assert.deepEqual(
          consumed.seen.map(one => [one.id, one.attempt]),
          [
            [id, 1],
            [id, 2],
            [id, 3],
          ],
        );
        const [first, second, third] = consumed.seen.map(one => one.at);
        assert.ok(second - first >= 55, `the second delivery came ${second - first}ms after the first, asked 60`);
        assert.ok(third - second >= 115, `the third delivery came ${third - second}ms after the second, asked 120`);
        await pause(150);
        assert.equal(consumed.seen.length, 3, 'the acknowledged delivery is the last');
      } finally {
        await consumed.stop();
      }
    },
  },
  {
    name: 'a dead message is parked, and never delivered again',
    async run(subject) {
      const queue = queueFor('dead');
      const { id } = await subject.broker.publish(subject.connection, queue, { body: { why: 'no' }, headers: {} });
      const consumed = await consuming(subject, queue, () => ({ outcome: 'dead' }));
      try {
        await until(() => consumed.seen.length === 1, 'the message');
        await pause(150);
        assert.equal(consumed.seen.length, 1, 'a dead message is not delivered again');
      } finally {
        await consumed.stop();
      }
      assert.deepEqual(await subject.parked(queue), [{ id, body: { why: 'no' } }]);
    },
  },
  {
    name: 'a handle that throws loses nothing: the message is delivered again',
    async run(subject) {
      const queue = queueFor('throws');
      const { id } = await subject.broker.publish(subject.connection, queue, { body: {}, headers: {} });
      const consumed = await consuming(subject, queue, delivery => {
        if (delivery.attempt === 1) throw new Error('the worker broke');
        return { outcome: 'ack' };
      });
      try {
        await until(() => consumed.seen.length === 2, 'a second delivery');
        assert.deepEqual(
          consumed.seen.map(one => [one.id, one.attempt]),
          [
            [id, 1],
            [id, 2],
          ],
        );
      } finally {
        await consumed.stop();
      }
    },
  },
];

/** How many run at once, and what a stop waits for. */
const flowCases: Case[] = [
  {
    name: 'no more messages are in flight at once than concurrency allows',
    async run(subject) {
      const queue = queueFor('concurrency');
      for (const nth of [1, 2, 3, 4])
        await subject.broker.publish(subject.connection, queue, { body: { nth }, headers: {} });
      const gate = new Gate();
      const consumed = await consuming(
        subject,
        queue,
        async () => {
          await gate.hold();
          return { outcome: 'ack' };
        },
        2,
      );
      try {
        await until(() => gate.held === 2, 'two deliveries in flight');
        await pause(100);
        assert.equal(gate.held, 2, 'a third was handed out while two were in flight');
        gate.release();
        await until(() => gate.held === 2, 'the next two deliveries');
        gate.release();
        await until(() => consumed.seen.length === 4, 'all four messages');
        assert.equal(gate.most, 2);
      } finally {
        gate.release();
        await consumed.stop();
      }
    },
  },
  {
    name: 'a stop takes nothing more, and resolves once the delivery in flight has been answered',
    async run(subject) {
      const queue = queueFor('drain');
      const { id: first } = await subject.broker.publish(subject.connection, queue, { body: { nth: 1 }, headers: {} });
      const gate = new Gate();
      const consumed = await consuming(subject, queue, async () => {
        await gate.hold();
        return { outcome: 'ack' };
      });
      await until(() => gate.held === 1, 'the first delivery in flight');
      const { id: second } = await subject.broker.publish(subject.connection, queue, { body: { nth: 2 }, headers: {} });
      let stopped = false;
      const stopping = consumed.stop().then(() => {
        stopped = true;
      });
      await pause(100);
      assert.equal(stopped, false, 'the stop resolved while a delivery was still in flight');
      gate.release();
      await stopping;
      assert.deepEqual(
        consumed.seen.map(one => one.id),
        [first],
        'a message was taken after the stop began',
      );
      // the one in flight was acknowledged before the stop resolved: consuming again finds only the other
      const again = await consuming(subject, queue, () => ({ outcome: 'ack' }));
      try {
        await until(() => again.seen.length === 1, 'the message left on the queue');
        await pause(100);
        assert.deepEqual(
          again.seen.map(one => one.id),
          [second],
        );
      } finally {
        await again.stop();
      }
    },
  },
];

/** Everything a broker answers for: publishing and delivering, what an answer makes of a message, and the flow. */
export const cases: Case[] = [...deliveryCases, ...outcomeCases, ...flowCases];
