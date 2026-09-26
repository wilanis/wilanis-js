/**
 * A read shows what its source's report shows. A node's report of what it was given is read over what every
 * earlier report showed rather than over the values themselves, so a field the node that made it marks secret is
 * the marker in every report that reads it: a switch's inputs, a call whose operation marks nothing, a map's list
 * and its elements, and a nested run's input, which the calling node's report hands down.
 */
import { describe, expect, it } from 'vitest';
import type { HandlerArgs, KernelSpec, Report } from '../src/index.js';
import { Kernel } from '../src/index.js';

const SECRET = '«secret»';

const account = { name: 'ada', password: 'p-ada' };
const shown = { name: 'ada', password: SECRET };

/** A node that answers an account whose password its operation marks secret. */
const made = { kind: 'call', handler: 'account', in: {}, redact: { out: [['password']] } } as const;
const handlers = {
  account: async () => ({ ...account }),
  echo: async ({ in: input }: HandlerArgs) => input,
  named: async ({ in: input }: HandlerArgs) => String((input.item as { name: string }).name),
};

describe('a read of a node whose answer carries a secret', () => {
  it("is the marker in a switch's inputs, which no operation marks", async () => {
    const spec: KernelSpec = {
      name: 't',
      output: ['ok'],
      nodes: {
        made,
        checked: {
          kind: 'switch',
          in: { name: { ref: 'made', path: ['name'] }, password: { ref: 'made', path: ['password'] } },
          rules: [{ when: () => true, to: 'ok', label: 'always' }],
          else: 'ok',
        },
        ok: { kind: 'call', handler: 'echo', in: { name: { ref: 'made', path: ['name'] } } },
      },
    };
    const report = await new Kernel(handlers).run(spec, {});
    expect(report.nodes.checked.in).toEqual({ name: 'ada', password: SECRET });
  });

  it('is the marker in the input of a call whose operation marks nothing, whole or below a field', async () => {
    const spec: KernelSpec = {
      name: 't',
      output: ['passed'],
      nodes: {
        made,
        passed: {
          kind: 'call',
          handler: 'echo',
          in: { value: { ref: 'made', path: [] }, secret: { ref: 'made', path: ['password'] } },
        },
      },
    };
    const report = await new Kernel(handlers).run(spec, {});
    expect(report.nodes.passed.in).toEqual({ value: shown, secret: SECRET });
    // the handler is handed the values themselves
    expect(report.output).toEqual({ value: account, secret: 'p-ada' });
  });

  it("is the marker in a map's list and in each element it hands on, however the element is bound", async () => {
    const listed = { kind: 'call', handler: 'accounts', in: {}, redact: { out: [['password']] } } as const;
    const spec: KernelSpec = {
      name: 't',
      output: ['whole'],
      nodes: {
        listed,
        whole: { kind: 'map', handler: 'named', over: { ref: 'listed', path: [] }, in: {}, onItemFailure: 'fail' },
        bound: {
          kind: 'map',
          handler: 'echo',
          over: { ref: 'listed', path: [] },
          in: {},
          bind: { who: ['name'], login: [] },
          onItemFailure: 'fail',
        },
      },
    };
    const accounts = async () => [{ ...account }, { name: 'bob', password: 'p-bob' }];
    const report = await new Kernel({ ...handlers, accounts }).run(spec, {});
    const redacted = [shown, { name: 'bob', password: SECRET }];
    expect(report.nodes.whole.in).toEqual({ over: redacted });
    expect(report.nodes.whole.items?.map(item => item.in)).toEqual([{ item: shown }, { item: redacted[1] }]);
    expect(report.nodes.bound.items?.[0].in).toEqual({ who: 'ada', login: shown });
    expect(report.output).toEqual(['ada', 'bob']);
  });
});

describe('a switch reading a secret', () => {
  it('routes on the value, while its report shows the marker', async () => {
    const spec: KernelSpec = {
      name: 't',
      output: ['right', 'wrong'],
      nodes: {
        made,
        checked: {
          kind: 'switch',
          in: { password: { ref: 'made', path: ['password'] } },
          rules: [{ when: input => input.password === 'p-ada', to: 'right', label: 'the password' }],
          else: 'wrong',
        },
        right: { kind: 'call', handler: 'echo', in: { name: { ref: 'made', path: ['name'] } } },
        wrong: { kind: 'call', handler: 'echo', in: {} },
      },
    };
    const report = await new Kernel(handlers).run(spec, {});
    expect(report.nodes.checked.selected).toBe('right');
    expect(report.nodes.checked.in).toEqual({ password: SECRET });
  });
});

describe('a map over a list its source marks whole', () => {
  it('shows each element as the marker, and hands each its value', async () => {
    const spec: KernelSpec = {
      name: 't',
      output: ['each'],
      nodes: {
        coded: { kind: 'call', handler: 'codes', in: {}, redact: { out: [['codes']] } },
        each: { kind: 'map', handler: 'echo', over: { ref: 'coded', path: ['codes'] }, in: {}, onItemFailure: 'fail' },
      },
    };
    const codes = async () => ({ codes: ['c-1', 'c-2'] });
    const report = await new Kernel({ ...handlers, codes }).run(spec, {});
    expect(report.nodes.each.items?.map(item => item.in)).toEqual([{ item: SECRET }, { item: SECRET }]);
    expect(report.output).toEqual([{ item: 'c-1' }, { item: 'c-2' }]);
  });
});

describe("a nested run's input", () => {
  const inner: KernelSpec = {
    name: 'inner',
    output: ['used'],
    nodes: { used: { kind: 'call', handler: 'echo', in: { value: { ref: 'in', path: [] } } } },
  };

  it('is shown as the run is told it is shown, while its nodes are handed the value', async () => {
    const report = await new Kernel(handlers).run(inner, { initial: { in: 'k-1' }, shown: { in: SECRET } });
    expect(report.nodes.used.in).toEqual({ value: SECRET });
    expect(report.output).toEqual({ value: 'k-1' });
  });

  it("is the calling node's report of what it handed down, through the handler's context", async () => {
    /** A graph-bound operation as the compiler registers one, taking its input whole under `in`. */
    const nested = async ({ in: input, ctx }: HandlerArgs) => {
      const report: Report = await new Kernel(handlers).run(inner, {
        initial: { in: input.in },
        shown: { in: ctx.shownIn?.in },
      });
      ctx.attach(report);
      return report.output;
    };
    const spec: KernelSpec = {
      name: 'outer',
      output: ['ran'],
      nodes: { ran: { kind: 'call', handler: 'nested', in: { in: { value: 'k-1' } }, redact: { in: [['in']] } } },
    };
    const report = await new Kernel({ ...handlers, nested }).run(spec, {});
    expect(report.nodes.ran.in).toEqual({ in: SECRET });
    expect(report.nodes.ran.sub?.nodes.used.in).toEqual({ value: SECRET });
    expect(report.output).toEqual({ value: 'k-1' });
  });
});
