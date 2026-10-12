/**
 * The solver on a rule that compares the lengths of two reads (#905): neither side is a literal, so the solver picks
 * both lengths itself, for the rule and for its else, and the rehearsal walks both.
 */
import { rmSync } from 'node:fs';
import { checkTree } from '@wilanis/compiler';
import { loadTree } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { rehearse } from '../src/index.js';
import { decide, edge, graph, HERE, make, run, STRING, shape, treeOf, trigger } from './rehearse-stubs-trees.js';
import { SOURCE, SOURCED } from './source-plugin.js';

/**
 * `compare` reads two answers, a trend and the runs it covers, and asks whether they are as long as each other:
 * `len(trend) == len(runs)` routes to `even`, its else to `uneven`.
 */
function lengthsTree(): string {
  const port = `${HERE}/domain/trend.port.json`;
  const result = shape('Result');
  const ask = { target: STRING };
  return treeOf(
    {
      'domain/Trend.shape.json': { layer: 'core', fields: { points: { type: 'string[]' } } },
      'domain/Runs.shape.json': { layer: 'core', fields: { items: { type: 'string[]' } } },
      'domain/Result.shape.json': { layer: 'core', fields: { label: STRING } },
      'domain/Ask.shape.json': { layer: 'core', fields: ask },
      'edge/AskIn.shape.json': { layer: 'edge', fields: ask },
      'edge/Out.shape.json': { layer: 'edge', fields: { label: STRING } },
      'domain/trend.port.json': {
        operations: {
          compare: { description: 'd', accepts: ask, returns: result },
          trend: { description: 'd', accepts: ask, returns: shape('Trend') },
          runs: { description: 'd', accepts: ask, returns: shape('Runs') },
        },
      },
      'data/trend.binding.json': {
        port,
        operations: {
          compare: { graph: `${HERE}/domain/compare.graph.json` },
          trend: { run: SOURCE, in: { type: shape('Trend') } },
          runs: { run: SOURCE, in: { type: shape('Runs') } },
        },
      },
      'domain/compare.graph.json': graph('Compare', shape('Ask'), { type: result, from: ['even', 'uneven'] }, [
        run('trend', `${port}#trend`, { target: '{{in.target}}' }),
        run('runs', `${port}#runs`, { target: '{{in.target}}' }),
        decide(
          'same',
          { trend: '{{trend.points}}', runs: '{{runs.items}}' },
          [{ when: 'len(trend) == len(runs)', to: 'even' }],
          'uneven',
        ),
        make('even', { label: 'even' }, result),
        make('uneven', { label: 'uneven' }, result),
      ]),
      'edge/compare.trigger.json': trigger('compare', { in: edge('AskIn'), out: edge('Out') }, `${port}#compare`),
    },
    { source: true },
  );
}

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

describe('rehearsing a switch that compares the lengths of two reads (#905)', () => {
  it('walks the rule and its else under every seed', { timeout: 60_000 }, async () => {
    const dir = lengthsTree();
    const load = loadTree(dir, SOURCED);
    expect(checkTree(load).format()).toBe('');
    const runs = [];
    for (const seed of SEEDS) runs.push({ seed, run: await rehearse(load, { seed }) });
    rmSync(dir, { recursive: true, force: true });
    for (const { seed, run: one } of runs) {
      const said = `seed ${seed}\n${one.lines.join('\n')}`;
      expect(said).toMatch(/ok {2}when len\(trend\) == len\(runs\) +answered from 'even'/);
      expect(said).toMatch(/ok {2}anything else +answered from 'uneven'/);
      expect(said).not.toMatch(/cannot compare|no inputs|BROKE|NEVER RUN/);
      expect(one.ok, said).toBe(true);
    }
  });
});
