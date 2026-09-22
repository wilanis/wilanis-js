import { describe, expect, it } from 'vitest';
import type { KernelSpec } from '../src/index.js';
import { Kernel, outcomeOf, refusalOf } from '../src/index.js';
import { handlers } from './handlers.js';

/** A signal that aborts after `ms`, the way a deadline would. */
function abortAfter(ms: number): AbortSignal {
  const control = new AbortController();
  setTimeout(() => control.abort(), ms);
  return control.signal;
}

/** A sleep of `ms` answering `tag`, and whatever reads it. */
function sleep(ms: number, tag: string) {
  return { kind: 'call' as const, handler: 'sleep', in: { ms: { value: ms }, tag: { value: tag } } };
}

/** A node that echoes another's value: pending until that one settles. */
function after(id: string) {
  return { kind: 'call' as const, handler: 'echo', in: { of: { ref: id, path: [] } } };
}

describe('a cancelled run', () => {
  it('whose signal aborted before it began calls no handler and cancels every node', async () => {
    let calls = 0;
    const count = async () => {
      calls++;
      return calls;
    };
    const spec: KernelSpec = {
      name: 't',
      output: ['b'],
      nodes: { a: { kind: 'call', handler: 'count', in: {} }, b: { kind: 'call', handler: 'count', in: {} } },
    };
    const report = await new Kernel({ count }).run(spec, { signal: AbortSignal.abort() });
    expect(calls).toBe(0);
    expect(report.status).toBe('cancelled');
    expect(Object.values(report.nodes).map(node => node.status)).toEqual(['cancelled', 'cancelled']);
    expect(report.nodes.a.startedAt).toBeUndefined();
    expect(outcomeOf(report)).toEqual({ kind: 'cancelled' });
  });
  it('lets the node in flight finish, cancels what had not started, and answers no output', async () => {
    const spec: KernelSpec = {
      name: 't',
      output: ['quick', 'next'],
      nodes: { quick: sleep(10, 'quick'), slow: sleep(150, 'slow'), next: after('slow') },
    };
    const report = await new Kernel(handlers).run(spec, { signal: abortAfter(50) });
    expect(report.status).toBe('cancelled');
    // an output candidate settled before the abort; the run did not finish, so it answers none
    expect(report.nodes.quick).toMatchObject({ status: 'done', out: 'quick' });
    expect('output' in report).toBe(false);
    // `slow` ignores the signal: it ran, and its report says so
    expect(report.nodes.slow).toMatchObject({ status: 'done', out: 'slow' });
    expect(report.nodes.next.status).toBe('cancelled');
    expect(report.nodes.next.startedAt).toBeUndefined();
    // the run waited for what was in flight before it reported
    expect(report.endedAt).toBeGreaterThanOrEqual(report.nodes.slow.endedAt!);
  });
  it('that had already failed stays failed: the abort changes nothing', async () => {
    const spec: KernelSpec = {
      name: 't',
      output: ['next'],
      nodes: { bad: { kind: 'call', handler: 'boom', in: {} }, slow: sleep(100, 'slow'), next: after('slow') },
    };
    const report = await new Kernel(handlers).run(spec, { signal: abortAfter(30) });
    expect(report.status).toBe('failed');
    expect(outcomeOf(report)).toEqual({ kind: 'faulted', at: 'bad', error: 'boom' });
    expect(report.nodes.slow.status).toBe('done');
    expect(report.nodes.next.status).toBe('cancelled');
  });
  it('keeps a node that rejects after the abort as failed, with its message, and stays cancelled', async () => {
    const spec: KernelSpec = {
      name: 't',
      output: ['next'],
      nodes: {
        late: { kind: 'call', handler: 'sleepOrBoom', in: { ms: { value: 80 }, tag: { value: 'boom' } } },
        told: { kind: 'call', handler: 'abortable', in: { ms: { value: 1000 }, tag: { value: 'told' } } },
        next: after('late'),
      },
    };
    const report = await new Kernel(handlers).run(spec, { signal: abortAfter(30) });
    expect(report.status).toBe('cancelled');
    expect(report.nodes.late).toMatchObject({ status: 'failed', error: 'boom' });
    // a handler that honours its signal rejects, and the report says which node was in flight
    expect(report.nodes.told).toMatchObject({ status: 'failed', error: 'This operation was aborted' });
    expect(report.nodes.told.endedAt! - report.nodes.told.startedAt!).toBeLessThan(500);
    expect(report.nodes.next.status).toBe('cancelled');
  });
  it('keeps the reason of a refusal that lands after the abort, and refusalOf answers nothing', async () => {
    const spec: KernelSpec = {
      name: 't',
      output: ['next'],
      nodes: {
        asked: { kind: 'call', handler: 'sleepThenRefuse', in: { ms: { value: 80 }, tag: { value: 'row' } } },
        next: after('asked'),
      },
    };
    const report = await new Kernel(handlers).run(spec, { signal: abortAfter(30) });
    expect(report.status).toBe('cancelled');
    expect(report.nodes.asked).toMatchObject({ status: 'failed', reason: 'late', error: 'no row' });
    expect(refusalOf(report)).toBeUndefined();
    expect(outcomeOf(report)).toEqual({ kind: 'cancelled' });
  });
  it('lets its elements in flight settle as they settle when a map is running', async () => {
    const spec: KernelSpec = {
      name: 't',
      output: ['m'],
      nodes: {
        m: {
          kind: 'map',
          handler: 'abortable',
          over: {
            value: [
              { ms: 5, tag: 'a' },
              { ms: 1000, tag: 'b' },
            ],
          },
          in: {},
          bind: { ms: ['ms'], tag: ['tag'] },
          onItemFailure: 'fail',
        },
        next: after('m'),
      },
    };
    const report = await new Kernel(handlers).run(spec, { signal: abortAfter(50) });
    expect(report.status).toBe('cancelled');
    expect(report.nodes.m.items!.map(item => [item.status, item.out ?? item.error])).toEqual([
      ['done', 'a'],
      ['failed', 'This operation was aborted'],
    ]);
    expect(report.nodes.m).toMatchObject({ status: 'failed', error: "map 'm' element 1: This operation was aborted" });
    expect(report.nodes.next.status).toBe('cancelled');
  });
  it('is not what a run becomes when its signal aborts after it answered', async () => {
    const control = new AbortController();
    const spec: KernelSpec = { name: 't', output: ['a'], nodes: { a: sleep(1, 'a'), b: after('a') } };
    const report = await new Kernel(handlers).run(spec, { signal: control.signal });
    const before = structuredClone(report);
    control.abort();
    expect(report).toEqual(before);
    expect(report.status).toBe('done');
  });
});
