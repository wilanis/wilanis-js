import { describe, expect, it } from 'vitest';
import type { KernelSpec, KNode, KSwitch, Report } from '../src/index.js';
import { Kernel, outcomeOf } from '../src/index.js';
import { handlers } from './handlers.js';

const kernel = new Kernel(handlers);

/** A call of `handler` with literal inputs. */
function call(handler: string, inputs: Record<string, unknown> = {}): KNode {
  const inn = Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, { value }]));
  return { kind: 'call', handler, in: inn };
}

/** The guide's `route`: 200 is the row, anything else failed, and `asked` breaking goes to `unreachable`. */
function route(catches: Record<string, string> | null = { asked: 'unreachable' }): KSwitch {
  return {
    kind: 'switch',
    in: { status: { ref: 'asked', path: ['status'] }, id: { ref: 'in', path: ['id'] } },
    rules: [{ when: values => values.status === 200, to: 'row', label: 'status == 200' }],
    else: 'failed',
    ...(catches ? { catch: catches } : {}),
  };
}

/** get-row, with `asked` and `unreachable` as given: `row` echoes what asked answered, `failed` refuses upstream. */
function getRow(asked: KNode, unreachable: KNode = call('echo', { said: 'unreachable' })): KernelSpec {
  return {
    name: 'get-row',
    output: ['row', 'failed', 'unreachable'],
    nodes: {
      asked,
      route: route(),
      row: { kind: 'call', handler: 'echo', in: { status: { ref: 'asked', path: ['status'] } } },
      failed: call('refuse', { reason: 'upstream', what: 'good answer' }),
      unreachable,
    },
  };
}

/** Every node's status, by id. */
function statuses(report: Report): Record<string, string> {
  return Object.fromEntries(Object.entries(report.nodes).map(([id, node]) => [id, node.status]));
}

const initial = { in: { id: 'golf' } };

describe('a switch that catches a fault', () => {
  it('routes the broken node to its catch target, and the run goes on', async () => {
    const report = await kernel.run(getRow(call('boom')), { initial });
    expect(report.status).toBe('done');
    expect(report.output).toEqual({ said: 'unreachable' });
    expect(report.nodes.asked).toMatchObject({ status: 'failed', error: 'boom', caught: 'route' });
    // the rules were not tried: `in` holds what was present, and asked left nothing
    expect(report.nodes.route).toMatchObject({ status: 'done', selected: 'unreachable', in: { id: 'golf' } });
    // nothing is cancelled but the switch's other targets
    expect(statuses(report)).toEqual({
      asked: 'failed',
      route: 'done',
      row: 'cancelled',
      failed: 'cancelled',
      unreachable: 'done',
    });
    expect(outcomeOf(report)).toEqual({ kind: 'answered', output: { said: 'unreachable' } });
  });
  it('answers the refusal its target declares, not the caught fault', async () => {
    const refuse = call('refuse', { reason: 'upstream', what: 'answer from the API' });
    const report = await kernel.run(getRow(call('boom'), refuse), { initial });
    expect(report.status).toBe('failed');
    expect(report.nodes.asked.caught).toBe('route');
    expect(outcomeOf(report)).toEqual({
      kind: 'refused',
      reason: 'upstream',
      message: 'no answer from the API',
      at: 'unreachable',
    });
  });
  it('never catches a refusal: the run ends with its reason and the switch never runs', async () => {
    for (const handler of ['refuse', 'refuseForeign']) {
      const report = await kernel.run(getRow(call(handler, { reason: 'missing', what: 'customer' })), { initial });
      expect(report.status).toBe('failed');
      expect(report.nodes.asked).toMatchObject({ status: 'failed', reason: 'missing' });
      expect(report.nodes.asked.caught).toBeUndefined();
      expect(report.nodes.route.status).toBe('cancelled');
      expect(report.nodes.route.startedAt).toBeUndefined();
      expect(outcomeOf(report)).toMatchObject({ kind: 'refused', reason: 'missing', at: 'asked' });
    }
  });
  it('whose node answers tries its rules as before, and reports what it would with no catch', async () => {
    const asked = call('echo', { status: 200 });
    const caught = await kernel.run(getRow(asked), { initial });
    const plain = getRow(asked);
    plain.nodes.route = route(null);
    delete plain.nodes.unreachable;
    const before = await kernel.run(plain, { initial });
    expect(caught.status).toBe('done');
    expect(caught.output).toEqual({ status: 200 });
    expect(caught.nodes.unreachable.status).toBe('cancelled');
    for (const id of ['asked', 'route', 'row', 'failed']) {
      const { startedAt: _s, endedAt: _e, ...now } = caught.nodes[id];
      const { startedAt: _t, endedAt: _f, ...then } = before.nodes[id];
      expect(now).toEqual(then);
    }
    expect('caught' in caught.nodes.asked).toBe(false);
  });
  it('that catches two broken nodes routes on the first in catch order', async () => {
    const spec: KernelSpec = {
      name: 't',
      output: ['first', 'second', 'fine'],
      nodes: {
        one: call('boom'),
        two: call('boom'),
        pick: {
          kind: 'switch',
          in: { one: { ref: 'one', path: [] }, two: { ref: 'two', path: [] } },
          rules: [],
          else: 'fine',
          catch: { two: 'second', one: 'first' },
        },
        first: call('echo', { at: 'first' }),
        second: call('echo', { at: 'second' }),
        fine: call('echo', { at: 'fine' }),
      },
    };
    const report = await kernel.run(spec);
    expect(report.nodes.pick.selected).toBe('second');
    expect(report.output).toEqual({ at: 'second' });
    expect(report.nodes.one.caught).toBe('pick');
    expect(report.nodes.two.caught).toBe('pick');
  });
  it('whose own branch was not chosen catches nothing: the fault ends the run', async () => {
    const spec = getRow(call('boom'));
    spec.nodes.gate = {
      kind: 'switch',
      in: {},
      rules: [{ when: () => false, to: 'route', label: 'never' }],
      else: 'elsewhere',
    };
    spec.nodes.elsewhere = call('sleep', { ms: 20, tag: 'elsewhere' });
    spec.nodes.asked = call('sleepOrBoom', { ms: 10, tag: 'boom' });
    const report = await kernel.run(spec, { initial });
    expect(report.nodes.route.status).toBe('cancelled');
    expect(report.nodes.asked.caught).toBeUndefined();
    expect(report.status).toBe('failed');
    expect(outcomeOf(report)).toEqual({ kind: 'faulted', at: 'asked', error: 'boom' });
  });
});

describe('a map a switch catches', () => {
  /** A map sleeping on each tag, the one tagged `boom` breaking, and a switch catching it. */
  function mapped(onItemFailure: 'fail' | 'collect'): KernelSpec {
    return {
      name: 't',
      output: ['all', 'broke'],
      nodes: {
        each: {
          kind: 'map',
          handler: 'sleepOrBoom',
          over: { value: ['a', 'boom', 'c'] },
          in: { ms: { value: 1 } },
          bind: { tag: [] },
          onItemFailure,
        },
        route: {
          kind: 'switch',
          in: { each: { ref: 'each', path: [] } },
          rules: [],
          else: 'all',
          catch: { each: 'broke' },
        },
        all: { kind: 'call', handler: 'echo', in: { each: { ref: 'each', path: [] } } },
        broke: call('echo', { said: 'an element broke' }),
      },
    };
  }
  it('under fail is caught whole: the map is failed and caught, and the switch routes it', async () => {
    const report = await kernel.run(mapped('fail'));
    expect(report.status).toBe('done');
    expect(report.nodes.each).toMatchObject({ status: 'failed', caught: 'route' });
    expect(report.nodes.each.items?.map(item => item.status)).toEqual(['done', 'failed', 'done']);
    expect(report.nodes.route.selected).toBe('broke');
    expect(report.output).toEqual({ said: 'an element broke' });
  });
  it('under collect answers every outcome, and nothing is caught', async () => {
    const report = await kernel.run(mapped('collect'));
    expect(report.nodes.each.status).toBe('done');
    expect(report.nodes.each.caught).toBeUndefined();
    expect(report.nodes.route.selected).toBe('all');
  });
});

describe('a caught fault and a cancelled run', () => {
  it('a fault landing after the abort is marked caught, the switch never runs, and the run is cancelled', async () => {
    const control = new AbortController();
    setTimeout(() => control.abort(), 20);
    const report = await kernel.run(getRow(call('sleepOrBoom', { ms: 60, tag: 'boom' })), {
      initial,
      signal: control.signal,
    });
    expect(report.status).toBe('cancelled');
    expect(report.nodes.asked).toMatchObject({ status: 'failed', error: 'boom', caught: 'route' });
    expect(report.nodes.route.status).toBe('cancelled');
    expect(report.nodes.route.startedAt).toBeUndefined();
    expect(outcomeOf(report)).toEqual({ kind: 'cancelled' });
  });
  it('a caught fault routes, and an abort after it cancels the run: the outcome is cancelled, not the fault', async () => {
    const control = new AbortController();
    setTimeout(() => control.abort(), 20);
    const waiting = call('abortable', { ms: 1000, tag: 'late' });
    const report = await kernel.run(getRow(call('boom'), waiting), { initial, signal: control.signal });
    expect(report.status).toBe('cancelled');
    expect(report.nodes.asked).toMatchObject({ status: 'failed', caught: 'route' });
    expect(report.nodes.route.selected).toBe('unreachable');
    expect(report.nodes.unreachable).toMatchObject({ status: 'failed', error: 'This operation was aborted' });
    expect(report.nodes.unreachable.caught).toBeUndefined();
    expect(outcomeOf(report)).toEqual({ kind: 'cancelled' });
  });
});
