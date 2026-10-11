/**
 * Why X004 holds `deadlineMs` to `TIMER_MAX_MS`: `withDeadline` hands the number straight to `setTimeout`, and Node
 * takes a delay above 2147483647 ms as 1 ms. So a route with a deadline of 30 days would cancel every run at once.
 * Real timers, since the clamp is Node's own: a run that waits 30 ms is cancelled under a deadline one past the
 * bound, and is not under a deadline at the bound.
 */
import { TIMER_MAX_MS } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { withDeadline } from '../src/limit.js';

/** Whether a run that waits `ms` under `deadlineMs` was told to stop, and the warnings Node gave meanwhile. */
async function cancelled(deadlineMs: number, ms: number): Promise<{ aborted: boolean; warnings: string[] }> {
  const warnings: string[] = [];
  const heard = (warning: Error) => warnings.push(warning.name);
  process.on('warning', heard);
  let aborted = false;
  await withDeadline(deadlineMs, async signal => {
    await new Promise(done => setTimeout(done, ms));
    aborted = signal?.aborted === true;
  });
  await new Promise(done => setImmediate(done)); // a warning is emitted on the next tick
  process.off('warning', heard);
  return { aborted, warnings };
}

describe('a deadline past what a Node timer can wait', () => {
  it('strikes after 1 ms: a run under a deadline of TIMER_MAX_MS + 1 is cancelled within 30 ms', async () => {
    const run = await cancelled(TIMER_MAX_MS + 1, 30);
    expect(run.aborted).toBe(true);
    expect(run.warnings).toContain('TimeoutOverflowWarning');
  });

  it('a deadline of TIMER_MAX_MS is armed as written: the same run is not cancelled', async () => {
    const run = await cancelled(TIMER_MAX_MS, 30);
    expect(run.aborted).toBe(false);
    expect(run.warnings).toEqual([]);
  });
});
