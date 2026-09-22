/**
 * What the kernel keeps of a call that was tried more than once, and the opaque tag it hands a handler. The
 * kernel never retries: a handler (the compiler's wrapper, in a tree) records the tries that did not stand
 * through `ctx.attempted`, and reads the site it was tagged with from `ctx.site`.
 */
import { describe, expect, it } from 'vitest';
import type { HandlerArgs, KernelSpec, Report, RunContext } from '../src/index.js';
import { Kernel } from '../src/index.js';
import { handlers } from './handlers.js';

/** A clock that answers 1, 2, 3, ... so two runs that read it the same way stamp the same. */
function counting(): () => number {
  let tick = 0;
  return () => ++tick;
}

const nested: Report = { graph: 'g', status: 'failed', nodes: {}, startedAt: 0, endedAt: 1 };

/** Records two tries that did not stand, the second with the nested run it was, then answers. */
async function flaky({ in: input, ctx }: HandlerArgs): Promise<unknown> {
  ctx.attempted({ startedAt: 1, endedAt: 2, error: 'first' });
  ctx.attempted({ startedAt: 3, endedAt: 4, error: 'second', sub: nested });
  return input.x;
}

/** Fails its element 1 once, as a wrapper that retried it would record. */
async function flakyAtOne({ in: input, ctx }: HandlerArgs): Promise<unknown> {
  if (input.item === 1) ctx.attempted({ startedAt: 1, endedAt: 2, error: 'once' });
  return input.item;
}

describe('attempts', () => {
  it('keeps every try a handler records on its node, in order, and the answer that stood', async () => {
    const spec: KernelSpec = {
      name: 't',
      output: ['a'],
      nodes: { a: { kind: 'call', handler: 'flaky', in: { x: { value: 7 } } } },
    };
    const report = await new Kernel({ flaky }).run(spec);
    expect(report.status).toBe('done');
    expect(report.output).toBe(7);
    expect(report.nodes.a.status).toBe('done');
    expect(report.nodes.a.attempts).toEqual([
      { startedAt: 1, endedAt: 2, error: 'first' },
      { startedAt: 3, endedAt: 4, error: 'second', sub: nested },
    ]);
  });
  it('keeps the tries of a map element on that element alone', async () => {
    const spec: KernelSpec = {
      name: 't',
      output: ['m'],
      nodes: { m: { kind: 'map', handler: 'flakyAtOne', over: { value: [0, 1, 2] }, in: {}, onItemFailure: 'fail' } },
    };
    const report = await new Kernel({ flakyAtOne }).run(spec);
    expect(report.output).toEqual([0, 1, 2]);
    const items = report.nodes.m.items ?? [];
    expect(items.map(item => item.attempts)).toEqual([
      undefined,
      [{ startedAt: 1, endedAt: 2, error: 'once' }],
      undefined,
    ]);
    expect(report.nodes.m.attempts).toBeUndefined();
  });
  it('leaves no attempts on a node that ran once: its report is what it was', async () => {
    const report = await new Kernel(handlers).run({
      name: 't',
      output: ['a'],
      nodes: { a: { kind: 'call', handler: 'double', in: { x: { value: 2 } } } },
    });
    expect('attempts' in report.nodes.a).toBe(false);
  });
});

describe('site', () => {
  /** Every context `looking` was handed, so a test can see what the kernel told it; it answers the site. */
  const seen: RunContext[] = [];
  const looking = async ({ ctx }: HandlerArgs) => {
    seen.push(ctx);
    return ctx.site ?? null;
  };

  /** A call and a map over the same handler, tagged or not. */
  function tagged(site: boolean): KernelSpec {
    const tag = (name: string) => (site ? { site: name } : {});
    return {
      name: 't',
      output: ['m'],
      nodes: {
        a: { kind: 'call', handler: 'looking', in: {}, ...tag('g#a') },
        m: {
          kind: 'map',
          handler: 'looking',
          over: { value: [1, 2] },
          in: { after: { ref: 'a', path: [] } },
          onItemFailure: 'fail',
          ...tag('g#m'),
        },
      },
    };
  }

  it("hands a call's and every map element's handler the tag its node carries", async () => {
    seen.length = 0;
    const report = await new Kernel({ looking }).run(tagged(true));
    expect(report.nodes.a.out).toBe('g#a');
    expect(report.output).toEqual(['g#m', 'g#m']);
  });
  it('hands no site to a handler whose node carries none', async () => {
    seen.length = 0;
    await new Kernel({ looking }).run(tagged(false));
    expect(seen.map(ctx => 'site' in ctx)).toEqual([false, false, false]);
  });
  it('never reads the tag: a spec with and without it runs to the same report', async () => {
    const quiet = async () => 'same';
    const withSite = await new Kernel({ looking: quiet }).run(tagged(true), { clock: counting() });
    const without = await new Kernel({ looking: quiet }).run(tagged(false), { clock: counting() });
    expect(withSite).toEqual(without);
  });
});
