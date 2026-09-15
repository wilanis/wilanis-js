import { describe, expect, it } from 'vitest';
import type { KernelSpec } from '../src/index.js';
import { isRefusal, Kernel, outcomeOf, Refusal, refusalOf } from '../src/index.js';
import { handlers } from './handlers.js';

/** A one-node spec over a shared handler, so each outcome is named by the handler it ends in. */
function oneNode(handler: string, input: Record<string, { value: unknown }> = {}): KernelSpec {
  return { name: 't', output: ['a'], nodes: { a: { kind: 'call', handler, in: input } } };
}

describe('the scheduler', () => {
  it('runs ready nodes, routes, cancels the other branch, answers the first settled candidate', async () => {
    const spec: KernelSpec = {
      name: 't',
      output: ['big', 'small'],
      nodes: {
        route: {
          kind: 'switch',
          in: { x: { ref: 'in', path: ['x'] } },
          rules: [{ when: values => Number(values.x) > 10, to: 'big', label: 'x > 10' }],
          else: 'small',
        },
        big: { kind: 'call', handler: 'double', in: { x: { ref: 'in', path: ['x'] } } },
        small: { kind: 'call', handler: 'echo', in: { x: { ref: 'in', path: ['x'] } } },
      },
    };
    const report = await new Kernel(handlers).run(spec, { initial: { in: { x: 21 } } });
    expect(report.status).toBe('done');
    expect(report.output).toBe(42);
    expect(report.nodes.small.status).toBe('cancelled');
    expect(report.nodes.route.selected).toBe('big');
  });
  it('reports blocked with needs when an input is never supplied', async () => {
    const spec: KernelSpec = {
      name: 't',
      output: ['a'],
      nodes: { a: { kind: 'call', handler: 'double', in: { x: { ref: 'in', path: ['x'] } } } },
    };
    const report = await new Kernel(handlers).run(spec, {});
    expect(report.status).toBe('blocked');
    expect(report.needs).toEqual(['in.x']);
  });
  it('replays a seeded node without calling its handler', async () => {
    const spec: KernelSpec = {
      name: 't',
      output: ['b'],
      nodes: {
        a: { kind: 'call', handler: 'boom', in: {} },
        b: { kind: 'call', handler: 'double', in: { x: { ref: 'a', path: [] } } },
      },
    };
    const report = await new Kernel(handlers).run(spec, { initial: { a: 5 } });
    expect(report.status).toBe('done');
    expect(report.output).toBe(10);
    expect(report.nodes.a.status).toBe('seeded');
  });
  it('runs independent nodes concurrently: three sleeps take the longest, not the sum', async () => {
    const spec: KernelSpec = {
      name: 't',
      output: ['join'],
      nodes: {
        slow: { kind: 'call', handler: 'sleep', in: { ms: { value: 1000 }, tag: { value: 'slow' } } },
        quick: { kind: 'call', handler: 'sleep', in: { ms: { value: 500 }, tag: { value: 'quick' } } },
        mid: { kind: 'call', handler: 'sleep', in: { ms: { value: 800 }, tag: { value: 'mid' } } },
        join: {
          kind: 'call',
          handler: 'echo',
          in: { a: { ref: 'slow', path: [] }, b: { ref: 'quick', path: [] }, c: { ref: 'mid', path: [] } },
        },
      },
    };
    const began = Date.now();
    const report = await new Kernel(handlers).run(spec, {});
    const elapsed = Date.now() - began;
    expect(report.status).toBe('done');
    expect(report.output).toEqual({ a: 'slow', b: 'quick', c: 'mid' });
    // The sum is 2300ms; concurrent, the graph is bounded by its longest node. No lower bound on the
    // elapsed time: `setTimeout` promises the timer's own clock, not `Date.now()`, so a 1000ms sleep can
    // measure 999 and did on CI. What the nodes' own timestamps say below is the evidence either way.
    expect(elapsed).toBeLessThan(1500);
    // The report is the evidence: all three were in flight at once.
    const started = ['slow', 'quick', 'mid'].map(id => report.nodes[id].startedAt!);
    expect(Math.max(...started) - Math.min(...started)).toBeLessThan(100);
    expect(Math.min(...['slow', 'quick', 'mid'].map(id => report.nodes[id].endedAt!))).toBeLessThan(
      report.nodes.slow.endedAt!,
    );
    // The dependent node waited for the last of them.
    expect(report.nodes.join.startedAt!).toBeGreaterThanOrEqual(report.nodes.slow.endedAt!);
  });
  it('starts a dependent node as soon as its own dependency settles, not at a round boundary', async () => {
    const spec: KernelSpec = {
      name: 't',
      output: ['after'],
      nodes: {
        slow: { kind: 'call', handler: 'sleep', in: { ms: { value: 1000 }, tag: { value: 'slow' } } },
        quick: { kind: 'call', handler: 'sleep', in: { ms: { value: 200 }, tag: { value: 'quick' } } },
        after: { kind: 'call', handler: 'echo', in: { of: { ref: 'quick', path: [] } } },
      },
    };
    const report = await new Kernel(handlers).run(spec, {});
    expect(report.status).toBe('done');
    // `after` follows `quick` while `slow` is still in flight.
    expect(report.nodes.after.endedAt!).toBeLessThan(report.nodes.slow.endedAt!);
  });
  it('lets in-flight nodes finish when a sibling fails, and cancels only what is still pending', async () => {
    const spec: KernelSpec = {
      name: 't',
      output: ['after'],
      nodes: {
        slow: { kind: 'call', handler: 'sleep', in: { ms: { value: 600 }, tag: { value: 'slow' } } },
        bad: { kind: 'call', handler: 'boom', in: {} },
        after: { kind: 'call', handler: 'echo', in: { of: { ref: 'slow', path: [] } } },
      },
    };
    const report = await new Kernel(handlers).run(spec, {});
    expect(report.status).toBe('failed');
    // `bad` throws immediately; `slow` was already running and is not aborted.
    expect(report.nodes.slow.status).toBe('done');
    expect(report.nodes.slow.endedAt! - report.nodes.bad.endedAt!).toBeGreaterThan(400);
    // `after` was still pending when the failure landed, so it never ran.
    expect(report.nodes.after.status).toBe('cancelled');
  });
});

describe('outcomeOf', () => {
  it('names a run that answered, with its output', async () => {
    const report = await new Kernel(handlers).run(oneNode('double', { x: { value: 21 } }), {});
    expect(outcomeOf(report)).toEqual({ kind: 'answered', output: 42 });
  });
  it('names a refusal: the reason, the message, the detail and the node that gave them', async () => {
    const detail = { value: { challenge: { id: 'K7Q2' } } };
    const spec = oneNode('refuse', { reason: { value: 'missing' }, what: { value: 'entry 7' }, detail });
    const report = await new Kernel(handlers).run(spec, {});
    expect(outcomeOf(report)).toEqual({
      kind: 'refused',
      reason: 'missing',
      message: 'no entry 7',
      detail: { challenge: { id: 'K7Q2' } },
      at: 'a',
    });
    // refusalOf is the refused case of outcomeOf, and says what it always said.
    expect(refusalOf(report)).toEqual({
      reason: 'missing',
      message: 'no entry 7',
      detail: { challenge: { id: 'K7Q2' } },
    });
  });
  it('names a fault: the node that broke and what it threw, and refusalOf finds nothing', async () => {
    const report = await new Kernel(handlers).run(oneNode('boom'), {});
    expect(outcomeOf(report)).toEqual({ kind: 'faulted', at: 'a', error: 'boom' });
    expect(refusalOf(report)).toBeUndefined();
  });
  it('names a blocked run by the roots nothing supplied', async () => {
    const spec: KernelSpec = {
      name: 't',
      output: ['a'],
      nodes: { a: { kind: 'call', handler: 'double', in: { x: { ref: 'in', path: ['x'] } } } },
    };
    const report = await new Kernel(handlers).run(spec, {});
    expect(outcomeOf(report)).toEqual({ kind: 'blocked', needs: ['in.x'] });
  });
  it('answers the refusal, not the fault, when a run holds both, and names the node that refused', async () => {
    // `bad` breaks and `no` refuses; the graph decided, so the run refused.
    const spec: KernelSpec = {
      name: 't',
      output: ['ok'],
      nodes: {
        bad: { kind: 'call', handler: 'boom', in: {} },
        no: { kind: 'call', handler: 'refuse', in: { reason: { value: 'conflict' }, what: { value: 'room' } } },
        ok: { kind: 'call', handler: 'echo', in: {} },
      },
    };
    const report = await new Kernel(handlers).run(spec, {});
    expect(outcomeOf(report)).toMatchObject({ kind: 'refused', reason: 'conflict', at: 'no' });
  });
  it('skips a node whose fault a switch caught: the fault that ended the run is the one that was not', async () => {
    const report = await new Kernel(handlers).run(oneNode('boom'), {});
    // `caught` is written by the switch that routes a fault; a node carrying it did not end the run.
    report.nodes.caught = { status: 'failed', error: 'routed', caught: 'route' };
    expect(outcomeOf(report)).toEqual({ kind: 'faulted', at: 'a', error: 'boom' });
  });
  it("a nested run's refusal reaching the caller node is the run's refusal, at the caller", async () => {
    // What the compiler does: a nested run that refused rethrows its Refusal at the node that ran it.
    const nested = {
      ...handlers,
      call: async () => {
        throw new Refusal('missing', 'no entry 7');
      },
    };
    const report = await new Kernel(nested).run(oneNode('call'), {});
    expect(outcomeOf(report)).toEqual({ kind: 'refused', reason: 'missing', message: 'no entry 7', at: 'a' });
  });
});

describe('isRefusal', () => {
  it("reads a foreign copy of the engine: an Error named Refusal with a string reason is the graph's decision", async () => {
    const own = new Refusal('missing', 'no entry 7');
    expect(isRefusal(own)).toBe(true);
    const spec = oneNode('refuseForeign', { reason: { value: 'missing' }, what: { value: 'entry 7' } });
    const report = await new Kernel(handlers).run(spec, {});
    expect(report.nodes.a).toMatchObject({ status: 'failed', reason: 'missing', error: 'no entry 7' });
    expect(outcomeOf(report)).toEqual({ kind: 'refused', reason: 'missing', message: 'no entry 7', at: 'a' });
  });
  it('an Error named Refusal without a string reason is a fault, and so is anything else thrown', async () => {
    const named = new Error('no entry 7');
    named.name = 'Refusal';
    expect(isRefusal(named)).toBe(false);
    expect(isRefusal(new Error('boom'))).toBe(false);
    expect(isRefusal({ name: 'Refusal', reason: 'missing' })).toBe(false);
    expect(isRefusal(undefined)).toBe(false);
    const report = await new Kernel(handlers).run(oneNode('refuseForeign', { what: { value: 'entry 7' } }), {});
    expect(report.nodes.a.reason).toBeUndefined();
    expect(outcomeOf(report)).toEqual({ kind: 'faulted', at: 'a', error: 'no entry 7' });
  });
});

describe('the clock', () => {
  /** A clock that answers 1, 2, 3, ... one number per reading, so every stamp says which reading it was. */
  function counting(): () => number {
    let tick = 0;
    return () => ++tick;
  }

  it('stamps the run and its node from the clock it was given, in the order it read them', async () => {
    const report = await new Kernel(handlers).run(oneNode('double', { x: { value: 21 } }), { clock: counting() });
    expect(report.output).toBe(42);
    // 1: the run begins; 2: the node starts; 3: the node ends; 4: the run answers
    expect(report.startedAt).toBe(1);
    expect(report.nodes.a.startedAt).toBe(2);
    expect(report.nodes.a.endedAt).toBe(3);
    expect(report.endedAt).toBe(4);
  });
  it('stamps a map element from the same clock: no node is timed by another', async () => {
    const spec: KernelSpec = {
      name: 't',
      output: ['m'],
      nodes: { m: { kind: 'map', handler: 'echo', over: { value: [{ n: 1 }] }, in: {}, onItemFailure: 'fail' } },
    };
    const report = await new Kernel(handlers).run(spec, { clock: counting() });
    expect(report.nodes.m.startedAt).toBe(2);
    expect(report.nodes.m.items?.[0]).toMatchObject({ startedAt: 3, endedAt: 4 });
  });
  it('reads Date.now when no clock is given', async () => {
    const began = Date.now();
    const report = await new Kernel(handlers).run(oneNode('double', { x: { value: 1 } }), {});
    expect(report.startedAt).toBeGreaterThanOrEqual(began);
    expect(report.endedAt).toBeGreaterThanOrEqual(report.startedAt);
  });
});
