/**
 * A seeded node in a replay is shown as it would have been had it run: its report, every read of it, and the answer
 * a nested run hangs on its caller show its value redacted by its operation's paths, while the run hands the value
 * itself to whatever reads it. So does a seeded element of a map, and a map seeded whole.
 */
import { describe, expect, it } from 'vitest';
import type { HandlerArgs, KernelSpec, Report } from '../src/index.js';
import { Kernel } from '../src/index.js';

const SECRET = '«secret»';

const account = { name: 'ada', password: 'p-ada' };
const shown = { name: 'ada', password: SECRET };
const bob = { name: 'bob', password: 'p-bob' };

/** A node that answers an account whose password its operation marks secret. */
const made = { kind: 'call', handler: 'account', in: {}, redact: { out: [['password']] } } as const;
const handlers = {
  account: async () => ({ ...bob }),
  echo: async ({ in: input }: HandlerArgs) => input,
};

describe('a seeded node', () => {
  const spec: KernelSpec = {
    name: 't',
    output: ['passed'],
    nodes: { made, passed: { kind: 'call', handler: 'echo', in: { value: { ref: 'made', path: [] } } } },
  };

  it("is shown by its operation's marks, in its own report and in every read of it", async () => {
    const report = await new Kernel(handlers).run(spec, { initial: { made: { ...account } } });
    expect(report.nodes.made).toEqual({ status: 'seeded', out: shown });
    expect(report.nodes.passed.in).toEqual({ value: shown });
    // the run hands on the value it was given
    expect(report.output).toEqual({ value: account });
  });

  it('is shown as the marker in the answer a nested run hangs on its caller, where it answered that run', async () => {
    const inner: KernelSpec = { name: 'inner', output: ['made'], nodes: { made } };
    /** A graph-bound operation whose nested run is a replay: the node that answers it is seeded. */
    const nested = async ({ ctx }: HandlerArgs) => {
      const report: Report = await new Kernel(handlers).run(inner, { initial: { made: { ...account } } });
      ctx.attach(report);
      return report.output;
    };
    const outer: KernelSpec = {
      name: 'outer',
      output: ['ran'],
      nodes: { ran: { kind: 'call', handler: 'nested', in: {} } },
    };
    const report = await new Kernel({ ...handlers, nested }).run(outer, {});
    expect(report.nodes.ran.sub?.output).toEqual(shown);
    expect(report.nodes.ran.out).toEqual(shown);
    expect(report.output).toEqual(account);
  });
});

describe('a seeded element of a map', () => {
  it('is shown by what the operation marks of its answer, and hands on its value', async () => {
    const spec: KernelSpec = {
      name: 't',
      output: ['each'],
      nodes: {
        each: {
          kind: 'map',
          handler: 'account',
          over: { value: ['ada', 'bob'] },
          in: {},
          onItemFailure: 'fail',
          redact: { out: [['password']] },
        },
      },
    };
    const report = await new Kernel(handlers).run(spec, { initial: { 'each.0': { ...account } } });
    expect(report.nodes.each.items?.[0]).toEqual({ status: 'seeded', out: shown });
    expect(report.nodes.each.out).toEqual([shown, { name: 'bob', password: SECRET }]);
    expect(report.output).toEqual([account, bob]);
  });
});

describe('a map seeded whole', () => {
  it("is shown by the operation's marks on each element, under value where failures are collected", async () => {
    const spec: KernelSpec = {
      name: 't',
      output: ['each'],
      nodes: {
        each: {
          kind: 'map',
          handler: 'account',
          over: { value: ['ada', 'bob'] },
          in: {},
          onItemFailure: 'collect',
          redact: { out: [['password']] },
        },
      },
    };
    const collected = [
      { ok: true, value: { ...account } },
      { ok: false, error: 'gone' },
    ];
    const report = await new Kernel(handlers).run(spec, { initial: { each: collected } });
    expect(report.nodes.each).toEqual({ status: 'seeded', out: [{ ok: true, value: shown }, collected[1]] });
    expect(report.output).toEqual(collected);
  });
});
