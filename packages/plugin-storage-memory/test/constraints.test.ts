/**
 * A constraint is answered, not thrown. The store of `constrained-tree.ts` declares a `unique` and a `refs`;
 * the graphs that write it route on the flag with a `switch`, exactly as RFC 0002's graphs route on
 * `conflict`. What is proved here is that the whole path holds it: the declaration reaches the engine off the
 * store document, the engine answers `violated` and `referencedBy` rather than failing, the node stays `done`,
 * and the branch the author wrote for the violation is the branch that runs.
 *
 * The tree is driven through the embedder, the way `wilanis run` and the http listener drive one, so the
 * answer a graph sees is the answer a served tree would see.
 */
import { rmSync } from 'node:fs';
import { checkTree } from '@wilanis/compiler';
import { loadTree, type PluginModule } from '@wilanis/core';
import storage from '@wilanis/plugin-storage';
import { BUILTIN_PLUGINS, embedderFor, FileBlobStore, postLoad } from '@wilanis/runtime';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import memory from '../src/index.js';
import { treeServing } from './constrained-tree.js';

const PLUGINS: Record<string, PluginModule> = {
  ...BUILTIN_PLUGINS,
  '@storage': storage,
  '@storage-memory': memory,
};

const dir = treeServing();
let tree: ReturnType<typeof loadTree>;
let emb: ReturnType<typeof embedderFor>;
let down: () => Promise<void>;

beforeAll(async () => {
  tree = loadTree(dir, PLUGINS);
  expect(checkTree(tree).format()).toBe('');
  emb = embedderFor(tree);
  down = await postLoad(tree, emb, () => {});
});

afterAll(async () => {
  await down();
  if (emb.blobs instanceof FileBlobStore) emb.blobs.destroy();
  rmSync(dir, { recursive: true, force: true });
});

/** Fire one trigger the way `wilanis run` does, with a blob scope of this run's own. */
const fire = async (name: string, input: Record<string, unknown>) => {
  const path = `@features/customers/edge/${name}.trigger.json`;
  const found = tree.registry.get('trigger', tree.resolve(path));
  if (!found) throw new Error(`no trigger at '${path}'`);
  const blobs = emb.blobs.scope();
  try {
    return await emb.fire(found.doc, input, { flags: {}, args: [], cwd: dir }, { blobs });
  } finally {
    await blobs.release();
  }
};

describe('a unique the store declares', () => {
  it('a record repeating one is answered, not thrown, and the branch the author wrote runs', async () => {
    const first = await fire('record', { id: '1', url: 'https://x', method: 'GET' });
    expect(first.status).toBe('done');
    expect(first.output).toEqual({ record: { id: '1', url: 'https://x', method: 'GET' } });

    const repeat = await fire('record', { id: '2', url: 'https://x', method: 'GET' });
    expect(repeat.status).toBe('done');
    expect(repeat.output).toEqual({ violated: 'unique [url, method]' });
  });

  it('nothing is written where a unique stopped the write', async () => {
    await fire('record', { id: '3', url: 'https://y', method: 'GET' });
    const repeat = await fire('record', { id: '4', url: 'https://y', method: 'GET' });
    expect(repeat.output).toEqual({ violated: 'unique [url, method]' });
    const gone = await fire('forget', { id: '4' });
    expect(gone.output).toEqual({ removed: false });
  });

  it('a record differing in one field of the pair repeats nothing', async () => {
    const other = await fire('record', { id: '5', url: 'https://x', method: 'POST' });
    expect(other.output).toEqual({ record: { id: '5', url: 'https://x', method: 'POST' } });
  });
});

describe('a refs the store declares', () => {
  it('a note pointing at no entry is answered, not thrown', async () => {
    const dangling = await fire('note', { id: 'n1', entryId: 'nobody', text: 'about nothing' });
    expect(dangling.status).toBe('done');
    expect(dangling.output).toEqual({ violated: 'refs notes.entryId -> entries' });
  });

  it('a note pointing at an entry that is there is kept', async () => {
    const held = await fire('note', { id: 'n2', entryId: '1', text: 'about the first' });
    expect(held.status).toBe('done');
    expect(held.output).toEqual({ record: { id: 'n2', entryId: '1', text: 'about the first' } });
  });

  it('an entry a note still references is kept, and the reference is answered', async () => {
    const refused = await fire('forget', { id: '1' });
    expect(refused.status).toBe('done');
    expect(refused.output).toEqual({ removed: false, referencedBy: 'refs notes.entryId -> entries' });
  });

  it('an entry nothing references any more goes', async () => {
    const gone = await fire('forget', { id: '5' });
    expect(gone.status).toBe('done');
    expect(gone.output).toEqual({ removed: true });
  });
});
