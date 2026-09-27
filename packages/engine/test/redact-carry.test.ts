/**
 * A value made from a marked read carries the mark. A node whose operation hands back what it read, under a type
 * that marks nothing, shows the marker wherever its answer holds the value it read as the marker, and so does
 * every read of it; text that interpolates a marked read is the marker whole. The engine never learns what an
 * operation does: it compares what a node answers with what its report shows it read. A node whose answer does
 * not hold what it read shows its answer as it is.
 */
import { describe, expect, it } from 'vitest';
import type { HandlerArgs, KernelSpec, KNode } from '../src/index.js';
import { Kernel } from '../src/index.js';

const SECRET = '«secret»';

const account = { name: 'ada', password: 'p-ada' };
const shownIn = { in: { name: 'ada', password: SECRET } };

/** A call of `handler` with these inputs, whose operation marks nothing. */
const call = (handler: string, input: Record<string, unknown>): KNode => ({
  kind: 'call',
  handler,
  in: input as never,
});
const read = (ref: string, ...path: string[]) => ({ ref, path });

const handlers = {
  /** `@std/object.port.json#make`: the value, as the declared type. */
  make: async ({ in: input }: HandlerArgs) => input.value,
  echo: async ({ in: input }: HandlerArgs) => input,
  upper: async ({ in: input }: HandlerArgs) => String(input.value).toUpperCase(),
  size: async ({ in: input }: HandlerArgs) => String(input.value).length,
};

/** One run of the spec over the account as `in`, its password shown as the marker as a caller's report shows it. */
const run = (spec: KernelSpec) => new Kernel(handlers).run(spec, { initial: { in: { ...account } }, shown: shownIn });

describe('a value made from a marked read', () => {
  it('is the marker in the answer of a node that hands it back typed as a plain string, and in every read of it', async () => {
    const spec: KernelSpec = {
      name: 't',
      output: ['passed'],
      nodes: {
        made: call('make', { value: read('in', 'password') }),
        passed: call('echo', { value: read('made') }),
        routed: {
          kind: 'switch',
          in: { password: read('made') },
          rules: [{ when: input => input.password === 'p-ada', to: 'passed', label: 'right' }],
          else: 'passed',
        },
      },
    };
    const report = await run(spec);
    expect(report.nodes.made.in).toEqual({ value: SECRET });
    expect(report.nodes.made.out).toBe(SECRET);
    expect(report.nodes.routed.in).toEqual({ password: SECRET });
    expect(report.nodes.passed.in).toEqual({ value: SECRET });
    expect(report.nodes.passed.out).toEqual({ value: SECRET });
    // the run hands on the values, and the switch decides on them
    expect(report.nodes.routed.selected).toBe('passed');
    expect(report.output).toEqual({ value: 'p-ada' });
  });

  it('is the marker where an answer holds it among fields that are not marked', async () => {
    const spec: KernelSpec = {
      name: 't',
      output: ['made'],
      nodes: { made: call('make', { value: { object: { who: read('in', 'name'), pw: read('in', 'password') } } }) },
    };
    const report = await run(spec);
    expect(report.nodes.made.out).toEqual({ who: 'ada', pw: SECRET });
    expect(report.output).toEqual({ who: 'ada', pw: 'p-ada' });
  });

  it('is the marker where a node hands back a whole value that holds a marked field', async () => {
    const spec: KernelSpec = { name: 't', output: ['made'], nodes: { made: call('make', { value: read('in') }) } };
    const report = await run(spec);
    expect(report.nodes.made.out).toEqual({ name: 'ada', password: SECRET });
  });

  it('is the marker where the operation itself marks what it is handed, and hands it back', async () => {
    const spec: KernelSpec = {
      name: 't',
      output: ['opened'],
      nodes: { opened: { ...call('make', { value: { value: 'k-1' } }), redact: { in: [['value']], out: [] } } },
    };
    const report = await new Kernel(handlers).run(spec, {});
    expect(report.nodes.opened.in).toEqual({ value: SECRET });
    expect(report.nodes.opened.out).toBe(SECRET);
    expect(report.output).toBe('k-1');
  });

  it('is shown as its operation answers it where the answer does not hold it', async () => {
    const spec: KernelSpec = {
      name: 't',
      output: ['sized'],
      nodes: { sized: call('size', { value: read('in', 'password') }) },
    };
    const report = await run(spec);
    expect(report.nodes.sized.in).toEqual({ value: SECRET });
    expect(report.nodes.sized.out).toBe(5);
  });
});

describe('text that interpolates a marked read', () => {
  const bearer = { concat: ['Bearer ', read('in', 'password')] };

  it('is the marker whole in the report of the node it is handed to, and the handler is handed the text', async () => {
    const spec: KernelSpec = { name: 't', output: ['made'], nodes: { made: call('make', { value: bearer }) } };
    const report = await run(spec);
    expect(report.nodes.made.in).toEqual({ value: SECRET });
    expect(report.nodes.made.out).toBe(SECRET);
    expect(report.output).toBe('Bearer p-ada');
  });

  it('is the marker whole where it interpolates a node that carried the mark', async () => {
    const spec: KernelSpec = {
      name: 't',
      output: ['header'],
      nodes: {
        made: call('make', { value: read('in', 'password') }),
        header: call('make', { value: { concat: ['Basic ', read('made')] } }),
      },
    };
    const report = await run(spec);
    expect(report.nodes.header.in).toEqual({ value: SECRET });
    expect(report.nodes.header.out).toBe(SECRET);
    expect(report.output).toBe('Basic p-ada');
  });

  it('is the marker whole in a switch that reads it', async () => {
    const spec: KernelSpec = {
      name: 't',
      output: ['ok'],
      nodes: {
        checked: { kind: 'switch', in: { header: bearer }, rules: [], else: 'ok' },
        ok: call('make', { value: { value: 'ok' } }),
      },
    };
    const report = await run(spec);
    expect(report.nodes.checked.in).toEqual({ header: SECRET });
  });

  it('is shown as it is where nothing it interpolates is marked', async () => {
    const spec: KernelSpec = {
      name: 't',
      output: ['made'],
      nodes: { made: call('make', { value: { concat: ['Hello ', read('in', 'name')] } }) },
    };
    const report = await run(spec);
    expect(report.nodes.made.in).toEqual({ value: 'Hello ada' });
    expect(report.nodes.made.out).toBe('Hello ada');
  });
});

describe('a map whose elements hand back a marked read', () => {
  it('shows the marker in each element and in its answer', async () => {
    const spec: KernelSpec = {
      name: 't',
      output: ['each'],
      nodes: {
        each: {
          kind: 'map',
          handler: 'echo',
          over: { value: ['a', 'b'] },
          in: { key: read('in', 'password') },
          onItemFailure: 'fail',
        },
      },
    };
    const report = await run(spec);
    const shown = [
      { key: SECRET, item: 'a' },
      { key: SECRET, item: 'b' },
    ];
    expect(report.nodes.each.items?.map(item => item.out)).toEqual(shown);
    expect(report.nodes.each.out).toEqual(shown);
    expect(report.output).toEqual([
      { key: 'p-ada', item: 'a' },
      { key: 'p-ada', item: 'b' },
    ]);
  });
});

describe('a seeded node that hands back a marked read', () => {
  it('shows the marker, as it would have had it run, where what it reads is supplied', async () => {
    const spec: KernelSpec = {
      name: 't',
      output: ['passed'],
      nodes: {
        made: call('make', { value: read('in', 'password') }),
        header: call('make', { value: { concat: ['Basic ', read('made')] } }),
        passed: call('upper', { value: read('header') }),
      },
    };
    const initial = { in: { ...account }, made: 'p-ada', header: 'Basic p-ada' };
    const report = await new Kernel(handlers).run(spec, { initial, shown: shownIn });
    expect(report.nodes.made).toEqual({ status: 'seeded', out: SECRET });
    expect(report.nodes.header).toEqual({ status: 'seeded', out: SECRET });
    expect(report.nodes.passed.in).toEqual({ value: SECRET });
    expect(report.output).toBe('BASIC P-ADA');
  });
});
