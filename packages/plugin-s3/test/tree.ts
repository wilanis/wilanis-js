/**
 * A tree whose blob registry is a bucket, small enough to run with no network but the fake: a command-line
 * trigger that reads the file `--file` hands in, and one that answers a file, both through `@blob`, so every
 * byte either one touches goes to the bucket and back. The connection reads its credentials as secrets.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type PluginModule, schemaRef } from '@wilanis/core';
import blob from '@wilanis/plugin-blob';
import { BUILTIN_PLUGINS } from '@wilanis/runtime';
import s3 from '../src/index.js';

export const PLUGINS: Record<string, PluginModule> = { ...BUILTIN_PLUGINS, '@blob': blob, '@s3': s3 };

/** The environment variables the tree's secrets are read from. */
export const SECRETS = { S3_TEST_KEY: 'fake-key', S3_TEST_SECRET: 'fake-secret' };

const FILES = '@features/files';

/** The tree's documents, by the path each sits at, with the bucket at `endpoint` named `bucket`. */
function documents(endpoint: string, bucket: string): Record<string, unknown> {
  return {
    'project.json': {
      $schema: schemaRef('project'),
      name: 'uploads',
      description: 'a tree whose files are kept in a bucket',
      plugins: [{ use: '@std' }, { use: '@cli' }, { use: '@blob' }, { use: '@s3', from: '@wilanis/plugin-s3' }],
      secrets: { s3Key: 'S3_TEST_KEY', s3Secret: 'S3_TEST_SECRET' },
      blobs: { connection: '@connections/uploads.connection.json' },
    },
    'connections/uploads.connection.json': {
      $schema: schemaRef('connection'),
      description: 'the bucket the files are kept in',
      kind: '@s3/bucket.connection-kind.json',
      settings: {
        endpoint,
        region: 'us-east-1',
        bucket,
        prefix: 'uploads',
        accessKeyId: '{{secrets.s3Key}}',
        secretAccessKey: '{{secrets.s3Secret}}',
      },
    },
    'features/files/feature.json': {
      $schema: schemaRef('feature'),
      description: 'files read and written',
      effects: ['@blob/text.port.json#read', '@blob/text.port.json#write'],
    },
    'features/files/domain/files.port.json': {
      $schema: schemaRef('port'),
      description: 'what can be done with a file',
      operations: {
        read: { description: 'the text of a file', accepts: { file: { type: 'blob' } }, returns: 'string' },
        hello: { description: 'a file that says hello', returns: 'blob' },
      },
    },
    'features/files/data/files.binding.json': {
      $schema: schemaRef('binding'),
      description: 'files through @blob',
      port: `${FILES}/domain/files.port.json`,
      operations: {
        read: { run: '@blob/text.port.json#read' },
        hello: { run: '@blob/text.port.json#write', in: { text: 'hello', filename: 'hello.txt' } },
      },
    },
    'features/files/edge/Upload.shape.json': {
      $schema: schemaRef('shape'),
      description: 'a file handed in',
      layer: 'edge',
      fields: { file: { type: 'blob' } },
    },
    'features/files/edge/read.trigger.json': {
      $schema: schemaRef('trigger'),
      description: 'print the text of the file handed in',
      kind: '@cli/cli.trigger-kind.json',
      settings: {},
      in: `${FILES}/edge/Upload.shape.json`,
      out: 'string',
      fire: { run: `${FILES}/domain/files.port.json#read`, in: { file: '{{request.file}}' } },
    },
    'features/files/edge/hello.trigger.json': {
      $schema: schemaRef('trigger'),
      description: 'answer a file that says hello',
      kind: '@cli/cli.trigger-kind.json',
      settings: {},
      out: 'blob',
      fire: { run: `${FILES}/domain/files.port.json#hello` },
    },
  };
}

/**
 * The tree written to a fresh directory, with a file to hand in beside it; answers the directory. With `files`,
 * the tree ships the bucket connection and names no `blobs.connection`, so its blobs stay in files.
 */
export function writeTree(endpoint: string, bucket: string, opts: { files?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-s3-'));
  const docs = documents(endpoint, bucket);
  if (opts.files) delete (docs['project.json'] as { blobs?: unknown }).blobs;
  for (const [path, doc] of Object.entries(docs)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), JSON.stringify(doc));
  }
  writeFileSync(join(dir, 'in.csv'), 'id,name\n1,Ada\n');
  return dir;
}
