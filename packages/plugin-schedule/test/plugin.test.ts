/**
 * The plugin as the runtime meets it: the documents it ships, the trigger kind's `encode`, and what the
 * `run` handler refuses when it is asked for something the tree cannot give it.
 */

import type { Report } from '@wilanis/engine';
import { leases } from '@wilanis/plugin-storage';
import { describe, expect, it } from 'vitest';
import schedule from '../src/index.js';
import { KIND, RUN } from '../src/paths.js';

const runtime = schedule.triggers?.[KIND];
const encode = (report: Partial<Report>) =>
  runtime?.encode?.(
    {} as never,
    { graph: 'g', status: 'done', nodes: {}, startedAt: 0, endedAt: 0, ...report } as Report,
  );

/** Run the `holds` handler against an environment a case built, as the kernel would. */
const run = (env: unknown, inputs: Record<string, unknown> = {}) =>
  schedule.handlers[RUN]({ in: inputs, ctx: { env, nodePath: [], attach: () => {} } } as never);

describe('what the plugin grants', () => {
  it('one port, one trigger kind, and its documents under docs/', () => {
    expect(schedule.root).toBe('@schedule');
    expect(Object.keys(schedule.handlers)).toEqual([RUN]);
    expect(Object.keys(schedule.triggers ?? {})).toEqual([KIND]);
    expect(schedule.docs).toMatch(/docs$/);
    expect(schedule.check).toBeTypeOf('function');
  });
});

describe('encode: the log line and wilanis run say the same thing about one report', () => {
  it('a done report answers its output', () => {
    expect(encode({ status: 'done', output: { count: 12 } })).toEqual({ count: 12 });
  });

  it('a refusal answers reason and message, plus whatever it carries', () => {
    expect(
      encode({
        status: 'failed',
        nodes: {
          asked: { status: 'failed', reason: 'missing', error: 'no such entry', detail: { id: '7' } } as never,
        },
      }),
    ).toEqual({ reason: 'missing', message: 'no such entry', id: '7' });
  });

  it('a fault with no reason is not a refusal: there is nothing to answer with', () => {
    expect(
      encode({ status: 'failed', nodes: { asked: { status: 'failed', error: 'fell over' } as never } }),
    ).toBeUndefined();
  });
});

describe('where the run step cannot do what it was asked', () => {
  it('run from a graph, with no tree to serve: it says where it belongs', async () => {
    await expect(run({})).rejects.toThrow(/runs from a project's startup list/);
  });

  it('a lease naming a connection this tree does not have', async () => {
    const env = { serving: { log: () => {}, triggers: () => [] }, hold: () => {}, connections: {} };
    await expect(run(env, { lease: '@connections/nope.connection.json' })).rejects.toThrow(
      /is not a connection of this tree/,
    );
  });

  it('a lease whose kind no plugin registered a keeper for: it names the connection and the kind', async () => {
    const env = {
      serving: { log: () => {}, triggers: () => [] },
      hold: () => {},
      connections: { '@connections/store.connection.json': { kind: '@somewhere/some.connection-kind.json' } },
    };
    await expect(run(env, { lease: '@connections/store.connection.json' })).rejects.toThrow(
      /no plugin registered a lease keeper for that kind/,
    );
  });

  it('a lease whose kind a keeper did register is taken, and the schedule is kept', async () => {
    const held: { label: string; stop: () => Promise<void> }[] = [];
    const connections = { '@connections/store.connection.json': { kind: '@keeper/kept.connection-kind.json' } };
    const env = {
      serving: { log: () => {}, triggers: () => [] },
      hold: (what: { label: string; stop: () => Promise<void> }) => held.push(what),
      connections,
    };
    leases(env).register('@keeper/kept.connection-kind.json', {
      acquire: async () => true,
      release: async () => {},
      lastFired: async () => undefined,
      markFired: async () => {},
    });
    const answer = await run(env, { lease: '@connections/store.connection.json' });
    expect(answer).toEqual({ triggers: 0 });
    expect(held.map(one => one.label)).toEqual(['schedule']);
    await held[0].stop();
  });
});

describe('the table of lease keepers', () => {
  it('is one per environment, created by whichever side reaches it first', () => {
    const env = { connections: {} };
    const keeper = {
      acquire: async () => true,
      release: async () => {},
      lastFired: async () => undefined,
      markFired: async () => {},
    };
    leases(env).register('@a/one.connection-kind.json', keeper);
    expect(leases(env).for('@a/one.connection-kind.json')).toBe(keeper);
    expect(leases(env).kinds).toEqual(['@a/one.connection-kind.json']);
    // a copy of the environment carrying the same connections finds the same table, as a handler's copy does
    expect(leases({ ...env, blobs: {} }).for('@a/one.connection-kind.json')).toBe(keeper);
    // another environment starts clean, so a reload holds nothing of the last tree
    expect(leases({ connections: {} }).for('@a/one.connection-kind.json')).toBeUndefined();
  });
});
