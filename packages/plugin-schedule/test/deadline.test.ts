/**
 * A tick's deadline (RFC 0010 step 5, RFC 0012), over the fake clock: the scheduler arms it when the tick fires,
 * hands the run its signal, and logs a run the deadline cut as cancelled. A trigger with no deadline hands no
 * signal, so its run is never cut, and a run that answers in time is not touched by a deadline that never came.
 */
import { describe, expect, it } from 'vitest';
import { Scheduler } from '../src/scheduler.js';
import { type Answering, FakeClock, serving, settle, trigger } from './harness.js';

/** A scheduler of one-minute ticks over a fake clock at 10:00, started, with the answering a case asks for. */
function started(settings: Record<string, unknown>, answering: () => Answering = () => ({})) {
  const clock = new FakeClock('2026-09-11T10:00:00.000Z');
  const served = serving([trigger({ everyMs: 60_000, ...settings })], answering);
  const scheduler = new Scheduler({ serving: served.serving, clock });
  scheduler.start();
  return { clock, ...served, scheduler };
}

describe('a tick with a deadline', () => {
  it('is cancelled once the deadline passes, and logged as cancelled by it', async () => {
    const one = started({ deadlineMs: 5000 }, () => ({ untilCancelled: true }));
    await one.clock.advance(60_000); // the tick at 10:01 fires, and runs until it is told to stop
    expect(one.fired).toHaveLength(1);
    expect(one.fired[0].signalled).toBe(true);
    await one.clock.advance(4999);
    expect(one.logs.some(line => line.includes('→ cancelled'))).toBe(false); // not yet
    await one.clock.advance(1);
    const line = one.logs.find(each => each.includes('2026-09-11T10:01:00.000Z → cancelled'));
    expect(line).toContain('→ cancelled (deadline)');
    expect(one.blobs.released).toBe(1); // the cancelled run's scope is released like any other
    await one.scheduler.stop();
  });

  it('frees the schedule: the tick after a cancelled run fires rather than being skipped', async () => {
    const one = started({ deadlineMs: 5000 }, () => ({ untilCancelled: true }));
    await one.clock.advance(60_000);
    await one.clock.advance(60_000); // the first run was cut at 10:01:05, so 10:02 finds nothing going
    expect(one.fired.map(each => each.scheduled)).toEqual(['2026-09-11T10:01:00.000Z', '2026-09-11T10:02:00.000Z']);
    expect(one.logs.some(line => line.includes('→ skipped'))).toBe(false);
    await one.clock.advance(5000);
    await one.scheduler.stop();
  });

  it('a run that answers in time is done, and the deadline it did not reach cuts nothing', async () => {
    const one = started({ deadlineMs: 5000 });
    await one.clock.advance(60_000);
    await one.clock.advance(10_000);
    expect(one.fired[0].signalled).toBe(true);
    expect(one.logs.some(line => line.includes('2026-09-11T10:01:00.000Z → done'))).toBe(true);
    expect(one.logs.some(line => line.includes('→ cancelled'))).toBe(false);
    await one.scheduler.stop();
  });
});

describe('a tick with no deadline', () => {
  it('hands its run no signal, so nothing cuts a run that goes on', async () => {
    const one = started({}, () => ({ hold: true }));
    await one.clock.advance(60_000);
    expect(one.fired[0].signalled).toBe(false);
    await one.clock.advance(30 * 60_000);
    expect(one.logs.some(line => line.includes('→ cancelled'))).toBe(false);
    one.release();
    await settle();
    await one.scheduler.stop();
  });
});
