/**
 * A tree small enough to break one way at a time: a feature that keeps customers behind a connection, and a
 * data graph that reads them. Every case copies it, edits one document, and answers the refusal codes.
 *
 * The engine here grants a storage connection kind and nothing else -- `@storage` judges a store against the
 * kind, never against an engine, so a kind document is all a rule needs. The real engines are packages of
 * their own.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import { loadTree, type PluginModule, schemaRef } from '@wilanis/core';
import { BUILTIN_PLUGINS } from '@wilanis/runtime';
import storage from '../src/index.js';

export const ENGINE = '@fake-engine';
export const KIND = `${ENGINE}/fake.connection-kind.json`;
export const CONNECTION = '@connections/records.connection.json';
export const STORE = '@features/customers/data/customers.store.json';
export const SHAPE = '@features/customers/domain/Customer.shape.json';

/** A directory of documents, written as a plugin's docs. */
function docsDir(docs: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-engine-docs-'));
  for (const [name, doc] of Object.entries(docs)) writeFileSync(join(dir, name), JSON.stringify(doc));
  return dir;
}

/** An engine plugin: one connection kind marked storage, no port, no handler. */
export const engine: PluginModule = {
  root: ENGINE,
  docs: docsDir({
    'plugin.json': {
      $schema: schemaRef('plugin'),
      description: 'An engine for tests: it grants the kind a store may name, and keeps nothing.',
      grants: { connectionKinds: ['@fake-engine/fake.connection-kind.json'] },
    },
    'fake.connection-kind.json': {
      $schema: schemaRef('connection-kind'),
      description: 'A connection reaching an engine that exists only while a test runs.',
      settings: { fields: {} },
      storage: true,
    },
  }),
  handlers: {},
};

/** A kind that reaches something other than a storage engine, so X203 has an honest way to be wrong. */
export const upstream: PluginModule = {
  root: '@fake-upstream',
  docs: docsDir({
    'plugin.json': {
      $schema: schemaRef('plugin'),
      description: 'A plugin granting a connection kind that reaches no storage engine at all.',
      grants: { connectionKinds: ['@fake-upstream/upstream.connection-kind.json'] },
    },
    'upstream.connection-kind.json': {
      $schema: schemaRef('connection-kind'),
      description: 'A connection reaching something that is not a store.',
      settings: { fields: {} },
    },
  }),
  handlers: {},
};

export const PLUGINS: Record<string, PluginModule> = {
  ...BUILTIN_PLUGINS,
  '@storage': storage,
  [ENGINE]: engine,
  '@fake-upstream': upstream,
};

/** One document of the tree, by the path it sits at. */
export type Docs = Record<string, unknown>;

/** The tree as it stands when nothing is broken: it keeps customers, and one graph reads one. */
export function tree(): Docs {
  return {
    'project.json': {
      $schema: schemaRef('project'),
      description: 'a tree that keeps who it serves',
      name: 'kept',
      plugins: [{ use: '@std' }, { use: '@storage' }, { use: ENGINE }, { use: '@fake-upstream' }],
    },
    'connections/records.connection.json': {
      $schema: schemaRef('connection'),
      description: 'where the records live',
      kind: KIND,
      settings: {},
    },
    'features/customers/feature.json': {
      $schema: schemaRef('feature'),
      description: 'who the registry keeps',
      effects: ['@storage/store.port.json#find'],
    },
    'features/customers/domain/Customer.shape.json': {
      $schema: schemaRef('shape'),
      description: 'one customer',
      layer: 'core',
      fields: {
        id: { type: 'string' },
        email: { type: 'string' },
        orders: { type: 'number' },
        active: { type: 'boolean' },
        tags: { type: 'string[]' },
        note: { type: 'string', required: false },
      },
    },
    'features/customers/domain/Ref.shape.json': {
      $schema: schemaRef('shape'),
      description: 'which customers are wanted: one id, the addresses to match, and whether the tags matter',
      layer: 'core',
      fields: { id: { type: 'string' }, emails: { type: 'string[]' }, tagged: { type: 'boolean' } },
    },
    'features/customers/edge/CustomerRow.shape.json': {
      $schema: schemaRef('shape'),
      description: 'a customer as the world sends it',
      layer: 'edge',
      fields: { id: { type: 'string' }, email: { type: 'string' } },
    },
    'features/customers/data/customers.store.json': {
      $schema: schemaRef('store'),
      description: 'the customers kept so far',
      connection: CONNECTION,
      collections: { customers: { of: SHAPE, key: 'id' } },
    },
    'features/customers/data/read-customer.graph.json': {
      $schema: schemaRef('graph'),
      description: 'one customer by its id',
      in: '@features/customers/domain/Ref.shape.json',
      out: { type: `${SHAPE}[]`, from: ['asked'] },
      nodes: [
        {
          id: 'asked',
          type: '@wilanis/node/run.schema.json',
          run: '@storage/store.port.json#find',
          in: {
            store: STORE,
            collection: 'customers',
            where: { id: '{{in.id}}', email: { in: '{{in.emails}}' }, tags: { has: '{{in.tagged}}' } },
          },
        },
      ],
    },
  };
}

/** Write a tree into a directory of its own; the caller removes it. */
function write(docs: Docs): string {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-storage-'));
  for (const [relative, doc] of Object.entries(docs)) {
    const path = join(dir, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(doc));
  }
  return dir;
}

/** The refusals a tree answers with: the code, where each points, what it says, and the edit it offers. */
export function refusals(docs: Docs): { code: string; at: string; file: string; message: string; hint: string }[] {
  const dir = write(docs);
  const found = checkTree(loadTree(dir, PLUGINS)).items;
  rmSync(dir, { recursive: true, force: true });
  return found.map(one => ({
    code: one.code,
    at: one.at ?? '',
    file: one.file,
    message: one.message,
    hint: one.hint ?? '',
  }));
}

/** The refusal codes a tree answers with. */
export const codes = (docs: Docs) => refusals(docs).map(one => one.code);

/** The tree with one document replaced by the result of editing it. */
export function editing(file: string, edit: (doc: any) => void): Docs {
  const docs = tree();
  edit(docs[file]);
  return docs;
}
