import { describe, expect, it } from 'vitest';
import type { KernelSpec, KNode, KSwitch } from '../src/index.js';
import { Kernel, outcomeOf, waitsFor } from '../src/index.js';
import { handlers } from './handlers.js';

/** A call of `handler` with literal inputs, waiting for the nodes named in `after`. */
function call(handler: string, inputs: Record<string, unknown> = {}, after?: string[]): KNode {
  const inn = Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, { value }]));
  return { kind: 'call', handler, in: inn, ...(after ? { after } : {}) };
}

/** A clock that ticks once per read, so two stamps never tie and their order is the order they were taken in. */
function ticking(): () => number {
  let now = 0;
  return () => ++now;
}

/** The handlers, and how many times `counted` was called: a node whose handler never ran leaves the count at 0. */
function counting() {
  const calls = { count: 0 };
  const counted = async ({ in: input }: { in: Record<string, unknown> }) => {
    calls.count++;
    return input;
  };
  return { kernel: new Kernel({ ...handlers, counted }), calls };
}

/** The RFC's isKept: a record present routes to `customer`, none to `noCustomer`. */
const isKept: KSwitch = {
  kind: 'switch',
  in: { record: { ref: 'in', path: ['record'] } },
  rules: [{ when: values => values.record !== undefined, to: 'customer', label: 'has(record)' }],
  else: 'noCustomer',
};

/** A customer's card: `everyLatest` reads nothing of `customer`, and waits for it so it runs only where it is kept. */
const card: KernelSpec = {
  name: 'kept-card',
  output: ['card', 'noCustomer'],
  nodes: {
    isKept,
    customer: { kind: 'call', handler: 'echo', in: { record: { ref: 'in', path: ['record'] } } },
    everyLatest: call('counted', { collection: 'latest' }, ['customer']),
    card: {
      kind: 'call',
      handler: 'echo',
      in: { customer: { ref: 'customer', path: [] }, latest: { ref: 'everyLatest', path: [] } },
    },
    // it answers rather than refuses, so a cancelled waiter is the switch's doing and not the run ending
    noCustomer: call('echo', { said: 'no customer' }),
  },
};

describe('a node that waits for another under after', () => {
  it('starts only once that node has answered, and is not given its answer', async () => {
    const spec: KernelSpec = {
      name: 't',
      output: ['waiter'],
      nodes: {
        slow: call('sleep', { ms: 20, tag: 'slow' }),
        free: call('echo', { said: 'free' }),
        waiter: call('echo', { said: 'waiter' }, ['slow']),
      },
    };
    const report = await new Kernel(handlers).run(spec, { clock: ticking() });
    expect(report.status).toBe('done');
    const { slow, free, waiter } = report.nodes;
    expect(waiter.startedAt).toBeGreaterThan(slow.endedAt ?? Number.POSITIVE_INFINITY);
    // a node with no wait starts at once, while `slow` still runs
    expect(free.startedAt).toBeLessThan(slow.endedAt ?? 0);
    // its operation takes exactly its `in`
    expect(waiter).toMatchObject({ in: { said: 'waiter' }, out: { said: 'waiter' } });
  });
  it('runs on the branch where the switch chose the node it waits for', async () => {
    const { kernel, calls } = counting();
    const report = await kernel.run(card, { initial: { in: { record: { id: 'golf' } } }, clock: ticking() });
    expect(report.status).toBe('done');
    expect(report.output).toEqual({ customer: { record: { id: 'golf' } }, latest: { collection: 'latest' } });
    expect(calls.count).toBe(1);
    const { customer, everyLatest } = report.nodes;
    expect(everyLatest.startedAt).toBeGreaterThan(customer.endedAt ?? Number.POSITIVE_INFINITY);
  });
  it('is cancelled where the switch did not choose that node, and its handler is never called', async () => {
    const { kernel, calls } = counting();
    const report = await kernel.run(card, { initial: { in: {} } });
    expect(calls.count).toBe(0);
    expect(report.nodes.customer.status).toBe('cancelled');
    expect(report.nodes.everyLatest.status).toBe('cancelled');
    expect(report.nodes.everyLatest.startedAt).toBeUndefined();
    expect(report.nodes.card.status).toBe('cancelled');
    expect(report).toMatchObject({ status: 'done', output: { said: 'no customer' }, answeredBy: 'noCustomer' });
  });
  it('never starts when that node refuses, and the run ends with the reason it gave', async () => {
    const { kernel, calls } = counting();
    const spec: KernelSpec = {
      name: 'site',
      output: ['read'],
      nodes: {
        session: call('refuse', { reason: 'unauthenticated', what: 'session' }),
        read: call('counted', { page: 'home' }, ['session']),
        registry: call('counted', {}, ['session']),
      },
    };
    const report = await kernel.run(spec);
    expect(calls.count).toBe(0);
    for (const id of ['read', 'registry']) {
      expect(report.nodes[id].status).toBe('cancelled');
      expect(report.nodes[id].startedAt).toBeUndefined();
    }
    expect(outcomeOf(report)).toEqual({
      kind: 'refused',
      reason: 'unauthenticated',
      message: 'no session',
      at: 'session',
    });
  });
  it('runs when the node it waits for is seeded', async () => {
    const { kernel, calls } = counting();
    const spec: KernelSpec = {
      name: 't',
      output: ['waiter'],
      nodes: { kept: call('boom'), waiter: call('counted', { said: 'waiter' }, ['kept']) },
    };
    const report = await kernel.run(spec, { initial: { kept: 'replayed' } });
    expect(report.status).toBe('done');
    expect(report.nodes.kept.status).toBe('seeded');
    expect(report.nodes.waiter).toMatchObject({ status: 'done', out: { said: 'waiter' } });
    expect(calls.count).toBe(1);
  });
  it('as a map, starts no element before the node it waits for has answered', async () => {
    const spec: KernelSpec = {
      name: 't',
      output: ['each'],
      nodes: {
        slow: call('sleep', { ms: 20, tag: 'slow' }),
        each: {
          kind: 'map',
          handler: 'echo',
          over: { value: ['a', 'b', 'c'] },
          in: {},
          onItemFailure: 'fail',
          after: ['slow'],
        },
      },
    };
    const report = await new Kernel(handlers).run(spec, { clock: ticking() });
    expect(report.status).toBe('done');
    expect(report.output).toEqual([{ item: 'a' }, { item: 'b' }, { item: 'c' }]);
    const answered = report.nodes.slow.endedAt ?? Number.POSITIVE_INFINITY;
    expect(report.nodes.each.startedAt).toBeGreaterThan(answered);
    for (const element of report.nodes.each.items ?? []) expect(element.startedAt).toBeGreaterThan(answered);
  });
});

describe('waitsFor', () => {
  it('names what a node reads, what it waits for under after, and the switch that routes it', () => {
    const routedBy = new Map([['everyLatest', 'isKept']]);
    const waits = waitsFor(card, routedBy, 'everyLatest', card.nodes.everyLatest);
    expect([...waits].sort()).toEqual(['customer', 'isKept']);
    expect([...waitsFor(card, new Map(), 'card', card.nodes.card)].sort()).toEqual(['customer', 'everyLatest']);
  });
});
