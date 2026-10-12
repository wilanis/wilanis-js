/**
 * What a demand is carried through on its way to an effect (#1027), on the shape a history read takes: an effect
 * answers a list of runs, and a graph answers `{ run: first(runs) }` where the list holds one and `{}` where it holds
 * none. A switch on `has(latest.run)` is steered through `first` to the list's first element for its rule, and, for
 * its else, to the answer that writes no run -- a field an object written out does not write is not there -- since a
 * run's id is required and no element can leave it out. And a list made to lack an element is cut short: it holds no
 * gaps.
 */
import { rmSync } from 'node:fs';
import { checkTree } from '@wilanis/compiler';
import { loadTree } from '@wilanis/core';
import { afterEach, describe, expect, it } from 'vitest';
import { Embedder, rehearse } from '../src/index.js';
import { setPath } from '../src/stubs.js';
import { decide, edge, graph, HERE, make, run, STRING, shape, treeOf, trigger } from './rehearse-stubs-trees.js';
import { SOURCE, SOURCED } from './source-plugin.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** `page` reads the latest run through `newest`, and says whether there was one. */
function latestTree(): string {
  const port = `${HERE}/domain/runs.port.json`;
  const runShape = shape('Run');
  const latest = shape('Latest');
  const out = shape('Out');
  return treeOf(
    {
      'domain/Run.shape.json': { layer: 'core', fields: { id: STRING } },
      'domain/Latest.shape.json': { layer: 'core', fields: { run: { type: runShape, required: false } } },
      'domain/Out.shape.json': { layer: 'core', fields: { label: STRING } },
      'edge/OutView.shape.json': { layer: 'edge', fields: { label: STRING } },
      'domain/runs.port.json': {
        operations: {
          page: { description: 'd', returns: out },
          newest: { description: 'd', returns: latest },
        },
      },
      'data/runs.binding.json': {
        port,
        operations: {
          page: { graph: `${HERE}/domain/page.graph.json` },
          newest: { graph: `${HERE}/data/newest.graph.json` },
        },
      },
      'data/newest.graph.json': graph('Newest', undefined, { type: latest, from: ['latest', 'none'] }, [
        run('runs', SOURCE, { type: `${runShape}[]` }),
        decide('isThereOne', { runs: '{{runs}}' }, [{ when: 'len(runs) > 0', to: 'first' }], 'none'),
        run('first', '@std/list.port.json#first', { list: '{{runs}}', type: runShape }),
        make('latest', { run: '{{first}}' }, latest),
        make('none', {}, latest),
      ]),
      'domain/page.graph.json': graph('Page', undefined, { type: out, from: ['some', 'nothing'] }, [
        run('got', `${port}#newest`, {}),
        decide('hadOne', { id: '{{got.run.id}}' }, [{ when: 'has(id)', to: 'some' }], 'nothing'),
        make('some', { label: '{{got.run.id}}' }, out),
        make('nothing', { label: 'none' }, out),
      ]),
      'edge/page.trigger.json': trigger('page', { out: edge('OutView') }, `${port}#page`),
    },
    { source: true },
  );
}

describe('a switch on a field of what a graph answers through first', () => {
  it('takes both branches from the effect, the else from the answer that writes no run', {
    timeout: 30_000,
  }, async () => {
    const dir = latestTree();
    dirs.push(dir);
    const load = loadTree(dir, SOURCED);
    expect(checkTree(load).format()).toBe('');
    const stubbed = new Set<string>();
    const fire = Embedder.prototype.fire;
    Embedder.prototype.fire = function (trigger, input, context, opts) {
      for (const path of Object.keys(opts?.stubs ?? {})) stubbed.add(path);
      return fire.call(this, trigger, input, context, opts);
    };
    try {
      const done = await rehearse(load, { seed: 1 });
      const decision = done.decisions.find(one => one.node === 'hadOne');
      expect(
        decision?.branches.map(one => [one.to, one.uncovered ?? one.settled?.misrouted ?? one.settled?.status]),
        done.lines.join('\n'),
      ).toEqual([
        ['some', 'done'],
        ['nothing', 'done'],
      ]);
      expect(done.ok, done.lines.join('\n')).toBe(true);
    } finally {
      Embedder.prototype.fire = fire;
    }
    expect([...stubbed]).toEqual(['op.got.op.runs']);
  });
});

describe('a list made to lack an element', () => {
  it('is cut short before it, so it holds no gaps', () => {
    expect(setPath({ runs: [{ id: 'a' }, { id: 'b' }] }, ['runs', '1'], undefined)).toEqual({ runs: [{ id: 'a' }] });
    expect(setPath({ runs: [{ id: 'a' }] }, ['runs', '0'], undefined)).toEqual({ runs: [] });
  });
});
