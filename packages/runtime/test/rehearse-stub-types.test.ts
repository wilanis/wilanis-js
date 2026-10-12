/**
 * A solved stub fits the type of the node it stands for (#1026). A keep -- a map with `where` and no operation --
 * answers the list it runs over, so a case that steers a switch on a keep's answer builds a list of that list's
 * elements, never of `null`. And every stub a case would hand a run is checked against its node's type first: one
 * that does not fit, or whose type nothing says, is a value no real run sees, so the case is said and not run.
 */
import { rmSync } from 'node:fs';
import { checkTree } from '@wilanis/compiler';
import { loadTree, type Type } from '@wilanis/core';
import { afterEach, describe, expect, it } from 'vitest';
import { BUILTIN_PLUGINS, rehearse } from '../src/index.js';
import { misfitOf } from '../src/rehearse-reached.js';
import { decide, edge, graph, HERE, ITEM, make, NUMBER, run, shape, treeOf, trigger } from './rehearse-stubs-trees.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * `page` reads a list of items through a port, keeps those with a positive score, and counts them when it kept any.
 * The switch reads the keep's answer, so the case that takes `n` is steered by a stub at the keep.
 */
function keptTree(): string {
  const port = `${HERE}/domain/items.port.json`;
  const items = `${shape('Item')}[]`;
  return treeOf({
    'domain/Item.shape.json': { layer: 'core', fields: ITEM },
    'domain/Ask.shape.json': { layer: 'core', fields: { list: { type: items } } },
    'domain/Count.shape.json': { layer: 'core', fields: { count: NUMBER } },
    'edge/ItemIn.shape.json': { layer: 'edge', fields: ITEM },
    'edge/AskIn.shape.json': { layer: 'edge', fields: { list: { type: `${edge('ItemIn')}[]`, maxItems: 10 } } },
    'edge/Out.shape.json': { layer: 'edge', fields: { count: NUMBER } },
    'domain/items.port.json': {
      operations: {
        page: { description: 'd', accepts: { list: { type: items } }, returns: shape('Count'), refuses: true },
        read: { description: 'd', accepts: { list: { type: items } }, returns: items },
      },
    },
    'data/items.binding.json': {
      port,
      operations: {
        page: { graph: `${HERE}/domain/page.graph.json` },
        read: { graph: `${HERE}/data/read.graph.json` },
      },
    },
    'data/read.graph.json': graph('Read', shape('Ask'), { type: items, from: 'r' }, [make('r', '{{in.list}}', items)]),
    'domain/page.graph.json': graph('Page', shape('Ask'), { type: shape('Count'), from: ['counted', 'none'] }, [
      run('got', `${port}#read`, { list: '{{in.list}}' }),
      { type: '@wilanis/node/map.schema.json', id: 'kept', over: '{{got}}', where: 'item.score > 0' },
      decide('any', { kept: '{{kept}}' }, [{ when: 'len(kept) > 0', to: 'n' }], 'none'),
      run('n', '@std/list.port.json#count', { list: '{{kept}}' }),
      make('counted', { count: '{{n}}' }, shape('Count')),
      run('none', '@std/outcome.port.json#refuse', { reason: 'empty', message: 'empty', type: shape('Count') }),
    ]),
    'edge/page.trigger.json': trigger('page', { in: edge('AskIn'), out: edge('Out') }, `${port}#page`),
  });
}

describe("a keep's answer, as a case steers it", () => {
  it('is a list of the elements it keeps, so the case that needs one runs', { timeout: 30_000 }, async () => {
    const dir = keptTree();
    dirs.push(dir);
    const load = loadTree(dir, BUILTIN_PLUGINS);
    expect(checkTree(load).format()).toBe('');
    const done = await rehearse(load, { seed: 1 });
    const decision = done.decisions.find(one => one.graph.endsWith('domain/page.graph.json') && one.node === 'any');
    const taken = decision?.branches.find(one => one.to === 'n');
    expect(taken?.uncovered, done.lines.join('\n')).toBeUndefined();
    expect(taken?.settled?.status).toBe('done');
  });
});

describe('a stub checked against its type before a run', () => {
  const item: Type = { kind: 'object', fields: { score: { type: { kind: 'number' }, required: true } }, open: false };
  const items: Type = { kind: 'list', of: item };
  const typed = (path: string) => (path === 'op.kept' ? items : undefined);

  it('lets a run have stubs that fit', () => {
    expect(misfitOf({ 'op.kept': [{ score: 3 }] }, typed)).toBeUndefined();
  });
  it('says the stub that does not fit, and where in it', () => {
    expect(misfitOf({ 'op.kept': [null] }, typed)).toBe(
      "the rehearsal's stub does not fit its type: op.kept[0]: expected object",
    );
  });
  it('says the node whose type nothing says', () => {
    expect(misfitOf({ 'op.other': [] }, typed)).toBe(
      "the rehearsal cannot tell the type 'op.other' answers, so it cannot check the stub it would hand it",
    );
  });
});
