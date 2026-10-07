/**
 * What `wilanis start` leaves in a folder the tree names as `blobs.dir` (#870): a reload builds a new embedder
 * and with it a new store, and stopping destroys every store the server served from -- the one a reload
 * replaced and the one serving now -- so the folder holds only what was there before the start.
 */
import { readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { type BlobStore, loadTree, schemaUrl } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { start } from '../src/index.js';
import { bootTree } from './startup-harness.js';

/** The boot tree with a listener, its blob registry under `blobs/`, and a file there no store of it wrote. */
function namedBlobsTree() {
  const tree = bootTree([{ run: '@fake/server.port.json#listen' }], () => 'ok');
  tree.put('project.json', {
    $schema: schemaUrl('project'),
    name: 'boot',
    description: 'a tree whose blobs live in a folder it names',
    plugins: [{ use: '@std' }, { use: '@fake' }],
    startup: [{ run: '@fake/server.port.json#listen' }],
    blobs: { dir: 'blobs' },
  });
  const blobs = join(tree.dir, 'blobs');
  return { ...tree, blobs };
}

/** The store the tree being served reads now, as a `holds` operation reaches it through `env.serving`. */
const storeOf = (serving: unknown) => (serving as { blobs: BlobStore }).blobs;

/** The bytes a stream yields, read whole as text. */
async function text(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

describe('the blob stores a start served from', () => {
  it('are every one destroyed on stop, the one a reload replaced and the one serving now', async () => {
    const { dir, plugins, serving, blobs } = namedBlobsTree();
    try {
      const { stop } = await start(loadTree(dir, plugins), { log: () => {} });
      writeFileSync(join(blobs, 'foreign'), 'written before the start, by nothing of this tree');
      const first = storeOf(serving());
      const old = await first.put('held by the first tree', { contentType: 'text/plain' });

      const again = await serving()?.reload();
      expect(again?.ok).toBe(true);
      const second = storeOf(serving());
      expect(second).not.toBe(first);
      await second.put('held by the tree a reload swapped in', { contentType: 'text/plain' });
      // a held thing may still read what the replaced store holds, so a reload deletes none of it
      expect(await text(first.open(old))).toBe('held by the first tree');
      expect(readdirSync(blobs)).toHaveLength(3);

      await stop();
      expect(readdirSync(blobs)).toEqual(['foreign']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
