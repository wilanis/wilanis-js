/**
 * The loop, over a fake clock. Every case steps the clock rather than waiting on one, so the suite answers in
 * milliseconds and says exactly which instant a tick fell on -- which is what a schedule is about.
 *
 * What is asserted here is the RFC's table: when a tick fires, what the context says, what overlap does with
 * a run that outlasts its interval, what a lease decides when two processes both name a tick, and what a stop
 * drains.
 */
import { describe, expect, it } from 'vitest';
import { Scheduler } from '../src/scheduler.js';
import { FakeClock, serving, settle, trigger } from './harness.js';

const START = '2026-09-11T10:07:13.000Z';

/** A scheduler over a fake clock, started, with the triggers and the answering a case asks for. */
function started(
  triggers: Parameters<typeof serving>[0],
  opts: Parameters<typeof serving>[1] = () => ({}),
  start = START,
) {
  const clock = new FakeClock(start);
  const served = serving(triggers, opts);
  const scheduler = new Scheduler({ serving: served.serving, clock });
  const answer = scheduler.start();
  return { clock, ...served, scheduler, answer };
}

describe('a trigger fires at the instant its schedule names', () => {
  it('a cron trigger fires at its tick, scheduled the tick and fired the clock now', async () => {
    const one = started([trigger({ cron: '0 11 * * *', timezone: 'UTC' })]);
    await settle();
    expect(one.fired).toHaveLength(0);
    await one.clock.advance(53 * 60_000); // 10:07:13 → 11:00:13, past 11:00
    expect(one.fired).toHaveLength(1);
    expect(one.fired[0].scheduled).toBe('2026-09-11T11:00:00.000Z');
    expect(one.fired[0].fired).toBe('2026-09-11T11:00:00.000Z');
    await one.scheduler.stop();
  });

  it('an interval trigger fires at the next multiple of the epoch, then the one after', async () => {
    const one = started([trigger({ everyMs: 60_000 })]);
    await one.clock.advance(60_000); // 10:07:13 → 10:08:13, past 10:08:00
    expect(one.fired.map(each => each.scheduled)).toEqual(['2026-09-11T10:08:00.000Z']);
    await one.clock.advance(60_000);
    expect(one.fired.map(each => each.scheduled)).toEqual(['2026-09-11T10:08:00.000Z', '2026-09-11T10:09:00.000Z']);
    await one.scheduler.stop();
  });

  it('two schedulers started at different instants name the same tick instants', async () => {
    const early = started([trigger({ everyMs: 60_000 })], () => ({}), '2026-09-11T10:07:13.000Z');
    const late = started([trigger({ everyMs: 60_000 })], () => ({}), '2026-09-11T10:07:41.000Z');
    await early.clock.advance(120_000);
    await late.clock.advance(120_000);
    expect(early.fired.map(each => each.scheduled)).toEqual(late.fired.map(each => each.scheduled));
    await early.scheduler.stop();
    await late.scheduler.stop();
  });

  it('the run step answers how many triggers are scheduled and the earliest next tick', () => {
    const one = started([trigger({ everyMs: 60_000 }), trigger({ cron: '0 3 * * *' })]);
    expect(one.answer.triggers).toBe(2);
    expect(one.answer.next).toBe('2026-09-11T10:08:00.000Z');
    void one.scheduler.stop();
  });

  it('a tree with no scheduled trigger says so and schedules nothing', async () => {
    const one = started([]);
    expect(one.answer.triggers).toBe(0);
    expect(one.answer.next).toBeUndefined();
    expect(one.logs).toContain('schedule: no scheduled trigger in the tree');
    await one.clock.advance(10 * 60_000);
    expect(one.fired).toHaveLength(0);
    await one.scheduler.stop();
  });
});

describe('a run that outlasts its interval, as overlap says', () => {
  /** A schedule of one-second ticks whose run is held until the test lets it answer. */
  const running = (overlap?: string) =>
    started(
      [trigger({ everyMs: 1000, ...(overlap ? { overlap } : {}) })],
      () => ({ hold: true }),
      '2026-09-11T10:00:00.000Z',
    );

  it('skip: ticks that fall while the run is going are dropped and counted in missed', async () => {
    const one = running('skip');
    await one.clock.advance(1000); // tick 1 fires, and holds
    expect(one.fired).toHaveLength(1);
    for (let tick = 0; tick < 3; tick++) await one.clock.advance(1000); // 2, 3 and 4 fall while it runs
    expect(one.fired).toHaveLength(1);
    expect(one.logs.filter(line => line.includes('→ skipped'))).toHaveLength(3);
    one.release(); // the run ends
    await settle();
    await one.clock.advance(1000); // the next tick after it fires, and says how many were dropped
    expect(one.fired).toHaveLength(2);
    expect(one.fired[1].missed).toBe(3);
    one.release();
    await settle();
    await one.scheduler.stop();
    one.release();
  });

  it('concurrent: every tick fires beside the run already going', async () => {
    const one = running('concurrent');
    for (let tick = 0; tick < 4; tick++) await one.clock.advance(1000);
    expect(one.fired).toHaveLength(4); // none waited on another: four runs are in flight at once
    expect(one.logs.filter(line => line.includes('→ skipped'))).toHaveLength(0);
    for (const _ of one.fired) one.release();
    await settle();
    await one.scheduler.stop();
  });

  it('wait: one tick is kept back and fires as soon as the run ends; the rest are skipped', async () => {
    const one = running('wait');
    await one.clock.advance(1000);
    expect(one.fired).toHaveLength(1);
    for (let tick = 0; tick < 3; tick++) await one.clock.advance(1000); // one waits, the others are skipped
    expect(one.fired).toHaveLength(1);
    one.release(); // the first run ends, so the waiting tick fires
    await settle();
    expect(one.fired).toHaveLength(2);
    expect(one.fired[1].scheduled).toBe('2026-09-11T10:00:02.000Z');
    one.release();
    await settle();
    await one.scheduler.stop();
    one.release();
  });

  it('skip is the default, so a schedule that says nothing does not pile runs up', async () => {
    const one = running();
    for (let tick = 0; tick < 3; tick++) await one.clock.advance(1000);
    expect(one.fired).toHaveLength(1);
    one.release();
    await settle();
    await one.scheduler.stop();
  });

  it('concurrent: a tick counts as fired when it fires, so a later tick calls none of them missed', async () => {
    // the first run is held over the next two ticks and then answers; the ticks after it must not be told
    // that the ones which ran beside it were missed. Counting a tick as fired only when it *answers* would
    // leave state.lastFired back at the first tick and call everything since then dropped.
    let held = true;
    const one = started(
      [trigger({ everyMs: 1000, overlap: 'concurrent' })],
      () => ({ hold: held }),
      '2026-09-11T10:00:00.000Z',
    );
    await one.clock.advance(1000); // tick 1 fires, and is held
    held = false; // every later tick answers at once
    await one.clock.advance(1000); // tick 2 fires beside it and answers
    await one.clock.advance(1000); // tick 3 likewise
    one.release(); // now the long first run finally answers
    await settle();
    await one.clock.advance(1000); // tick 4: the three before it all ran, so none of them was missed
    expect(one.fired).toHaveLength(4);
    expect(one.fired.map(each => each.missed)).toEqual([0, 0, 0, 0]);
    await one.scheduler.stop();
  });

  it('wait: a tick kept back is let go rather than fired behind a stop that has begun', async () => {
    const one = running('wait');
    await one.clock.advance(1000); // tick 1 fires and holds
    await one.clock.advance(1000); // tick 2 is kept back, waiting on it
    expect(one.fired).toHaveLength(1);
    const stopping = one.scheduler.stop();
    await settle();
    one.release(); // the run answers; the waiting tick must not start now, with the stop already decided
    await stopping;
    expect(one.fired).toHaveLength(1);
    await one.clock.advance(5000);
    expect(one.fired).toHaveLength(1);
  });
});

describe('missed, and what a start knows', () => {
  it('the first tick after a start has missed 0: nothing is known before the start', async () => {
    const one = started([trigger({ everyMs: 60_000 })]);
    await one.clock.advance(60_000);
    expect(one.fired[0].missed).toBe(0);
    await one.scheduler.stop();
  });

  it('every tick fired in turn has missed 0: none was dropped', async () => {
    const one = started([trigger({ everyMs: 60_000 })]);
    await one.clock.advance(180_000);
    expect(one.fired.map(each => each.missed)).toEqual([0, 0, 0]);
    await one.scheduler.stop();
  });
});

describe('what a reload puts behind the scheduler', () => {
  it('a trigger added is fired and one removed is not, at the next wake-up', async () => {
    const digest = trigger({ everyMs: 60_000 }, '@customers/domain/customer.port.json#digest');
    const sweep = trigger({ everyMs: 60_000 }, '@customers/domain/customer.port.json#sweep');
    const one = started([digest]);
    await one.clock.advance(60_000);
    expect(one.fired.map(each => each.run)).toEqual(['@customers/domain/customer.port.json#digest']);
    one.reloadWith([sweep]); // the tree is replaced underneath, as a reload does
    // the next wake-up reads the new set: the removed trigger's tick is not fired, and the new one's is
    await one.clock.advance(120_000);
    expect(one.fired.map(each => each.run)).toEqual([
      '@customers/domain/customer.port.json#digest',
      '@customers/domain/customer.port.json#sweep',
    ]);
    await one.scheduler.stop();
  });
});

describe('a stop drains', () => {
  it('stop resolves after the run in flight has answered, and no tick fires after it began', async () => {
    const one = started([trigger({ everyMs: 1000 })], () => ({ hold: true }), '2026-09-11T10:00:00.000Z');
    await one.clock.advance(1000);
    expect(one.fired).toHaveLength(1);
    let stopped = false;
    const stopping = one.scheduler.stop().then(() => {
      stopped = true;
    });
    await settle();
    expect(stopped).toBe(false); // the run has not answered, so the stop has not
    one.release();
    await stopping;
    expect(stopped).toBe(true);
    await one.clock.advance(5000);
    expect(one.fired).toHaveLength(1); // nothing fires after a stop began
  });
});

describe('a tick opens a blob scope of its own and releases it once the run has answered', () => {
  it('one scope per tick, released', async () => {
    const one = started([trigger({ everyMs: 60_000 })]);
    await one.clock.advance(120_000);
    expect(one.blobs.scopes).toBe(2);
    expect(one.blobs.released).toBe(2);
    await one.scheduler.stop();
  });
});

describe('what a tick is logged as', () => {
  it('an answer is logged with the tick it was for and what it answered', async () => {
    const one = started([trigger({ everyMs: 60_000 })]);
    await one.clock.advance(60_000);
    const line = one.logs.find(each => each.includes('2026-09-11T10:08:00.000Z') && each.includes('→ done'));
    expect(line).toBeDefined();
    expect(line).toContain('{"ok":true}');
    await one.scheduler.stop();
  });

  it('a refusal is logged with its reason, since there is nobody to answer', async () => {
    const one = started([trigger({ everyMs: 60_000 })], () => ({
      report: {
        status: 'failed',
        nodes: { asked: { status: 'failed', reason: 'missing', error: 'no entry' } as never },
      },
    }));
    await one.clock.advance(60_000);
    expect(one.logs.some(line => line.includes('→ refused missing (no entry)'))).toBe(true);
    await one.scheduler.stop();
  });

  it('a fault is logged as failed and the loop goes on to the next tick', async () => {
    const one = started([trigger({ everyMs: 60_000 })], () => ({ error: 'the upstream fell over' }));
    await one.clock.advance(120_000);
    // a run that threw is a failure, not a refusal: nothing refused it, the run itself fell over
    const line = one.logs.find(each => each.includes('the upstream fell over')) as string;
    expect(line).toContain('→ failed (the upstream fell over)');
    expect(line).not.toContain('refused at the edge');
    expect(one.fired).toHaveLength(2); // the second tick still fired
    await one.scheduler.stop();
  });
});

describe('a schedule is named by its trigger, not by what it fires', () => {
  it('two triggers firing one operation on one schedule both fire: neither collapses into the other', async () => {
    // the same operation, the same schedule, different inputs: only the path tells the two apart
    const run = '@customers/domain/customer.port.json#digest';
    const one = started([
      trigger({ everyMs: 60_000 }, run, 'features/customers/edge/nightly.trigger.json'),
      trigger({ everyMs: 60_000 }, run, 'features/customers/edge/weekly.trigger.json'),
    ]);
    expect(one.answer.triggers).toBe(2); // both were seeded, not one over the other
    await one.clock.advance(60_000);
    expect(one.fired).toHaveLength(2); // and both fired: neither was silently never scheduled
    await one.scheduler.stop();
  });
});
