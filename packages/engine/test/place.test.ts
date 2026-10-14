import { describe, expect, it } from 'vitest';
import type { Handler, KernelSpec, RunOptions } from '../src/index.js';
import { Kernel, NodePlace } from '../src/index.js';

/** One node, `down`, handed what is `left` of the depth to go. */
const spec: KernelSpec = {
  name: 'down',
  output: ['down'],
  nodes: { down: { kind: 'call', handler: 'down', in: { left: { ref: 'in', path: ['left'] } } } },
};

/**
 * `down` runs the spec again one level deeper until nothing is left, then answers its node path. A nested run is
 * handed the caller's place as a link, as the compiler hands it, or as the spelled-out path with `spelled`. It yields
 * before it nests, as a graph that calls itself does when its call reads another node's answer (the shorter list),
 * so the depth is not one synchronous stack; and it breaks where the nested run did not answer, as the compiler's
 * nested runner does.
 */
function descending(spelled = false): Kernel {
  const kernel: Kernel = new Kernel({ down });
  async function down({ in: input, ctx }: Parameters<Handler>[0]): Promise<unknown> {
    const left = input.left as number;
    if (left === 0) return ctx.nodePath;
    const where: RunOptions = spelled ? { nodePath: ctx.nodePath } : { place: ctx.place };
    await Promise.resolve();
    const report = await kernel.run(spec, { initial: { in: { left: left - 1 } }, stubs: ctx.stubs, ...where });
    if (report.status !== 'done') throw new Error(`nested run ${report.status}`);
    return report.output;
  }
  return kernel;
}

describe('a node place', () => {
  it('spells the ids from the outermost run down', () => {
    const top = NodePlace.of(['call']);
    expect(NodePlace.below(NodePlace.below(top, ['op']), ['items', '2']).path()).toEqual(['call', 'op', 'items', '2']);
    expect(NodePlace.of([])).toBeUndefined();
    expect(NodePlace.below(undefined, ['first']).path()).toEqual(['first']);
  });

  it('gives a node nested 2,000 runs deep the path a spelled-out one gives', async () => {
    const linked = await descending().run(spec, { initial: { in: { left: 2000 } } });
    const spelled = await descending(true).run(spec, { initial: { in: { left: 2000 } } });
    expect(linked.output).toEqual(Array(2001).fill('down'));
    expect(linked.output).toEqual(spelled.output);
  });

  it('meets a stub keyed by the path of a node nested below a linked place', async () => {
    const stubs = { 'down.down.down': ['stubbed'] };
    const report = await descending().run(spec, { initial: { in: { left: 5 } }, stubs });
    expect(report.output).toEqual(['stubbed']);
  });
});
