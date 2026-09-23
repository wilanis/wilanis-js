/**
 * @wilanis/plugin-s3, the @s3 plugin: the tree's blob registry kept in one bucket of an object store speaking
 * the S3 API (RFC 0005). It grants one connection kind and no port, because no graph touches bytes: the runtime
 * opens the store when `project.json → blobs.connection` names a connection of that kind, through `blobStores`.
 * It speaks the API itself -- six signed requests over `fetch` -- rather than through an SDK, and is a package
 * of its own, so a tree that keeps its files on disk never installs it.
 *
 * `postLoad` probes the bucket when the tree's blobs are kept here, and fails the start when it cannot write
 * there; a tree that only ships a connection of this kind, with its blobs in files, is never probed.
 */
import { fileURLToPath } from 'node:url';
import type { PluginModule } from '@wilanis/core';
import { bucketOf } from './bucket.js';
import { S3BlobStore } from './store.js';

export { type Bucket, bucketOf, keyOf, PART_SIZE } from './bucket.js';
export { type Call, type Endpoint, element, S3Error, S3Wire } from './client.js';
export { isStoreId, S3BlobStore } from './store.js';

const ROOT = '@s3';
const KIND = `${ROOT}/bucket.connection-kind.json`;

/** Where a store's bucket is, for the line that says where blobs are kept or why they cannot be. */
const whereOf = (store: S3BlobStore) =>
  `bucket '${store.bucket.name}'${store.bucket.prefix ? ` under '${store.bucket.prefix}'` : ''}`;

const plugin: PluginModule = {
  root: ROOT,
  docs: fileURLToPath(new URL('../docs', import.meta.url)),
  handlers: {},
  blobStores: { [KIND]: settings => new S3BlobStore(bucketOf(settings)) },
  async postLoad(ctx) {
    const store = ctx.env.blobs;
    if (!(store instanceof S3BlobStore)) return;
    try {
      await store.probe();
    } catch (error) {
      throw new Error(`the blob registry's ${whereOf(store)} cannot be written: ${(error as Error).message}`);
    }
    ctx.log(`@s3: blobs are kept in ${whereOf(store)}`);
  },
};
export default plugin;
