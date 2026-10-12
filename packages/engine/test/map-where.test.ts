/**
 * A map with a `where` (RFC 0039): the rule is tried over each element, as `item`, and over the map's `in` as the
 * element starts. A kept element runs, or answers itself where the map has no handler; a dropped one is `cancelled`
 * with `kept: false`, never runs, is left out of the answer and fails nothing.
 */
import { describe, expect, it } from 'vitest';
import type { HandlerArgs, KernelSpec, KMap } from '../src/index.js';
import { Kernel, outcomeOf } from '../src/index.js';
import { handlers } from './handlers.js';

/** A rule over the values the kernel hands it, labelled as its author would have written it. */
const rule = (label: string, when: (values: Record<string, unknown>) => boolean): KMap['where'] => ({ when, label });

/** Keeps an even number. */
const even = rule('item % 2 == 0', values => Number(values.item) % 2 === 0);

/** A map named `m` over the literal list, keeping by `where`, with the fields given. */
function keep(over: unknown[], where: KMap['where'], fields: Partial<KMap> = {}): KernelSpec {
  return {
    name: 't',
    output: ['m'],
    nodes: { m: { kind: 'map', over: { value: over }, in: {}, onItemFailure: 'fail', where, ...fields } },
  };
}

/** A handler that doubles `x` and records each element it was called for. */
function counted() {
  const ran: unknown[] = [];
  const double = async ({ in: input }: HandlerArgs) => {
    ran.push(input.x);
    return Number(input.x) * 2;
  };
  return { double, ran };
}

describe('a map with a where and a handler', () => {
  it('runs only the kept elements and answers their results in order', async () => {
    const calls = counted();
    const spec = keep([1, 2, 3, 4], even, { handler: 'double', bind: { x: [] } });
    const report = await new Kernel({ double: calls.double }).run(spec);
    expect(report.status).toBe('done');
    expect(report.output).toEqual([4, 8]);
    expect(calls.ran).toEqual([2, 4]);
    expect(report.nodes.m.out).toEqual([4, 8]);
    expect(report.nodes.m.items?.map(item => [item.status, item.kept])).toEqual([
      ['cancelled', false],
      ['done', true],
      ['cancelled', false],
      ['done', true],
    ]);
  });

  it('reads the element as item whatever bind hands the operation, beside the shared inputs', async () => {
    const above = rule('item.n > floor', values => (values.item as { n: number }).n > Number(values.floor));
    const spec = keep([{ n: 1 }, { n: 5 }], above, {
      handler: 'double',
      bind: { x: ['n'] },
      in: { floor: { value: 2 } },
    });
    const report = await new Kernel(handlers).run(spec);
    expect(report.output).toEqual([10]);
  });

  it('never calls the handler of a dropped element, whose report says it never ran', async () => {
    const calls = counted();
    const report = await new Kernel({ double: calls.double }).run(
      keep([1], even, { handler: 'double', bind: { x: [] } }),
    );
    expect(calls.ran).toEqual([]);
    expect(report.nodes.m.items).toEqual([{ status: 'cancelled', kept: false }]);
  });
});

describe('a map with a where and no handler', () => {
  it('answers the kept elements themselves, each done with itself as its out', async () => {
    const report = await new Kernel({}).run(keep([1, 2, 3, 4], even), { clock: () => 7 });
    expect(report.status).toBe('done');
    expect(report.output).toEqual([2, 4]);
    expect(report.nodes.m.handler).toBeUndefined();
    expect(report.nodes.m.items?.[1]).toEqual({ status: 'done', kept: true, out: 2, startedAt: 7, endedAt: 7 });
  });

  it('shows a kept element as the report of the list shows it', async () => {
    const secret = '«secret»';
    const spec = keep(
      [],
      rule('item.keep', values => (values.item as { keep: boolean }).keep),
      {
        over: { ref: 'in', path: ['list'] },
      },
    );
    const list = [
      { keep: true, token: 't-1' },
      { keep: false, token: 't-2' },
    ];
    const report = await new Kernel({}).run(spec, {
      initial: { in: { list } },
      shown: {
        in: {
          list: [
            { keep: true, token: secret },
            { keep: false, token: secret },
          ],
        },
      },
    });
    expect(report.output).toEqual([{ keep: true, token: 't-1' }]);
    expect(report.nodes.m.items?.[0].out).toEqual({ keep: true, token: secret });
    expect(report.nodes.m.out).toEqual([{ keep: true, token: secret }]);
  });

  it('answers [] when the rule keeps nothing', async () => {
    const report = await new Kernel({}).run(keep([1, 3, 5], even));
    expect(report.status).toBe('done');
    expect(report.output).toEqual([]);
    expect(report.nodes.m.items?.every(item => item.status === 'cancelled' && item.kept === false)).toBe(true);
  });
});

describe('a dropped element', () => {
  it('does not fail a map under fail', async () => {
    const report = await new Kernel(handlers).run(keep([1, 2], even, { handler: 'double', bind: { x: [] } }));
    expect(report.status).toBe('done');
    expect(report.nodes.m.status).toBe('done');
    expect(outcomeOf(report)).toEqual({ kind: 'answered', output: [4] });
  });

  it('is left out of what collect answers: only the kept outcomes, in order', async () => {
    const odd = rule('item.ms != 2', values => (values.item as { ms: number }).ms !== 2);
    const spec = keep(
      [
        { ms: 1, tag: 'a' },
        { ms: 2, tag: 'dropped' },
        { ms: 3, tag: 'boom' },
      ],
      odd,
      { handler: 'sleepOrBoom', bind: { ms: ['ms'], tag: ['tag'] }, onItemFailure: 'collect' },
    );
    const report = await new Kernel(handlers).run(spec);
    expect(report.status).toBe('done');
    expect(report.output).toEqual([
      { ok: true, value: 'a' },
      { ok: false, error: 'boom' },
    ]);
    expect(report.nodes.m.out).toEqual(report.output);
  });
});

describe('a where beside limit and seeds', () => {
  it('judges limit against the length of over, before any rule is tried', async () => {
    let tried = 0;
    const counting = rule('true', () => ++tried > 0);
    const report = await new Kernel({}).run(keep([1, 2, 3], counting, { limit: 2 }));
    expect(report.status).toBe('failed');
    expect(outcomeOf(report)).toEqual({ kind: 'faulted', at: 'm', error: "map 'm': 3 elements, limit 2" });
    expect(tried).toBe(0);
  });

  it('keeps a seeded element, which has an answer, and keeps its index for the others', async () => {
    const calls = counted();
    const spec = keep([1, 2, 3, 4], even, { handler: 'double', bind: { x: [] } });
    const report = await new Kernel({ double: calls.double }).run(spec, { initial: { 'm.0': 'seeded' } });
    expect(report.output).toEqual(['seeded', 4, 8]);
    expect(calls.ran).toEqual([2, 4]);
    expect(report.nodes.m.items?.map(item => [item.status, item.kept])).toEqual([
      ['seeded', true],
      ['done', true],
      ['cancelled', false],
      ['done', true],
    ]);
  });
});

describe('a rule that throws', () => {
  const throws = rule('item.a.b', values => {
    if (values.item === 2) throw new Error('cannot read b');
    return true;
  });

  it('is a fault of that element: under fail the map fails, naming the element', async () => {
    const report = await new Kernel({}).run(keep([1, 2, 3], throws, { concurrency: 1 }));
    expect(report.status).toBe('failed');
    expect(report.nodes.m.error).toBe("map 'm' element 1: cannot read b");
    expect(report.nodes.m.items?.map(item => [item.status, item.kept])).toEqual([
      ['done', true],
      ['failed', undefined],
      ['cancelled', undefined],
    ]);
  });

  it('is that element failed under collect, while the others answer', async () => {
    const report = await new Kernel({}).run(keep([1, 2, 3], throws, { onItemFailure: 'collect' }));
    expect(report.status).toBe('done');
    expect(report.output).toEqual([
      { ok: true, value: 1 },
      { ok: false, error: 'cannot read b' },
      { ok: true, value: 3 },
    ]);
  });
});
