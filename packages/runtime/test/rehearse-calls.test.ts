/**
 * A call into one of the tree's graphs is run, never stubbed (#1027). A demand on what it answers is met inside it, at
 * the first of its output candidates that can meet it, with the switch that routes there steered to it: a graph that
 * answers `found` on a 200 and `missing` otherwise is made to answer `missing` by the effect it reads, not by a stub of
 * the call. Where no candidate can meet the demand -- every answer holds a commit -- the branch is closed on that path.
 */
import { rmSync } from 'node:fs';
import { checkTree } from '@wilanis/compiler';
import { type LoadResult, loadTree } from '@wilanis/core';
import { afterEach, describe, expect, it } from 'vitest';
import { Embedder, type Rehearsal, rehearse } from '../src/index.js';
import {
  decide,
  edge,
  graph,
  HERE,
  make,
  NUMBER,
  refuse,
  run,
  STRING,
  shape,
  treeOf,
  trigger,
} from './rehearse-stubs-trees.js';
import { SOURCE, SOURCED } from './source-plugin.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * `page` reads `got` through a port bound to `read`, which asks `@source` and answers `found` on a 200, carrying the
 * commit it read, and `missing` otherwise. `page` refuses `missing` and decides on whether the answer holds a commit.
 * With `always`, `read` answers `found` only where the source read a commit, and refuses otherwise: every answer holds
 * one, though the source may read none.
 */
function calledTree(always = false): string {
  const port = `${HERE}/domain/items.port.json`;
  const got = shape('Got');
  const out = shape('Out');
  return treeOf(
    {
      'domain/Raw.shape.json': {
        layer: 'core',
        fields: { status: NUMBER, commit: { ...STRING, required: false } },
      },
      'domain/Got.shape.json': { layer: 'core', fields: { status: STRING, commit: { ...STRING, required: false } } },
      'domain/Out.shape.json': { layer: 'core', fields: { label: STRING } },
      'edge/OutView.shape.json': { layer: 'edge', fields: { label: STRING } },
      'domain/items.port.json': {
        operations: {
          page: { description: 'd', returns: out, refuses: true },
          read: { description: 'd', returns: got, refuses: true },
        },
      },
      'data/items.binding.json': {
        port,
        operations: {
          page: { graph: `${HERE}/domain/page.graph.json` },
          read: { graph: `${HERE}/data/read.graph.json` },
        },
      },
      'data/read.graph.json': graph(
        'Read',
        undefined,
        { type: got, from: always ? ['found', 'upstream'] : ['found', 'missing'] },
        [
          run('fetched', SOURCE, { type: shape('Raw') }),
          decide(
            'outcome',
            { status: '{{fetched.status}}', commit: '{{fetched.commit}}' },
            [{ when: always ? 'status == 200 && has(commit)' : 'status == 200', to: 'found' }],
            always ? 'upstream' : 'missing',
          ),
          make('found', { status: 'found', commit: '{{fetched.commit}}' }, got),
          always ? refuse('upstream', 'upstream', got) : make('missing', { status: 'missing' }, got),
        ],
      ),
      'domain/page.graph.json': graph('Page', undefined, { type: out, from: ['withCommit', 'noCommit', 'none'] }, [
        run('got', `${port}#read`, {}),
        decide('isMissing', { status: '{{got.status}}' }, [{ when: "status == 'missing'", to: 'none' }], 'anyCommit'),
        refuse('none', 'missing', out),
        decide('anyCommit', { commit: '{{got.commit}}' }, [{ when: 'has(commit)', to: 'withCommit' }], 'noCommit'),
        make('withCommit', { label: '{{got.commit}}' }, out),
        make('noCommit', { label: 'none' }, out),
      ]),
      'edge/page.trigger.json': trigger('page', { out: edge('OutView') }, `${port}#page`),
    },
    { source: true },
  );
}

/** The tree loaded, once the checker has let it through, and removed when the case is done. */
function loaded(dir: string): LoadResult {
  dirs.push(dir);
  const load = loadTree(dir, SOURCED);
  expect(checkTree(load).format()).toBe('');
  return load;
}

/** A rehearsal of the tree, with every stub any of its runs was handed. */
async function rehearsedWithStubs(load: LoadResult): Promise<{ done: Rehearsal; stubbed: Set<string> }> {
  const stubbed = new Set<string>();
  const fire = Embedder.prototype.fire;
  Embedder.prototype.fire = function (trigger, input, context, opts) {
    for (const path of Object.keys(opts?.stubs ?? {})) stubbed.add(path);
    return fire.call(this, trigger, input, context, opts);
  };
  try {
    return { done: await rehearse(load, { seed: 1 }), stubbed };
  } finally {
    Embedder.prototype.fire = fire;
  }
}

/** Each branch of one decision as where it went and how it settled, or why no run took it. */
function branchesOf(run: Rehearsal, node: string) {
  const decision = run.decisions.find(one => one.node === node);
  return decision?.branches.map(one => [
    one.to,
    one.closed ?? one.uncovered ?? one.settled?.misrouted ?? one.settled?.declared?.reason ?? one.settled?.status,
  ]);
}

describe('a switch on what a call into a graph answers', () => {
  it('is steered by the effect inside, to the answer each branch needs', { timeout: 30_000 }, async () => {
    const { done, stubbed } = await rehearsedWithStubs(loaded(calledTree()));
    expect(done.ok, done.lines.join('\n')).toBe(true);
    // `missing` is the second answer `read` names: the solver picks it, and steers `outcome` to it
    expect(branchesOf(done, 'isMissing')).toEqual([
      ['none', 'missing'],
      ['anyCommit', 'done'],
    ]);
    expect(branchesOf(done, 'anyCommit')).toEqual([
      ['withCommit', 'done'],
      ['noCommit', 'done'],
    ]);
    expect([...stubbed]).toEqual(['op.got.op.fetched']);
  });

  it('is closed on a path where no answer of the call holds what the branch asks', { timeout: 30_000 }, async () => {
    const { done } = await rehearsedWithStubs(loaded(calledTree(true)));
    const [withCommit, noCommit] = branchesOf(done, 'anyCommit') ?? [];
    expect(withCommit).toEqual(['withCommit', 'done']);
    expect(noCommit?.[0]).toBe('noCommit');
    expect(String(noCommit?.[1])).toContain("no answer of the call at 'op.got' holds what the branch asks of it");
  });
});
