/**
 * A tree small enough to break one way at a time: one feature with an operation to fire, one scheduled
 * trigger, and a connection whose kind can keep a lease. Every case copies it, edits one document, and
 * answers the refusal codes, as `packages/plugin-storage/test` does for its own.
 *
 * The keeper here grants a connection kind marked `leases` and nothing else -- @schedule judges a lease
 * against the kind, never against a keeper, so a kind document is all a rule needs.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import { loadTree, type PluginModule, schemaRef } from '@wilanis/core';
import { BUILTIN_PLUGINS } from '@wilanis/runtime';
import schedule from '../src/index.js';

export const KEEPER = '@fake-keeper';
export const LEASING_KIND = `${KEEPER}/kept.connection-kind.json`;
export const PLAIN_KIND = `${KEEPER}/plain.connection-kind.json`;
export const LEASE = '@connections/holds.connection.json';
export const PLAIN = '@connections/plain.connection.json';
export const TRIGGER = 'features/customers/edge/digest.trigger.json';

/** A directory of documents, written as a plugin's docs. */
function docsDir(docs: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-schedule-docs-'));
  for (const [name, doc] of Object.entries(docs)) writeFileSync(join(dir, name), JSON.stringify(doc));
  return dir;
}

/** A plugin granting one kind that can keep a lease and one that cannot, so X254 has an honest way to be wrong. */
export const keeper: PluginModule = {
  root: KEEPER,
  docs: docsDir({
    'plugin.json': {
      $schema: schemaRef('plugin'),
      description: 'A keeper for tests: it grants a kind a lease may be held on, and holds nothing.',
      grants: { connectionKinds: [LEASING_KIND, PLAIN_KIND] },
    },
    'kept.connection-kind.json': {
      $schema: schemaRef('connection-kind'),
      description: 'A connection reaching something that can keep a named hold.',
      settings: { fields: {} },
      leases: true,
    },
    'plain.connection-kind.json': {
      $schema: schemaRef('connection-kind'),
      description: 'A connection reaching something that keeps no hold at all.',
      settings: { fields: {} },
    },
  }),
  handlers: {},
};

export const PLUGINS: Record<string, PluginModule> = {
  ...BUILTIN_PLUGINS,
  '@schedule': schedule,
  [KEEPER]: keeper,
};

/** One document of the tree, by the path it sits at. */
export type Docs = Record<string, unknown>;

/** The tree as it stands when nothing is broken: one nightly digest, kept by a lease. */
export function tree(): Docs {
  return {
    'project.json': {
      $schema: schemaRef('project'),
      description: 'a tree with something to do at night',
      name: 'nightly',
      plugins: [{ use: '@std' }, { use: '@schedule' }, { use: KEEPER }],
      startup: [{ label: 'Keep the schedule', run: '@schedule/scheduler.port.json#run', in: { lease: LEASE } }],
    },
    'connections/holds.connection.json': {
      $schema: schemaRef('connection'),
      description: 'where a tick is held while one instance fires it',
      kind: LEASING_KIND,
      settings: {},
    },
    'connections/plain.connection.json': {
      $schema: schemaRef('connection'),
      description: 'something that keeps no hold',
      kind: PLAIN_KIND,
      settings: {},
    },
    'features/customers/feature.json': {
      $schema: schemaRef('feature'),
      description: 'who the registry keeps',
    },
    'features/customers/domain/Digest.shape.json': {
      $schema: schemaRef('shape'),
      description: 'what a digest says',
      layer: 'core',
      fields: { count: { type: 'number' } },
    },
    'features/customers/edge/DigestView.shape.json': {
      $schema: schemaRef('shape'),
      description: 'the digest as it is logged: judged and written down, never delivered',
      layer: 'edge',
      fields: { count: { type: 'number' } },
    },
    'features/customers/edge/Cutoff.shape.json': {
      $schema: schemaRef('shape'),
      description: 'what a tick could hand a graph, where one took something',
      layer: 'edge',
      fields: { before: { type: 'string' } },
    },
    'features/customers/domain/customer.port.json': {
      $schema: schemaRef('port'),
      description: 'what the registry can be asked for',
      operations: {
        digest: { description: 'the digest of what was seen', returns: '@features/customers/domain/Digest.shape.json' },
      },
    },
    'features/customers/data/digest.binding.json': {
      $schema: schemaRef('binding'),
      description: 'how the digest is made',
      port: '@features/customers/domain/customer.port.json',
      operations: { digest: { graph: '@features/customers/data/count.graph.json' } },
    },
    'features/customers/data/count.graph.json': {
      $schema: schemaRef('graph'),
      description: 'how many were seen',
      out: { type: '@features/customers/domain/Digest.shape.json', from: 'counted' },
      nodes: [
        {
          id: 'counted',
          type: '@wilanis/node/run.schema.json',
          run: '@std/object.port.json#make',
          in: { value: { count: 0 }, type: '@features/customers/domain/Digest.shape.json' },
        },
      ],
    },
    [TRIGGER]: {
      $schema: schemaRef('trigger'),
      description: 'the digest, every night at three',
      kind: '@schedule/schedule.trigger-kind.json',
      settings: { cron: '0 3 * * *', timezone: 'UTC' },
      out: '@features/customers/edge/DigestView.shape.json',
      fire: { run: '@features/customers/domain/customer.port.json#digest' },
    },
  };
}

/** Write a tree into a directory of its own; the caller removes it. */
function write(docs: Docs): string {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-schedule-'));
  for (const [relative, doc] of Object.entries(docs)) {
    const path = join(dir, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(doc));
  }
  return dir;
}

/** The refusals a tree answers with, as code and where each points. */
export function refusals(docs: Docs): { code: string; at: string; file: string; message: string }[] {
  const dir = write(docs);
  const found = checkTree(loadTree(dir, PLUGINS)).items;
  rmSync(dir, { recursive: true, force: true });
  return found.map(one => ({ code: one.code, at: one.at ?? '', file: one.file, message: one.message }));
}

/** The refusal codes a tree answers with. */
export const codes = (docs: Docs) => refusals(docs).map(one => one.code);

/** The tree with one document replaced by the result of editing it. */
export function editing(file: string, edit: (doc: any) => void): Docs {
  const docs = tree();
  edit(docs[file]);
  return docs;
}
