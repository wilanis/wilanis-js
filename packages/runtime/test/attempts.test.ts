/**
 * What the compiler's retry wrapper does where a data graph's node or a binding's operation says `retry` or
 * `timeoutMs` (RFC 0011): a fault and a timeout are tried again, a refusal never is, `when` retries an answer and
 * the last one stands, and the report is one node with the tries before the one it shows.
 */
import { attempting } from '@wilanis/compiler';
import type { Handler, NodeReport, Report, RunContext } from '@wilanis/engine';
import { describe, expect, it } from 'vitest';
import { running, scripted } from './attempts-tree.js';

/** The graph's report under the binding's call, and the node `asked` in it. */
const graphOf = (report: Report): Report => report.nodes.op.sub as Report;
const asked = (report: Report): NodeReport => graphOf(report).nodes.asked;

describe('a node that says retry', () => {
  it('tries a fault again, and the node stands on the try that answered', async () => {
    const upstream = scripted(['fault']);
    const report = await running('ask', upstream, { asked: { retry: { times: 2 } } });

    expect(report.status).toBe('done');
    expect(asked(report).status).toBe('done');
    expect(asked(report).attempts).toHaveLength(1);
    expect(asked(report).attempts?.[0].error).toBe('the upstream dropped the call');
    expect(upstream.calls).toHaveLength(2);
  });

  it('fails with the last error once the tries run out', async () => {
    const upstream = scripted(['fault', 'fault', 'fault']);
    const report = await running('ask', upstream, { asked: { retry: { times: 2 } } });

    expect(asked(report).status).toBe('failed');
    expect(asked(report).error).toBe('the upstream dropped the call');
    expect(asked(report).attempts).toHaveLength(2);
    expect(upstream.calls).toHaveLength(3);
  });

  it('never tries a refusal again', async () => {
    const upstream = scripted(['refuse']);
    const report = await running('ask', upstream, { asked: { retry: { times: 2 } } });

    expect(asked(report).status).toBe('failed');
    expect(asked(report).reason).toBe('missing');
    expect(asked(report).attempts).toBeUndefined();
    expect(upstream.calls).toHaveLength(1);
  });

  it('holds a timeout as a fault and tries it again, telling the hanging handler through its signal', async () => {
    const upstream = scripted(['hang']);
    const report = await running('ask', upstream, { asked: { timeoutMs: 20, retry: { times: 1 } } });

    expect(asked(report).status).toBe('done');
    expect(asked(report).attempts?.[0].error).toBe('timed out after 20ms');
    expect(upstream.signals[0]?.aborted).toBe(true);
    expect(upstream.signals[1]?.aborted).toBe(false);
  });

  it('fails a call that outlasts timeoutMs when it says no retry', async () => {
    const upstream = scripted(['hang']);
    const report = await running('ask', upstream, { asked: { timeoutMs: 20 } });

    expect(asked(report).status).toBe('failed');
    expect(asked(report).error).toBe('timed out after 20ms');
    expect(asked(report).attempts).toBeUndefined();
  });

  it('tries again an answer `when` accepts, and lets the last one stand', async () => {
    const recovers = scripted([503, 503, 200]);
    const recovered = await running('ask', recovers, { asked: { retry: { times: 2, when: 'status >= 500' } } });
    expect(asked(recovered).out).toEqual({ status: 200 });
    expect(asked(recovered).attempts?.map(one => one.error)).toEqual([
      'answer retried: status >= 500',
      'answer retried: status >= 500',
    ]);

    const stays = scripted([503, 503, 503]);
    const stayed = await running('ask', stays, { asked: { retry: { times: 2, when: 'status >= 500' } } });
    expect(asked(stayed).status).toBe('done');
    expect(asked(stayed).out).toEqual({ status: 503 });
    expect(stays.calls).toHaveLength(3);
  });

  it('waits backoffMs before the second try and twice that before the third', async () => {
    const upstream = scripted(['fault', 'fault', 'fault']);
    const report = await running('ask', upstream, { asked: { retry: { times: 3, backoffMs: 10 } } });
    const [first, second, third] = asked(report).attempts ?? [];

    // a timer may fire up to a millisecond early by the wall clock the report is stamped with
    expect(second.startedAt - first.endedAt).toBeGreaterThanOrEqual(9);
    expect(third.startedAt - second.endedAt).toBeGreaterThanOrEqual(19);
  });

  it('keeps the operation as the handler the report says ran', async () => {
    const report = await running('ask', scripted(['fault']), { asked: { retry: { times: 1 } } });

    expect(asked(report).handler).toBe('@flaky/flaky.port.json#ask');
  });
});

describe('a map that says retry', () => {
  it('tries each element on its own', async () => {
    const upstream = scripted((item, before) => (item === 'b' && before === 0 ? 'fault' : 200));
    const report = await running('each', upstream, { each: { retry: { times: 1 } } });
    const items = graphOf(report).nodes.each.items ?? [];

    expect(report.status).toBe('done');
    expect(items.map(item => item.attempts?.length)).toEqual([undefined, 1, undefined]);
    expect(upstream.calls.filter(item => item === 'b')).toHaveLength(2);
  });
});

describe('a binding operation that says retry', () => {
  it('runs its graph again when the graph broke, keeping the broken run on the attempt', async () => {
    const upstream = scripted(['fault']);
    const report = await running('ask', upstream, { binding: { retry: { times: 1 } } });
    const call = report.nodes.op;

    expect(call.status).toBe('done');
    expect(call.attempts).toHaveLength(1);
    expect(call.attempts?.[0].sub?.status).toBe('failed');
    expect(call.attempts?.[0].sub?.nodes.asked.error).toBe('the upstream dropped the call');
    expect(call.sub?.status).toBe('done');
    expect(upstream.calls).toHaveLength(2);
  });

  it('passes a refusal of its graph up without running it again', async () => {
    const upstream = scripted(['refuse']);
    const report = await running('ask', upstream, { binding: { retry: { times: 2 } } });

    expect(report.nodes.op.reason).toBe('missing');
    expect(report.nodes.op.attempts).toBeUndefined();
    expect(upstream.calls).toHaveLength(1);
  });
});

describe('a retried call whose run is cancelled', () => {
  it('records no second try when the run is cancelled during its first', async () => {
    const run = new AbortController();
    const tried: unknown[] = [];
    const base: Handler = ({ ctx }) => {
      tried.push(ctx.signal);
      return new Promise((_, reject) => ctx.signal?.addEventListener('abort', () => reject(new Error('stopped'))));
    };
    const attempted: unknown[] = [];
    const ctx = {
      nodePath: ['asked'],
      site: 'asked',
      signal: run.signal,
      clock: Date.now,
      attach: () => {},
      attempted: (one: unknown) => attempted.push(one),
      env: {},
    } as RunContext;
    const wrapped = attempting(base, new Map([['asked', { times: 2, backoffMs: 0 }]]));

    const ended = wrapped({ in: { item: 'a' }, ctx });
    run.abort();

    await expect(ended).rejects.toThrow('stopped');
    expect(tried).toHaveLength(1);
    expect(attempted).toEqual([]);
  });

  it('ends the wait between tries when the run is cancelled, and tries no more', async () => {
    const run = new AbortController();
    let tries = 0;
    const base: Handler = async () => {
      tries++;
      throw new Error('the upstream dropped the call');
    };
    const attempted: unknown[] = [];
    const ctx = {
      nodePath: ['asked'],
      site: 'asked',
      signal: run.signal,
      clock: Date.now,
      attach: () => {},
      attempted: (one: unknown) => attempted.push(one),
      env: {},
    } as RunContext;
    const wrapped = attempting(base, new Map([['asked', { times: 2, backoffMs: 60_000 }]]));

    const began = Date.now();
    const ended = wrapped({ in: { item: 'a' }, ctx });
    setTimeout(() => run.abort(), 20);

    await expect(ended).rejects.toThrow('the upstream dropped the call');
    expect(Date.now() - began).toBeLessThan(1000);
    expect(tries).toBe(1);
    expect(attempted).toEqual([]);
  });
});

describe('a call that says neither word', () => {
  it('runs once and its report carries nothing new', async () => {
    const upstream = scripted(['fault']);
    const report = await running('ask', upstream);

    expect(asked(report).status).toBe('failed');
    expect(Object.keys(asked(report))).not.toContain('attempts');
    expect(Object.keys(report.nodes.op)).not.toContain('attempts');
    expect(upstream.calls).toHaveLength(1);
  });

  it('is handed to the base handler as it came, whatever the table holds', async () => {
    const seen: unknown[] = [];
    const base: Handler = async args => {
      seen.push(args);
      return 'answered';
    };
    const args = { in: { item: 'a' }, ctx: { nodePath: ['asked'] } as unknown as RunContext };
    const wrapped = attempting(base, new Map([['elsewhere', { times: 3, backoffMs: 0 }]]));

    expect(await wrapped(args)).toBe('answered');
    expect(seen).toEqual([args]);
    expect(seen[0]).toBe(args);
  });
});
