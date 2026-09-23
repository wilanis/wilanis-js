/**
 * A blob write cut short leaves no file behind (RFC 0012): a source that errors partway never becomes a handle,
 * so no scope's `release` would ever see it, and the store unlinks what it had written before rethrowing.
 */
import { readdirSync } from 'node:fs';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { FileBlobStore } from '../src/blobs.js';

/** A stream that yields a few chunks and then fails, as an upload cut by `maxBodyBytes` or a hang-up does. */
function cutShort(error: Error): Readable {
  return Readable.from(
    (async function* () {
      yield Buffer.alloc(64 * 1024, 1);
      yield Buffer.alloc(64 * 1024, 2);
      throw error;
    })(),
  );
}

describe('a blob write cut short', () => {
  let store: FileBlobStore | undefined;
  afterEach(() => store?.destroy());

  it('rejects with the source error and leaves the directory empty', async () => {
    store = new FileBlobStore(process.cwd());
    const cut = new Error('body exceeds 100 bytes');
    await expect(store.put(cutShort(cut), { contentType: 'text/csv' })).rejects.toBe(cut);
    expect(readdirSync(store.dir)).toEqual([]);
  });

  it('leaves nothing through a scope either, and the scope releases cleanly', async () => {
    store = new FileBlobStore(process.cwd());
    const scope = store.scope();
    await expect(scope.put(cutShort(new Error('hung up')), { contentType: 'text/csv' })).rejects.toThrow('hung up');
    await scope.release();
    expect(readdirSync(store.dir)).toEqual([]);
  });
});
