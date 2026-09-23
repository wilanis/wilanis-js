/**
 * A cancelled atomic graph leaves the store as it was (RFC 0012, the rollback RFC 0004's `settle` owes it).
 * Nothing new makes that so: the engine answers a run whose signal fired `cancelled`, `inScope` settles the
 * scope with `report.status === 'done'`, and `cancelled` is not `done`. What is proved here is that the
 * consequence holds end to end, against the memory engine's own transaction.
 *
 * The signal is fired from inside the store, the moment the first write has landed: `put` is wrapped so the
 * first call answers and then aborts. The second write is then pending behind the `switch` that routes to
 * it, and never starts. The same cut through a graph that is not atomic leaves the first entry behind, which
 * is what shows the empty store is the rollback's doing and not a write that never happened.
 */
import { rmSync } from 'node:fs';
import { checkTree, runGraph } from '@wilanis/compiler';
import { loadTree, type PluginModule } from '@wilanis/core';
import storage from '@wilanis/plugin-storage';
import { BUILTIN_PLUGINS, embedderFor, FileBlobStore, postLoad } from '@wilanis/runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import memory, { MemoryEngine } from '../src/index.js';
import { PORT, treePairing } from './paired-tree.js';

const PLUGINS: Record<string, PluginModule> = {
  ...BUILTIN_PLUGINS,
  '@storage': storage,
  '@storage-memory': memory,
};

/** The tree served, fresh for each case: the memory engine keeps its records as long as the process. */
async function serving(atomic = true) {
  const dir = treePairing(atomic);
  const tree = loadTree(dir, PLUGINS);
  expect(checkTree(tree).format()).toBe('');
  const emb = embedderFor(tree);
  const down = await postLoad(tree, emb, () => {});
  const blobs = emb.blobs.scope();

  /** Fire one operation of the port, under a signal where one is given. */
  const run = (op: string, input: Record<string, unknown> = {}, signal?: AbortSignal) =>
    runGraph(emb.operation(`${PORT}#${op}`), { initial: { in: input }, env: emb.envFor(blobs), signal });

  const stop = async () => {
    await blobs.release();
    await down();
    if (emb.blobs instanceof FileBlobStore) emb.blobs.destroy();
    rmSync(dir, { recursive: true, force: true });
  };
  return { run, stop };
}

/** Abort `control` once the first `put` has written, whichever engine instance -- the store or its transaction -- takes it. */
function abortAfterFirstWrite(control: AbortController) {
  const put = MemoryEngine.prototype.put;
  return vi.spyOn(MemoryEngine.prototype, 'put').mockImplementation(async function (this: MemoryEngine, ...args) {
    const written = await put.apply(this, args);
    control.abort();
    return written;
  });
}

/** The keys of what the store keeps, read back through the tree's own `all`. */
async function kept(tree: Awaited<ReturnType<typeof serving>>): Promise<string[]> {
  const listed = await tree.run('all');
  expect(listed.status).toBe('done');
  return (listed.output as { id: string }[]).map(entry => entry.id).sort();
}

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await close?.();
  close = undefined;
});

describe('an atomic graph whose run is cancelled', () => {
  it('writes both entries when nothing cancels it', async () => {
    const tree = await serving();
    close = tree.stop;
    const written = await tree.run('pair', { first: 'a', second: 'b' });
    expect(written.status).toBe('done');
    expect(await kept(tree)).toEqual(['a', 'b']);
  });

  it('leaves the store as it was when cancelled after its first write', async () => {
    const tree = await serving();
    close = tree.stop;
    const control = new AbortController();
    const put = abortAfterFirstWrite(control);
    const written = await tree.run('pair', { first: 'a', second: 'b' }, control.signal);
    // the first write ran and answered, the second never started, and the run says it was cancelled
    expect(put).toHaveBeenCalledTimes(1);
    expect(written.status).toBe('cancelled');
    expect(written.output).toBeUndefined();
    expect(await kept(tree)).toEqual([]);
  });

  it('keeps what an earlier run committed, since the rollback undoes the cancelled run alone', async () => {
    const tree = await serving();
    close = tree.stop;
    expect((await tree.run('pair', { first: 'a', second: 'b' })).status).toBe('done');
    const control = new AbortController();
    abortAfterFirstWrite(control);
    const written = await tree.run('pair', { first: 'c', second: 'd' }, control.signal);
    expect(written.status).toBe('cancelled');
    expect(await kept(tree)).toEqual(['a', 'b']);
  });
});

describe('the same graph without atomic', () => {
  it('keeps the first entry when cancelled after it, since nothing opened a transaction to undo it', async () => {
    const tree = await serving(false);
    close = tree.stop;
    const control = new AbortController();
    const put = abortAfterFirstWrite(control);
    const written = await tree.run('pair', { first: 'a', second: 'b' }, control.signal);
    expect(put).toHaveBeenCalledTimes(1);
    expect(written.status).toBe('cancelled');
    expect(await kept(tree)).toEqual(['a']);
  });
});
