/**
 * What a lease decides: which of several processes fires a tick, what a crash does to the hold it held,
 * and what catchUp fires at a start when the store remembers a tick that fell while nothing ran.
 *
 * Every case here runs two schedulers over one set of lease records, which is what two instances of one
 * tree behind a load balancer are. The fake keeper answers exactly as the contract says a real one must,
 * so a keeper written against this package can be held to the same cases.
 */
import { describe, expect, it } from 'vitest';
import { Scheduler } from '../src/scheduler.js';
import { FakeClock, FakeLeases, serving, settle, trigger } from './harness.js';

const START = '2026-09-11T10:07:13.000Z';

describe('a lease decides who fires', () => {
  /** Two schedulers over one set of lease records, as two instances of one tree are. */
  function two(settings: Record<string, unknown> = { everyMs: 60_000 }, ttlMs = 30_000) {
    const clock = new FakeClock(START);
    const keeper = new FakeLeases(clock, 'one');
    const other = keeper.as('two');
    const first = serving([trigger(settings)]);
    const second = serving([trigger(settings)]);
    const lease = { connection: '@connections/store.connection.json', ttlMs };
    const mine = new Scheduler({ serving: first.serving, clock, lease: { ...lease, keeper } });
    const theirs = new Scheduler({ serving: second.serving, clock, lease: { ...lease, keeper: other } });
    mine.start();
    theirs.start();
    return { clock, first, second, mine, theirs };
  }

  it('each tick is fired by exactly one of two schedulers', async () => {
    const { clock, first, second, mine, theirs } = two();
    await clock.advance(180_000);
    const ticks = [...first.fired, ...second.fired].map(each => each.scheduled);
    expect(new Set(ticks).size).toBe(ticks.length); // no tick fired twice
    expect(ticks.length).toBe(3);
    await mine.stop();
    await theirs.stop();
  });

  it('a tick already marked fired is granted to nobody, however late a clock asks for it', async () => {
    const clock = new FakeClock(START);
    const keeper = new FakeLeases(clock, 'slow');
    await keeper.markFired('@connections/store.connection.json', 'x', '2026-09-11T10:08:00.000Z');
    // the same tick, and an earlier one, are both refused; a later one is granted
    expect(await keeper.acquire('@connections/store.connection.json', 'x', '2026-09-11T10:08:00.000Z', 1000)).toBe(
      false,
    );
    expect(await keeper.acquire('@connections/store.connection.json', 'x', '2026-09-11T10:07:00.000Z', 1000)).toBe(
      false,
    );
    expect(await keeper.acquire('@connections/store.connection.json', 'x', '2026-09-11T10:09:00.000Z', 1000)).toBe(
      true,
    );
  });

  it("the holder's hold is renewed while its run is in flight, and the other never takes it meanwhile", async () => {
    const clock = new FakeClock(START);
    const keeper = new FakeLeases(clock, 'one');
    const other = keeper.as('two');
    const held = serving([trigger({ everyMs: 60_000 })], () => ({ hold: true }));
    const idle = serving([trigger({ everyMs: 60_000 })]);
    const lease = { connection: '@connections/store.connection.json', ttlMs: 2000 };
    const mine = new Scheduler({ serving: held.serving, clock, lease: { ...lease, keeper } });
    const theirs = new Scheduler({ serving: idle.serving, clock, lease: { ...lease, keeper: other } });
    mine.start();
    theirs.start();
    await clock.advance(60_000);
    expect(held.fired.length + idle.fired.length).toBe(1);
    const holder = held.fired.length ? held : idle;
    // the run is held past the ttl; the tick it holds is never taken by the other
    await clock.advance(120_000);
    const scheduledTwice = [...held.fired, ...idle.fired].filter(each => each.scheduled === holder.fired[0].scheduled);
    expect(scheduledTwice).toHaveLength(1);
    held.release();
    idle.release();
    await settle();
    await mine.stop();
    await theirs.stop();
    held.release();
  });
});

describe('catchUp, and the tick that fell while no process ran', () => {
  /** A scheduler over a lease whose records a case seeds, started at a known instant. */
  function withLease(settings: Record<string, unknown>, seed?: (keeper: FakeLeases) => Promise<void>) {
    const clock = new FakeClock('2026-09-11T10:07:13.000Z');
    const keeper = new FakeLeases(clock);
    const served = serving([trigger(settings)]);
    return {
      clock,
      keeper,
      ...served,
      async start() {
        if (seed) await seed(keeper);
        const scheduler = new Scheduler({
          serving: served.serving,
          clock,
          lease: { keeper, connection: '@connections/store.connection.json', ttlMs: 30_000 },
        });
        const answer = scheduler.start();
        await settle();
        return { scheduler, answer };
      },
    };
  }

  it('catchUp with a lastFired three ticks back: one immediate fire, scheduled the most recent tick, missed 2', async () => {
    const name = '@monitor/domain/monitor.port.json#digest @ every 60000 ms';
    const one = withLease({ everyMs: 60_000, catchUp: true }, async keeper => {
      // the last tick fired was 10:04; 10:05 and 10:06 fell while nothing ran, and 10:07 is the most recent
      await keeper.markFired('@connections/store.connection.json', name, '2026-09-11T10:04:00.000Z');
    });
    const { scheduler } = await one.start();
    expect(one.fired).toHaveLength(1);
    expect(one.fired[0].scheduled).toBe('2026-09-11T10:07:00.000Z');
    expect(one.fired[0].missed).toBe(2);
    await scheduler.stop();
  });

  it('catchUp absent: the tick that fell while nothing ran is not fired', async () => {
    const name = '@monitor/domain/monitor.port.json#digest @ every 60000 ms';
    const one = withLease({ everyMs: 60_000 }, async keeper => {
      await keeper.markFired('@connections/store.connection.json', name, '2026-09-11T10:04:00.000Z');
    });
    const { scheduler } = await one.start();
    expect(one.fired).toHaveLength(0);
    await scheduler.stop();
  });

  it('catchUp with nothing remembered fires nothing: a scheduler that cannot know what it missed does not pretend', async () => {
    const one = withLease({ everyMs: 60_000, catchUp: true });
    const { scheduler } = await one.start();
    expect(one.fired).toHaveLength(0);
    await scheduler.stop();
  });
});

describe('a crash lets the tick go', () => {
  it('a hold neither renewed nor marked is taken by the next process to ask, after the ttl', async () => {
    const clock = new FakeClock(START);
    const keeper = new FakeLeases(clock, 'dead');
    const other = keeper.as('alive');
    const connection = '@connections/store.connection.json';
    const tick = '2026-09-11T10:08:00.000Z';
    expect(await keeper.acquire(connection, 'x', tick, 2000)).toBe(true);
    // the holder dies: no renewal, no markFired. The other's ask is refused while the hold stands
    expect(await other.acquire(connection, 'x', tick, 2000)).toBe(false);
    clock.advance(3000); // past the ttl, with nothing renewed
    expect(await other.acquire(connection, 'x', tick, 2000)).toBe(true);
  });

  it('with markFired done before the stop, the tick is not run again', async () => {
    const clock = new FakeClock(START);
    const keeper = new FakeLeases(clock, 'done');
    const other = keeper.as('alive');
    const connection = '@connections/store.connection.json';
    const tick = '2026-09-11T10:08:00.000Z';
    await keeper.acquire(connection, 'x', tick, 2000);
    await keeper.markFired(connection, 'x', tick);
    clock.advance(3000);
    expect(await other.acquire(connection, 'x', tick, 2000)).toBe(false);
  });
});
