/**
 * The bucket store against a real object store speaking the S3 API: put as a multipart upload, get, delete,
 * a scope's release, the probe, and the signature every request carries. It needs one, so it is skipped
 * without `WILANIS_TEST_S3_ENDPOINT` -- a suite that silently passed against nothing would be worse than none.
 * CI starts no object store, so it runs by hand, against any server speaking the API; versitygw is one that
 * passes it unchanged:
 *
 *   docker run -d --rm --name wilanis-s3 -p 59000:7070 \
 *     -e ROOT_ACCESS_KEY=wilanis -e ROOT_SECRET_KEY=wilanis-secret \
 *     versity/versitygw:v1.8.0 posix /tmp
 *   WILANIS_TEST_S3_ENDPOINT=http://127.0.0.1:59000 npx vitest run packages/plugin-s3
 *
 * The bucket is made here if it is missing, since the plugin itself never makes one.
 */
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { beforeAll, describe, expect, it } from 'vitest';
import { bucketOf, PART_SIZE, S3BlobStore, type S3Error } from '../src/index.js';

const endpoint = process.env.WILANIS_TEST_S3_ENDPOINT;
const CHUNK = 64 * 1024;
const SIZE = 2 * PART_SIZE + 123_457;

/** The settings of a connection to the store under test. */
const settings = (extra: Record<string, unknown> = {}) => ({
  endpoint,
  region: 'us-east-1',
  bucket: process.env.WILANIS_TEST_S3_BUCKET ?? 'wilanis-test',
  accessKeyId: process.env.WILANIS_TEST_S3_KEY ?? 'wilanis',
  secretAccessKey: process.env.WILANIS_TEST_S3_SECRET ?? 'wilanis-secret',
  ...extra,
});

/** `size` bytes a chunk at a time, the same bytes every time it is asked for. */
function bytes(size: number): Readable {
  async function* chunks() {
    for (let at = 0; at < size; at += CHUNK) yield Buffer.alloc(Math.min(CHUNK, size - at), at % 251);
  }
  return Readable.from(chunks());
}

/** The sha-256 of what a stream yields, read as it streams. */
async function digestOf(stream: Readable): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

describe.skipIf(!endpoint)('the blob registry in a real bucket', () => {
  // a prefix of this run's own, so a store shared by other runs is never read across
  const prefix = `test/${randomUUID()}`;
  // made once the suite runs, not when it is collected: without a store the settings name no endpoint
  let store: S3BlobStore;
  let wire: S3BlobStore['bucket']['wire'];
  beforeAll(async () => {
    store = new S3BlobStore(bucketOf(settings({ prefix })));
    wire = store.bucket.wire;
    await wire.send({ method: 'PUT', key: '' }).catch((error: S3Error) => {
      if (!/BucketAlreadyOwnedByYou|BucketAlreadyExists/.test(error.code)) throw error;
    });
  });

  /** Every key under this run's prefix, as the store lists it. */
  const keys = async () => {
    const listed = await wire.xml({ method: 'GET', key: '', query: { 'list-type': '2', prefix } });
    return [...listed.matchAll(/<Key>([^<]*)<\/Key>/g)].map(([, key]) => key);
  };

  it('puts a body of three parts, opens it back whole, and a release deletes it', async () => {
    const run = store.scope();
    const handle = await run.put(bytes(SIZE), { contentType: 'text/csv' });
    expect(handle.size).toBe(SIZE);
    expect(await keys()).toEqual([`${prefix}/${handle.id}`]);
    expect(await digestOf(run.open(handle))).toBe(await digestOf(bytes(SIZE)));
    await run.release();
    expect(await keys()).toEqual([]);
    await expect(digestOf(store.open(handle))).rejects.toThrow(/NoSuchKey/);
  });

  it('leaves no upload open when the source fails partway', async () => {
    async function* broken() {
      yield Buffer.alloc(PART_SIZE + 1);
      throw new Error('the caller hung up');
    }
    await expect(store.put(Readable.from(broken()), { contentType: 'text/csv' })).rejects.toThrow('the caller hung up');
    const open = await wire.xml({ method: 'GET', key: '', query: { uploads: '', prefix } });
    expect(open).not.toMatch(/<Upload>/);
  });

  it('probes the bucket, and fails the probe of one that does not exist or of a wrong secret', async () => {
    await store.probe();
    expect(await keys()).toEqual([]);
    const missing = new S3BlobStore(bucketOf(settings({ bucket: `missing-${randomUUID()}` })));
    await expect(missing.probe()).rejects.toThrow(/NoSuchBucket/);
    const forged = new S3BlobStore(bucketOf(settings({ secretAccessKey: 'not-the-secret' })));
    await expect(forged.probe()).rejects.toThrow(/SignatureDoesNotMatch/);
  });
});
