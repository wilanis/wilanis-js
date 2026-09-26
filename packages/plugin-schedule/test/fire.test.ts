/**
 * The line a tick is logged as says what the run answered, and a log is a report: a field the trigger's `out` marks
 * secret is the marker there, while the run's own output -- what anything waiting on the tick is handed -- stays
 * the value.
 */
import type { Type } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { fireTick, lineOf, type Tick } from '../src/fire.js';
import { serving, trigger } from './harness.js';

const TICK: Tick = { scheduled: '2026-09-11T03:00:00.000Z', fired: '2026-09-11T03:00:00.000Z', missed: 0 };

/** A digest whose token the trigger's out marks secret. */
const DIGEST: Type = {
  kind: 'object',
  fields: {
    count: { type: { kind: 'number' }, required: true },
    token: { type: { kind: 'string' }, required: true, secret: true },
  },
  open: false,
};

describe('the line a tick is logged as', () => {
  it("says the answer as the trigger's out marks it, and leaves the run's output the value", async () => {
    const digest = trigger({ cron: '0 3 * * *', timezone: 'UTC' });
    const served = serving([digest], () => ({ report: { output: { count: 2, token: 't-1' } } }));
    served.serving.types = () => ({ out: DIGEST });
    const fired = await fireTick(served.serving, digest, TICK);
    expect(fired.report?.output).toEqual({ count: 2, token: 't-1' });
    const line = lineOf('digest', TICK, fired);
    expect(line).toContain('{"count":2,"token":"«secret»"}');
    expect(line).not.toContain('t-1');
  });
});
