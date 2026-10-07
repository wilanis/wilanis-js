/**
 * The blob registry behind a connection (RFC 0005): `project.json → blobs.connection` names a connection whose
 * kind a plugin offers a blob store for, and the embedder opens that store with the connection's settings. A
 * connection that is none, or of a kind nothing offers a store for, is C014; a stubbed run keeps files whatever
 * the project names. A registry on disk with no `blobs.dir` is one folder per process, gone when the process
 * exits, and destroying a store removes only the files it holds (#843).
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkTree } from '@wilanis/compiler';
import { type BlobStore, type LoadResult, loadTree, type PluginModule, Scope, schemaRef } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { FileBlobStore } from '../src/blobs.js';
import { Embedder, embedderFor } from '../src/index.js';
import { docsDir, EXAMPLE, INCLUDES, PLUGINS } from './example-harness.js';

const KIND = '@bucket/bucket.connection-kind.json';

/** A plugin granting the bucket kind; with `opens`, it offers a blob store for it, recording what it was given. */
function bucket(opens?: (settings: Record<string, unknown>) => BlobStore): PluginModule {
  return {
    root: '@bucket',
    docs: docsDir({
      'plugin.json': {
        $schema: schemaRef('plugin'),
        description: 'keeps bytes in a bucket',
        grants: { connectionKinds: [KIND] },
      },
      'bucket.connection-kind.json': {
        $schema: schemaRef('connection-kind'),
        description: 'one bucket of an object store',
        settings: { fields: { bucket: { type: 'string' } } },
      },
    }),
    handlers: {},
    ...(opens ? { blobStores: { [KIND]: opens } } : {}),
  };
}

/** A copy of the example whose blob registry is the bucket, loaded with `plugin`, read however the case needs. */
function reading<T>(
  plugin: PluginModule,
  read: (load: LoadResult) => T,
  connection = '@connections/uploads.connection.json',
) {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-blobs-'));
  cpSync(EXAMPLE, dir, { recursive: true, filter: path => !path.includes('node_modules') });
  writeFileSync(
    join(dir, 'connections/uploads.connection.json'),
    JSON.stringify({
      $schema: schemaRef('connection'),
      description: 'the bucket uploads are kept in',
      kind: KIND,
      settings: { bucket: 'uploads' },
    }),
  );
  const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
  project.plugins.push({ use: '@bucket' });
  project.blobs = { connection };
  writeFileSync(join(dir, 'project.json'), JSON.stringify(project));
  try {
    return read(loadTree(dir, { ...PLUGINS, '@bucket': plugin }, INCLUDES));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const refused = (plugin: PluginModule, connection?: string) =>
  reading(plugin, load => checkTree(load).items.map(one => `${one.code} ${one.at} ${one.message}`), connection);

describe('the blob registry behind a connection', () => {
  it('is the store the plugin opens for the named connection, given its settings', () => {
    const given: Record<string, unknown>[] = [];
    const store = new FileBlobStore(tmpdir());
    const plugin = bucket(settings => {
      given.push(settings);
      return store;
    });
    reading(plugin, load => {
      expect(checkTree(load).items).toEqual([]);
      const embedder = new Embedder(new Scope(load.registry, load.resolve), load.plugins, { env: {}, root: load.root });
      expect(embedder.blobs).toBe(store);
      expect(embedder.env.blobs).toBe(store);
    });
    expect(given).toEqual([{ bucket: 'uploads' }]);
  });

  it('is files for a stubbed run, whatever the project names, and the plugin is never asked', () => {
    const plugin = bucket(() => {
      throw new Error('a stubbed run opened the bucket');
    });
    reading(plugin, load => {
      expect(embedderFor(load, { seed: 1 }).blobs).toBeInstanceOf(FileBlobStore);
    });
  });

  it('C014 when no plugin the project names offers a blob store for the connection kind', () => {
    expect(refused(bucket())).toEqual([
      `C014 blobs/connection blobs.connection names '@connections/uploads.connection.json', of kind '${KIND}', and no plugin the project names offers a blob store for that kind`,
    ]);
  });

  it('C014 when blobs.connection names no connection', () => {
    expect(
      refused(
        bucket(() => new FileBlobStore(tmpdir())),
        '@connections/nope.connection.json',
      ),
    ).toEqual([
      "C014 blobs/connection blobs.connection names '@connections/nope.connection.json', which is no connection",
    ]);
  });
});

/** The folders under the system temp dir that this process's blob stores made. */
const madeHere = () => readdirSync(tmpdir()).filter(name => name.startsWith(`wilanis-blobs-${process.pid}-`));

describe('the blob registry on disk', () => {
  it('is one folder for every store of a process when the tree names none', () => {
    const load = loadTree(EXAMPLE, PLUGINS, INCLUDES);
    const dirs = Array.from({ length: 5 }, (_, seed) => (embedderFor(load, { seed }).blobs as FileBlobStore).dir);
    expect(new Set(dirs).size).toBe(1);
    expect(madeHere()).toHaveLength(1);
  });

  it('leaves a folder the tree names, and a file it did not write there, when destroyed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wilanis-named-'));
    try {
      writeFileSync(join(root, 'foreign'), 'written by another process');
      const store = new FileBlobStore(root, '.');
      const handle = await store.put('mine', { contentType: 'text/plain' });
      expect(readdirSync(root)).toHaveLength(2);
      store.destroy();
      expect(readdirSync(root)).toEqual(['foreign']);
      expect(() => store.open(handle)).toThrow(`no blob '${handle.id}' in the registry`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes its folder under the system temp dir when the process exits', () => {
    const temp = mkdtempSync(join(tmpdir(), 'wilanis-exit-'));
    try {
      const blobs = pathToFileURL(fileURLToPath(new URL('../dist/blobs.js', import.meta.url))).href;
      const script = `const { FileBlobStore } = await import(${JSON.stringify(blobs)});
        const one = new FileBlobStore(process.cwd());
        const two = new FileBlobStore(process.cwd());
        await one.put('bytes', { contentType: 'text/plain' });
        console.log(JSON.stringify([one.dir, two.dir]));`;
      const ran = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        env: { ...process.env, TMPDIR: temp },
        encoding: 'utf8',
      });
      expect(ran.stderr).toBe('');
      const [one, two] = JSON.parse(ran.stdout);
      expect(one).toBe(two);
      expect(one.startsWith(temp)).toBe(true);
      expect(readdirSync(temp)).toEqual([]);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
