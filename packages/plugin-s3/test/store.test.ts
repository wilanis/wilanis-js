/**
 * The bucket store against the in-process fake: bytes streamed in part by part and out as the body of a get,
 * never held whole; keys of the form `<prefix>/<run id>/<uuid>`; a run's blobs deleted when it releases; a
 * handle opened on an instance that did not write it; and an upload cut short leaving nothing behind.
 */
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bucketOf, isStoreId, PART_SIZE, S3BlobStore } from '../src/index.js';
import { type FakeS3, settingsOf, startFakeS3 } from './fake-s3.js';

const CHUNK = 64 * 1024;
const TEN_MB = 10_000_000;

/** A body of `size` bytes yielded a chunk at a time, noting after each how far it ran ahead of what the fake received. */
function body(size: number, fake: FakeS3) {
  const seen = { pulled: 0, ahead: 0 };
  async function* chunks() {
    for (let at = 0; at < size; at += CHUNK) {
      const length = Math.min(CHUNK, size - at);
      seen.pulled += length;
      seen.ahead = Math.max(seen.ahead, seen.pulled - fake.received());
      yield Buffer.alloc(length, at % 251);
    }
  }
  // one chunk of read-ahead in the stream itself, so what is measured is what the store holds and not the stream
  return { stream: Readable.from(chunks(), { highWaterMark: 1 }), seen };
}

/** The sha-256 of what a stream yields, read as it streams. */
async function digestOf(stream: Readable): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** The sha-256 of the body `body(size)` yields, computed the same way without a store. */
async function expected(size: number): Promise<string> {
  const hash = createHash('sha256');
  for (let at = 0; at < size; at += CHUNK) hash.update(Buffer.alloc(Math.min(CHUNK, size - at), at % 251));
  return hash.digest('hex');
}

describe('the blob registry in a bucket', () => {
  let fake: FakeS3;
  let store: S3BlobStore;
  beforeEach(async () => {
    fake = await startFakeS3();
    store = new S3BlobStore(bucketOf(settingsOf(fake, { prefix: '/customers/uploads/' })));
  });
  afterEach(async () => fake.close());

  it('streams 10 MB in as a multipart upload and out as a get, holding no buffer the size of the body', async () => {
    const { stream, seen } = body(TEN_MB, fake);
    const handle = await store.put(stream, { contentType: 'text/csv', filename: 'customers.csv' });
    expect(handle).toMatchObject({ contentType: 'text/csv', size: TEN_MB, filename: 'customers.csv' });
    expect(isStoreId(handle.id)).toBe(true);
    expect(handle.id.split('/')[0]).toBe(store.run);
    expect([...fake.objects.keys()]).toEqual([`customers/uploads/${handle.id}`]);
    const ops = fake.seen.map(one => one.op);
    expect(ops).toEqual(['createMultipartUpload', 'uploadPart', 'uploadPart', 'completeMultipartUpload']);
    // no request carried more than one part, and the source never ran further ahead of what the bucket had
    // received than the part being cut, the chunk that overflowed it, and the one chunk the stream reads ahead
    expect(Math.max(...fake.seen.map(one => one.bytes))).toBe(PART_SIZE);
    expect(seen.ahead).toBeLessThanOrEqual(PART_SIZE + 2 * CHUNK);
    expect(seen.ahead).toBeLessThan(TEN_MB);
    expect(await digestOf(store.open(handle))).toBe(await expected(TEN_MB));
  });

  it('sends a body shorter than one part as a single put, an empty one too', async () => {
    const small = await store.put('id,name\n1,Ada\n', { contentType: 'text/csv' });
    const empty = await store.put(Buffer.alloc(0), { contentType: 'application/octet-stream' });
    expect([small.size, empty.size]).toEqual([14, 0]);
    expect(fake.seen.map(one => one.op)).toEqual(['putObject', 'putObject']);
    expect(fake.objects.get(`customers/uploads/${small.id}`)?.contentType).toBe('text/csv');
    expect(await digestOf(store.open(empty))).toBe(createHash('sha256').digest('hex'));
  });

  it('keys a scope under a run of its own, and its release deletes what that run put and nothing else', async () => {
    const kept = await store.put('kept', { contentType: 'text/plain' });
    const run = store.scope();
    const first = await run.put('one', { contentType: 'text/plain' });
    const second = await run.put('two', { contentType: 'text/plain' });
    const [runId] = first.id.split('/');
    expect(second.id.startsWith(`${runId}/`)).toBe(true);
    expect(runId).not.toBe(store.run);
    expect(fake.objects.size).toBe(3);
    await run.release();
    expect([...fake.objects.keys()]).toEqual([`customers/uploads/${kept.id}`]);
  });

  it('opens a handle on an instance that did not write it', async () => {
    const other = new S3BlobStore(bucketOf(settingsOf(fake, { prefix: 'customers/uploads' })));
    const handle = await store.put('written on A', { contentType: 'text/plain' });
    const read = await Readable.from(other.open(handle)).toArray();
    expect(Buffer.concat(read).toString()).toBe('written on A');
  });

  it('refuses a handle whose id is not <run id>/<uuid>, asking the bucket for nothing', async () => {
    const made = await store.put('x', { contentType: 'text/plain' });
    const [runId, uuid] = made.id.split('/');
    fake.seen.length = 0;
    for (const id of [
      uuid,
      `${runId}/../${uuid}`,
      `${runId}/${uuid}/more`,
      'customers.csv',
      `${runId}/${uuid}`.toUpperCase(),
    ]) {
      expect(() => store.open({ ...made, id })).toThrow(/an id this store issues is <run id>\/<uuid>/);
      await store.drop({ ...made, id });
    }
    expect(fake.seen).toEqual([]);
  });

  it('fails the stream of a well-formed handle the bucket holds nothing under', async () => {
    const made = await store.put('x', { contentType: 'text/plain' });
    await store.drop(made);
    await expect(digestOf(store.open(made))).rejects.toThrow(/NoSuchKey|does not exist/);
  });

  it('aborts the upload when a part is refused, leaving no parts and no object', async () => {
    fake.refusePart = 2;
    await expect(store.put(body(TEN_MB, fake).stream, { contentType: 'text/csv' })).rejects.toThrow(/AccessDenied/);
    expect(fake.seen.at(-1)?.op).toBe('abortMultipartUpload');
    expect(fake.uploads.size).toBe(0);
    expect(fake.objects.size).toBe(0);
  });

  it('aborts the upload when the source fails partway', async () => {
    async function* broken() {
      yield Buffer.alloc(PART_SIZE + 1);
      throw new Error('the caller hung up');
    }
    await expect(store.put(Readable.from(broken()), { contentType: 'text/csv' })).rejects.toThrow('the caller hung up');
    expect(fake.seen.map(one => one.op)).toEqual(['createMultipartUpload', 'uploadPart', 'abortMultipartUpload']);
    expect(fake.uploads.size).toBe(0);
    expect(fake.objects.size).toBe(0);
  });

  it('probes the bucket with one empty object put and deleted, and fails where the bucket is not', async () => {
    await store.probe();
    expect(fake.seen.map(one => one.op)).toEqual(['putObject', 'deleteObject']);
    expect(fake.objects.size).toBe(0);
    const missing = new S3BlobStore(bucketOf(settingsOf(fake, { bucket: 'nope' })));
    await expect(missing.probe()).rejects.toThrow(/NoSuchBucket/);
  });
});
