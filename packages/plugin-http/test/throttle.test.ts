import { describe, expect, it } from 'vitest';
import { Throttle } from '../src/throttle.js';

describe('the throttle', () => {
  it('holds requests to the concurrency ceiling and lets the rest through as slots free up', async () => {
    const gate = new Throttle({ concurrency: 3 });
    let now = 0,
      peak = 0;
    const job = async () => {
      now++;
      peak = Math.max(peak, now);
      await new Promise(done => setTimeout(done, 10));
      now--;
      return 1;
    };
    const out = await Promise.all(Array.from({ length: 10 }, () => gate.run(job)));
    expect(out).toHaveLength(10);
    expect(peak).toBe(3);
    expect(now).toBe(0);
  });
  it('starts no more than perSecond requests in any one second', async () => {
    const gate = new Throttle({ perSecond: 3 });
    const starts: number[] = [];
    await Promise.all(
      Array.from({ length: 7 }, () =>
        gate.run(async () => {
          starts.push(Date.now());
        }),
      ),
    );
    starts.sort((one, other) => one - other);
    // the job's clock reads a tick after the gate's, so a millisecond of skew is measurement, not a fourth start in the second
    for (let at = 0; at + 3 < starts.length; at++) expect(starts[at + 3] - starts[at]).toBeGreaterThanOrEqual(999);
    expect(starts[6] - starts[0]).toBeLessThan(2500);
  });
  it('frees the slot when the request throws', async () => {
    const gate = new Throttle({ concurrency: 1 });
    await expect(
      gate.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await gate.run(async () => 'next')).toBe('next');
  });
});
