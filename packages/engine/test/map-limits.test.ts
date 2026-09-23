import { describe, expect, it } from 'vitest';
import type { HandlerArgs, KernelSpec, KMap } from '../src/index.js';
import { Kernel, outcomeOf } from '../src/index.js';
import { handlers } from './handlers.js';

/** A map of `handler` over the literal list, each element bound as `x`, with the fields given. */
function mapOver(handler: string, over: unknown[], fields: Partial<KMap> = {}): KernelSpec {
  return {
    name: 't',
    output: ['m'],
    nodes: {
      m: { kind: 'map', handler, over: { value: over }, in: {}, bind: { x: [] }, onItemFailure: 'fail', ...fields },
    },
  };
}

/** A handler that sleeps `ms` per element and records, as it starts, which element it is and how many were in flight. */
function gauge(ms: number) {
  const started: Array<{ x: unknown; inFlight: number }> = [];
  let inFlight = 0;
  let most = 0;
  const slow = async ({ in: input }: HandlerArgs) => {
    inFlight++;
    most = Math.max(most, inFlight);
    started.push({ x: input.x, inFlight });
    await new Promise(resolve => setTimeout(resolve, ms));
    inFlight--;
    return Number(input.x) * 10;
  };
  return { slow, started, most: () => most };
}

/** A signal that aborts after `ms`, the way a deadline would. */
function abortAfter(ms: number): AbortSignal {
  const control = new AbortController();
  setTimeout(() => control.abort(), ms);
  return control.signal;
}

describe('a map with concurrency', () => {
  it('runs at most that many elements at once, starting them in index order', async () => {
    const counted = gauge(10);
    const report = await new Kernel({ slow: counted.slow }).run(mapOver('slow', [0, 1, 2, 3, 4], { concurrency: 2 }));
    expect(report.status).toBe('done');
    expect(report.output).toEqual([0, 10, 20, 30, 40]);
    expect(counted.most()).toBe(2);
    expect(counted.started.map(start => start.x)).toEqual([0, 1, 2, 3, 4]);
    expect(report.nodes.m.items!.every(item => item.status === 'done')).toBe(true);
  });
  it('lets a seeded element hold no slot: the elements that run still run two at a time', async () => {
    const counted = gauge(10);
    const spec = mapOver('slow', [0, 1, 2, 3, 4], { concurrency: 2 });
    const report = await new Kernel({ slow: counted.slow }).run(spec, { initial: { 'm.0': 'kept' } });
    expect(report.status).toBe('done');
    expect(report.output).toEqual(['kept', 10, 20, 30, 40]);
    // the seeded element answered at once, so elements 1 and 2 were in flight together
    expect(counted.started.slice(0, 2)).toEqual([
      { x: 1, inFlight: 1 },
      { x: 2, inFlight: 2 },
    ]);
    expect(counted.most()).toBe(2);
    expect(report.nodes.m.items!.map(item => item.status)).toEqual(['seeded', 'done', 'done', 'done', 'done']);
  });
  it('under fail starts nothing after an element broke: the later ones are cancelled, the node failed', async () => {
    const ran: unknown[] = [];
    const pick = async ({ in: input }: HandlerArgs) => {
      ran.push(input.x);
      if (input.x === 1) throw new Error('one is bad');
      return input.x;
    };
    const report = await new Kernel({ pick }).run(mapOver('pick', [0, 1, 2, 3], { concurrency: 1 }));
    expect(ran).toEqual([0, 1]);
    expect(report.status).toBe('failed');
    expect(report.nodes.m).toMatchObject({ status: 'failed', error: "map 'm' element 1: one is bad" });
    expect(report.nodes.m.items!.map(item => item.status)).toEqual(['done', 'failed', 'cancelled', 'cancelled']);
    expect(report.nodes.m.items![2].startedAt).toBeUndefined();
    expect(outcomeOf(report)).toEqual({ kind: 'faulted', at: 'm', error: "map 'm' element 1: one is bad" });
  });
  it('under collect runs every element, since each outcome is the answer', async () => {
    const report = await new Kernel(handlers).run(
      mapOver('boom', ['a', 'b', 'c'], { concurrency: 1, onItemFailure: 'collect' }),
    );
    expect(report.status).toBe('done');
    expect(report.output).toEqual([
      { ok: false, error: 'boom' },
      { ok: false, error: 'boom' },
      { ok: false, error: 'boom' },
    ]);
    expect(report.nodes.m.items!.map(item => item.status)).toEqual(['failed', 'failed', 'failed']);
  });
  it('refuses with the element that refused, and starts nothing after it', async () => {
    const spec: KernelSpec = {
      name: 't',
      output: ['m'],
      nodes: {
        m: {
          kind: 'map',
          handler: 'refuse',
          over: { value: ['a', 'b'] },
          in: { reason: { value: 'missing' } },
          bind: { what: [] },
          onItemFailure: 'fail',
          concurrency: 1,
        },
      },
    };
    const report = await new Kernel(handlers).run(spec);
    expect(report.nodes.m).toMatchObject({ status: 'failed', reason: 'missing', error: 'no a' });
    expect(report.nodes.m.items!.map(item => item.status)).toEqual(['failed', 'cancelled']);
  });
  it('a switch catches its fault the way it catches any map: failed and caught, the later elements cancelled', async () => {
    const spec: KernelSpec = {
      name: 't',
      output: ['all', 'broke'],
      nodes: {
        each: {
          kind: 'map',
          handler: 'sleepOrBoom',
          over: { value: ['a', 'boom', 'c'] },
          in: { ms: { value: 1 } },
          bind: { tag: [] },
          onItemFailure: 'fail',
          concurrency: 1,
        },
        route: { kind: 'switch', in: {}, rules: [], else: 'all', catch: { each: 'broke' } },
        all: { kind: 'call', handler: 'echo', in: { each: { ref: 'each', path: [] } } },
        broke: { kind: 'call', handler: 'echo', in: { said: { value: 'an element broke' } } },
      },
    };
    const report = await new Kernel(handlers).run(spec);
    expect(report.status).toBe('done');
    expect(report.nodes.each).toMatchObject({ status: 'failed', caught: 'route', error: "map 'each' element 1: boom" });
    expect(report.nodes.each.items!.map(item => item.status)).toEqual(['done', 'failed', 'cancelled']);
    expect(report.output).toEqual({ said: 'an element broke' });
  });
});

describe('a map with a limit', () => {
  it('fails over a longer list before any element exists or any handler is called', async () => {
    const counted = gauge(1);
    const report = await new Kernel({ slow: counted.slow }).run(mapOver('slow', [0, 1, 2, 3], { limit: 3 }));
    expect(report.status).toBe('failed');
    expect(report.nodes.m).toMatchObject({ status: 'failed', error: "map 'm': 4 elements, limit 3" });
    expect(report.nodes.m.items).toBeUndefined();
    expect(counted.started).toEqual([]);
  });
  it('runs a list at its limit', async () => {
    const report = await new Kernel(handlers).run(mapOver('double', [1, 2, 3], { limit: 3 }));
    expect(report.status).toBe('done');
    expect(report.output).toEqual([2, 4, 6]);
  });
});

describe('a map whose run ends while it holds elements back', () => {
  it('when cancelled, lets its started elements settle and cancels the ones not started', async () => {
    const counted = gauge(40);
    const spec = mapOver('slow', [0, 1, 2, 3, 4], { concurrency: 2 });
    const report = await new Kernel({ slow: counted.slow }).run(spec, { signal: abortAfter(20) });
    expect(report.status).toBe('cancelled');
    expect(counted.started.map(start => start.x)).toEqual([0, 1]);
    expect(report.nodes.m.items!.map(item => item.status)).toEqual([
      'done',
      'done',
      'cancelled',
      'cancelled',
      'cancelled',
    ]);
    expect(report.nodes.m.items![2].startedAt).toBeUndefined();
    // the map did not finish, so it did not answer
    expect(report.nodes.m).toMatchObject({ status: 'failed', error: "map 'm' element 2: cancelled" });
    expect(outcomeOf(report)).toEqual({ kind: 'cancelled' });
  });
  it('when cancelled under collect, still does not answer a list with holes in it', async () => {
    const counted = gauge(40);
    const spec = mapOver('slow', [0, 1, 2], { concurrency: 1, onItemFailure: 'collect' });
    const report = await new Kernel({ slow: counted.slow }).run(spec, { signal: abortAfter(20) });
    expect(report.status).toBe('cancelled');
    expect(report.nodes.m.items!.map(item => item.status)).toEqual(['done', 'cancelled', 'cancelled']);
    expect(report.nodes.m).toMatchObject({ status: 'failed', error: "map 'm' element 1: cancelled" });
  });
  it('when an element in flight is told to stop, names that element', async () => {
    const spec: KernelSpec = {
      name: 't',
      output: ['m'],
      nodes: {
        m: {
          kind: 'map',
          handler: 'abortable',
          over: { value: ['a', 'b', 'c'] },
          in: { ms: { value: 1000 } },
          bind: { tag: [] },
          onItemFailure: 'fail',
          concurrency: 2,
        },
      },
    };
    const report = await new Kernel(handlers).run(spec, { signal: abortAfter(20) });
    expect(report.status).toBe('cancelled');
    expect(report.nodes.m.items!.map(item => item.status)).toEqual(['failed', 'failed', 'cancelled']);
    expect(report.nodes.m.error).toBe("map 'm' element 0: This operation was aborted");
  });
  it('when another node breaks, starts no further element', async () => {
    const counted = gauge(20);
    const spec = mapOver('slow', [0, 1, 2], { concurrency: 1 });
    spec.nodes.z = { kind: 'call', handler: 'boom', in: {} };
    const report = await new Kernel({ ...handlers, slow: counted.slow }).run(spec);
    expect(report.status).toBe('failed');
    expect(outcomeOf(report)).toEqual({ kind: 'faulted', at: 'z', error: 'boom' });
    expect(counted.started.map(start => start.x)).toEqual([0]);
    expect(report.nodes.m.items!.map(item => item.status)).toEqual(['done', 'cancelled', 'cancelled']);
  });
});

describe('a map without limit or concurrency', () => {
  it('reports exactly as before: every element started at once, every one settled', async () => {
    const report = await new Kernel(handlers).run(mapOver('double', [1, 2]), { clock: () => 7 });
    expect(report).toEqual({
      graph: 't',
      status: 'done',
      output: [2, 4],
      startedAt: 7,
      endedAt: 7,
      nodes: {
        m: {
          status: 'done',
          startedAt: 7,
          endedAt: 7,
          handler: 'double',
          in: { over: [1, 2] },
          out: [2, 4],
          items: [
            { status: 'done', startedAt: 7, endedAt: 7, handler: 'double', in: { x: 1 }, out: 2 },
            { status: 'done', startedAt: 7, endedAt: 7, handler: 'double', in: { x: 2 }, out: 4 },
          ],
        },
      },
    });
  });
});
