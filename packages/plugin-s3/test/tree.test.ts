/**
 * The plugin in a tree (RFC 0005 step 6): `project.json → blobs.connection` names a bucket connection, the
 * embedder opens the plugin's store for it, `start` probes the bucket and refuses to start without one, and a
 * run's files go to the bucket and back and are deleted when the run releases them.
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import { type LoadResult, loadTree, Scope } from '@wilanis/core';
import { Embedder, runTrigger, start } from '@wilanis/runtime';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { S3BlobStore } from '../src/index.js';
import { type FakeS3, startFakeS3 } from './fake-s3.js';
import { PLUGINS, SECRETS, writeTree } from './tree.js';

describe('a tree whose blobs are kept in a bucket', () => {
  let fake: FakeS3;
  let dir: string;
  let load: LoadResult;
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);
  beforeAll(() => Object.assign(process.env, SECRETS));
  afterAll(() => {
    for (const name of Object.keys(SECRETS)) delete process.env[name];
  });
  beforeEach(async () => {
    fake = await startFakeS3();
    dir = writeTree(fake.endpoint, fake.bucket);
    load = loadTree(dir, PLUGINS);
    lines.length = 0;
  });
  afterEach(async () => {
    rmSync(dir, { recursive: true, force: true });
    await fake.close();
  });

  it('checks, and start probes the bucket once before anything runs', async () => {
    expect(checkTree(load).items).toEqual([]);
    const started = await start(load, { log });
    try {
      expect(fake.seen.map(one => `${one.op} ${one.key.split('/')[0]}`)).toEqual([
        'putObject uploads',
        'deleteObject uploads',
      ]);
      expect(fake.objects.size).toBe(0);
      expect(lines).toContain("@s3: blobs are kept in bucket 'uploads' under 'uploads'");
    } finally {
      await started.stop();
    }
  });

  it('refuses to start when the bucket cannot be written', async () => {
    rmSync(dir, { recursive: true, force: true });
    dir = writeTree(fake.endpoint, 'nope');
    await expect(start(loadTree(dir, PLUGINS), { log })).rejects.toThrow(
      "plugin '@s3' postLoad: the blob registry's bucket 'nope' under 'uploads' cannot be written: NoSuchBucket",
    );
  });

  it('streams the file handed in to the bucket, reads it back from there, and deletes it once the run ends', async () => {
    const ran = await runTrigger(load, '@features/files/edge/read.trigger.json', {
      flags: { file: join(dir, 'in.csv') },
    });
    expect(ran.report.status).toBe('done');
    expect(ran.answer).toBe('id,name\n1,Ada\n');
    const file = fake.seen.find(one => one.op === 'putObject' && one.bytes > 0);
    expect(file?.key).toMatch(/^uploads\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/);
    expect(fake.seen.filter(one => one.key === file?.key).map(one => one.op)).toEqual([
      'putObject',
      'getObject',
      'deleteObject',
    ]);
    expect(fake.objects.size).toBe(0);
  });

  it('delivers a file an operation wrote as a stream from the bucket', async () => {
    const delivered: string[] = [];
    const ran = await runTrigger(
      load,
      '@features/files/edge/hello.trigger.json',
      {},
      {
        deliver: async body => {
          let text = '';
          for await (const chunk of body) text += chunk;
          delivered.push(text);
        },
      },
    );
    expect(ran.report.status).toBe('done');
    expect(delivered).toEqual(['hello']);
    expect(fake.seen.some(one => one.op === 'getObject')).toBe(true);
    expect(fake.objects.size).toBe(0);
  });

  it('opens the store for the connection, and none where the tree ships the connection but keeps files', async () => {
    expect(new Embedder(new Scope(load.registry, load.resolve), load.plugins, { root: dir }).blobs).toBeInstanceOf(
      S3BlobStore,
    );
    rmSync(dir, { recursive: true, force: true });
    dir = writeTree(fake.endpoint, fake.bucket, { files: true });
    const files = loadTree(dir, PLUGINS);
    expect(checkTree(files).items).toEqual([]);
    const started = await start(files, { log });
    await started.stop();
    expect(fake.seen).toEqual([]);
  });
});
