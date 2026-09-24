/**
 * The shared broker suite, run over the fake broker of these tests: it proves the suite itself -- every case can
 * pass, against a broker that does what the contract says -- before a real broker's tests import it. A case
 * that no broker could pass would otherwise be found first by the memory broker's author.
 *
 * The second block proves the suite bites: a broker wrong in one way fails the case about that way. A suite
 * that passes every broker says nothing about any of them.
 */
import { describe, expect, it } from 'vitest';
import type { Answer, Broker, Handle } from '../src/brokers.js';
import { cases } from '../src/suite.js';
import { FakeBroker } from './fake-broker.js';

const CONNECTION = '@connections/jobs.connection.json';

/** What a broker's tests hand the suite, over one fake. */
const subjectOf = (broker: Broker, fake: FakeBroker) => ({
  broker,
  connection: CONNECTION,
  parked: async (queue: string) => fake.parked(CONNECTION, queue),
});

describe('what every broker answers alike, over the fake broker', () => {
  const fake = new FakeBroker();
  const subject = subjectOf(fake, fake);
  for (const one of cases) it(one.name, () => one.run(subject), 10_000);
});

/** A broker that is the fake in every way but one: what it does with the worker's answer, or with a stop. */
function wrong(change: { answer?: (answer: Answer) => Answer; stop?: 'early' }) {
  const fake = new FakeBroker();
  const broker: Broker = {
    ensure: connection => fake.ensure(connection),
    publish: (connection, queue, message) => fake.publish(connection, queue, message),
    async consume(connection, queue, handle: Handle, opts) {
      const changed: Handle = async delivery => (change.answer ?? (answer => answer))(await handle(delivery));
      const stop = await fake.consume(connection, queue, changed, opts);
      if (change.stop !== 'early') return stop;
      return async () => {
        void stop();
      };
    },
  };
  return subjectOf(broker, fake);
}

const named = (fragment: string) => {
  const found = cases.find(one => one.name.includes(fragment));
  if (!found) throw new Error(`no case about ${fragment}`);
  return found;
};

describe('the suite bites', () => {
  it('a broker that redelivers at once, whatever the backoff, fails the retry case', async () => {
    const subject = wrong({ answer: answer => ({ outcome: answer.outcome }) });
    await expect(named('no sooner than its backoff').run(subject)).rejects.toThrow(/after the first, asked 60/);
  }, 10_000);

  it('a broker that delivers a dead message again fails the dead case', async () => {
    const subject = wrong({ answer: answer => (answer.outcome === 'dead' ? { outcome: 'retry' } : answer) });
    await expect(named('a dead message is parked').run(subject)).rejects.toThrow(/not delivered again/);
  }, 10_000);

  it('a broker whose stop does not wait for what is in flight fails the drain case', async () => {
    const subject = wrong({ stop: 'early' });
    await expect(named('a stop takes nothing more').run(subject)).rejects.toThrow(/resolved while a delivery/);
  }, 10_000);
});
