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
import { FakeClock, FakeLeases, FlakyLeases, serving, settle, trigger } from './harness.js';

const START = '2026-09-11T10:07:13.000Z';
/** The path the catchUp cases' trigger is written at: what names its schedule, and what a lease holds. */
const DIGEST = 'features/customers/edge/digest.trigger.json';
const RUN = '@customers/domain/customer.port.json#digest';

describe('a lease decides who fires', () => {
  /** Two schedulers over one set of lease records, as two instances of one tree are. */
  function two(settings: Record<string, unknown> = { everyMs: 60_000 }, ttlMs = 30_000) {
    const clock = new FakeClock(START);
    const keeper = new FakeLeases(clock, 'one');
    const other = keeper.as('two');
    // both processes serve the same document at the same path: one schedule, contended for by two
    const first = serving([trigger(settings, RUN, DIGEST)]);
    const second = serving([trigger(settings, RUN, DIGEST)]);
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
    const held = serving([trigger({ everyMs: 60_000 }, RUN, DIGEST)], () => ({ hold: true }));
    const idle = serving([trigger({ everyMs: 60_000 }, RUN, DIGEST)]);
    const lease = { connection: '@connections/store.connection.json', ttlMs: 2000 };
    const mine = new Scheduler({ serving: held.serving, clock, lease: { ...lease, keeper } });
    const theirs = new Scheduler({ serving: idle.serving, clock, lease: { ...lease, keeper: other } });
    mine.start();
    theirs.start();
    await clock.advance(60_000);
    expect(held.fired.length + idle.fired.length).toBe(1);
    expect(held.fired).toHaveLength(1); // the holder is the one whose run is held: it took the tick
    const tick = held.fired[0].scheduled;
    const renewals = () => keeper.acquires.filter(one => one.holder === 'one' && one.scheduled === tick).length;
    const before = renewals();
    // the run is still in flight, far past the 2s ttl. The hold is renewed through the clock while it runs...
    await clock.advance(120_000);
    expect(renewals()).toBeGreaterThan(before);
    // ...so the record still names the holder, and its expiry is always ahead of now: the other cannot take it
    const record = keeper.held.get(DIGEST) as { holder?: string; until?: number };
    expect(record.holder).toBe('one');
    expect(record.until).toBeGreaterThan(clock.now());
    // and the other scheduler, which asked for that tick throughout, was refused every time
    const theirAsks = keeper.acquires.filter(one => one.holder === 'two' && one.scheduled === tick);
    expect(theirAsks.length).toBeGreaterThan(0);
    expect(theirAsks.every(one => !one.granted)).toBe(true);
    expect(idle.fired).toHaveLength(0); // the other never ran the tick the holder held
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
    const served = serving([trigger(settings, RUN, DIGEST)]);
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
    const one = withLease({ everyMs: 60_000, catchUp: true }, async keeper => {
      // the last tick fired was 10:04; 10:05 and 10:06 fell while nothing ran, and 10:07 is the most recent
      await keeper.markFired('@connections/store.connection.json', DIGEST, '2026-09-11T10:04:00.000Z');
    });
    const { scheduler } = await one.start();
    expect(one.fired).toHaveLength(1);
    expect(one.fired[0].scheduled).toBe('2026-09-11T10:07:00.000Z');
    expect(one.fired[0].missed).toBe(2);
    await scheduler.stop();
  });

  it('catchUp absent: the tick that fell while nothing ran is not fired', async () => {
    const one = withLease({ everyMs: 60_000 }, async keeper => {
      await keeper.markFired('@connections/store.connection.json', DIGEST, '2026-09-11T10:04:00.000Z');
    });
    const { scheduler } = await one.start();
    expect(one.fired).toHaveLength(0);
    await scheduler.stop();
  });

  it('catchUp reaches back past a day: a weekly tick missed while nothing ran is still caught up', async () => {
    // a Monday-morning schedule, last fired three weeks ago. Looking a fixed day back would find nothing and
    // the tick would never be caught up, though the kind's description says it is
    const clock = new FakeClock('2026-09-16T09:00:00.000Z'); // a Wednesday
    const served = serving([trigger({ cron: '0 6 * * mon', catchUp: true }, RUN, DIGEST)]);
    const keeper = new FakeLeases(clock);
    await keeper.markFired('@connections/store.connection.json', DIGEST, '2026-08-24T06:00:00.000Z');
    const scheduler = new Scheduler({
      serving: served.serving,
      clock,
      lease: { keeper, connection: '@connections/store.connection.json', ttlMs: 30_000 },
    });
    scheduler.start();
    await settle();
    expect(served.fired).toHaveLength(1);
    // the most recent Monday 06:00 at or before now, not the one three weeks back
    expect(served.fired[0].scheduled).toBe('2026-09-14T06:00:00.000Z');
    expect(served.fired[0].missed).toBe(2); // the Mondays of the 31st and the 7th fell while nothing ran
    await scheduler.stop();
  });

  it('catchUp with nothing remembered fires nothing: a scheduler that cannot know what it missed does not pretend', async () => {
    const one = withLease({ everyMs: 60_000, catchUp: true });
    const { scheduler } = await one.start();
    expect(one.fired).toHaveLength(0);
    await scheduler.stop();
  });
});

describe('a keeper that throws is a bad moment, not the end of the schedule', () => {
  /** A scheduler over a keeper that throws once from one of its methods, and a clock a case steps. */
  function flaky(method: 'acquire' | 'markFired' | 'release' | 'lastFired') {
    const clock = new FakeClock(START);
    const served = serving([trigger({ everyMs: 60_000 }, RUN, DIGEST)]);
    const keeper = new FlakyLeases(new FakeLeases(clock), method);
    const scheduler = new Scheduler({
      serving: served.serving,
      clock,
      lease: { keeper, connection: '@connections/store.connection.json', ttlMs: 30_000 },
    });
    scheduler.start();
    return { clock, scheduler, ...served };
  }

  it('acquire throwing lets its tick go, and the loop fires the ticks after it', async () => {
    const one = flaky('acquire');
    await one.clock.advance(60_000); // the first tick asks, and the keeper throws
    expect(one.fired).toHaveLength(0); // that tick is let go, not fired
    expect(one.logs.some(line => line.includes('the lease keeper refused'))).toBe(true);
    // the loop is alive: the next two ticks ask again, are granted, and fire
    await one.clock.advance(120_000);
    expect(one.fired.map(each => each.scheduled)).toEqual(['2026-09-11T10:09:00.000Z', '2026-09-11T10:10:00.000Z']);
    await one.scheduler.stop();
  });

  it('markFired throwing after a run leaves the loop scheduling, and says the hold was not settled', async () => {
    const one = flaky('markFired');
    await one.clock.advance(60_000); // the tick fires, and settling it throws
    expect(one.fired).toHaveLength(1);
    expect(one.logs.some(line => line.includes('did not settle it'))).toBe(true);
    await one.clock.advance(120_000); // and the schedule goes on
    expect(one.fired).toHaveLength(3);
    await one.scheduler.stop();
  });

  it('lastFired throwing at a start catches nothing up and still schedules the ordinary ticks', async () => {
    const clock = new FakeClock(START);
    const served = serving([trigger({ everyMs: 60_000, catchUp: true }, RUN, DIGEST)]);
    const keeper = new FlakyLeases(new FakeLeases(clock), 'lastFired');
    const scheduler = new Scheduler({
      serving: served.serving,
      clock,
      lease: { keeper, connection: '@connections/store.connection.json', ttlMs: 30_000 },
    });
    scheduler.start();
    await settle();
    expect(served.fired).toHaveLength(0); // nothing was caught up: the keeper could not say
    expect(served.logs.some(line => line.includes('not caught up'))).toBe(true);
    await clock.advance(60_000);
    expect(served.fired).toHaveLength(1); // and the ordinary tick still fired
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
