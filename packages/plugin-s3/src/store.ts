/**
 * The tree's blob registry kept in a bucket (RFC 0005). A handle's id is `<run id>/<uuid>` and the object sits
 * at `<prefix>/<id>`, so the key says which run put it and a handle written on one instance opens on another.
 * What a handle names is read off its id alone: this store keeps no map of what it holds, since the instance
 * that opens a handle need not be the one that wrote it, and it refuses an id that is not of its form rather
 * than asking the bucket for a key a caller made up.
 */
import { randomUUID } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { BlobHandle, BlobScope, BlobStore } from '@wilanis/core';
import { type Bucket, keyOf } from './bucket.js';
import { upload } from './upload.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** The one form a handle's id takes here: the run that put it, then the object's own id. */
const ID = new RegExp(`^${UUID}/${UUID}$`);

/** Whether an id is one this store could have issued: `<run id>/<uuid>`, nothing more. */
export const isStoreId = (id: string): boolean => ID.test(id);

/** The source as something to iterate chunk by chunk, whatever form it was handed in. */
const chunksOf = (source: Readable | Buffer | string): AsyncIterable<unknown> | Iterable<unknown> =>
  source instanceof Readable ? source : [typeof source === 'string' ? Buffer.from(source) : source];

/** The blob registry in one bucket: bytes streamed in part by part and streamed out as the body of a get. */
export class S3BlobStore implements BlobStore {
  /**
   * `run` is the run id every key this store puts starts with: fresh for the store itself, and fresh again for
   * each `scope()`, which is one run.
   */
  constructor(
    readonly bucket: Bucket,
    readonly run: string = randomUUID(),
  ) {}

  /** The handle for bytes streamed into the bucket: a fresh id under this run, and the size counted as it passed. */
  async put(source: Readable | Buffer | string, meta: { contentType: string; filename?: string }): Promise<BlobHandle> {
    const id = `${this.run}/${randomUUID()}`;
    const target = { bucket: this.bucket, key: keyOf(this.bucket, id), contentType: meta.contentType };
    const size = await upload(target, chunksOf(source));
    return { id, contentType: meta.contentType, size, ...(meta.filename ? { filename: meta.filename } : {}) };
  }

  /** The bytes behind a handle, streamed from the bucket; an id not of this store's form opens nothing but throws. */
  open(handle: BlobHandle): Readable {
    if (!isStoreId(handle.id))
      throw new Error(`no blob '${handle.id}' in the bucket: an id this store issues is <run id>/<uuid>`);
    const out = new PassThrough();
    this.bucket.wire.stream(keyOf(this.bucket, handle.id)).then(
      // pipeline destroys `out` with the error when the body fails, which is how the reader learns of it
      body => pipeline(body, out).catch(() => undefined),
      (error: unknown) => out.destroy(error as Error),
    );
    return out;
  }

  /** Delete a handle's object; dropping what this store never issued, or what is already gone, is no error. */
  async drop(handle: BlobHandle): Promise<void> {
    if (!isStoreId(handle.id)) return;
    await this.bucket.wire.send({ method: 'DELETE', key: keyOf(this.bucket, handle.id) });
  }

  /** One run of this store: its own run id in every key it puts, and a `release` that deletes only those. */
  scope(): BlobScope {
    const run = new S3BlobStore(this.bucket);
    const mine: BlobHandle[] = [];
    return {
      async put(source, meta) {
        const handle = await run.put(source, meta);
        mine.push(handle);
        return handle;
      },
      open: handle => run.open(handle),
      drop: handle => run.drop(handle),
      scope: () => this.scope(),
      async release() {
        for (const handle of mine.splice(0)) await run.drop(handle);
      },
    };
  }

  /** Whether the bucket takes a write and a delete under the prefix: one empty object put, then dropped. */
  async probe(): Promise<void> {
    await this.drop(await this.put(Buffer.alloc(0), { contentType: 'application/octet-stream' }));
  }
}
