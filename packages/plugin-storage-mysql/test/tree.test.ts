/**
 * A tree that names this engine, judged without a database: the checker is content with a store over a mysql
 * connection, the kind says what a connection of it takes and what the engine can do, and the block is what
 * RFC 0003's rule reads -- a `unique` over a shape is refused naming this kind and its list. Nothing here
 * connects to anything, so it runs in every job whether or not `WILANIS_TEST_MYSQL_URL` is set.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import { loadTree, type PluginModule, schemaRef } from '@wilanis/core';
import storage, { capabilitiesOf } from '@wilanis/plugin-storage';
import { BUILTIN_PLUGINS, embedderFor, FileBlobStore } from '@wilanis/runtime';
import { afterAll, describe, expect, it } from 'vitest';
import mysql from '../src/index.js';

const CONNECTION = '@connections/records.connection.json';
const KIND = '@storage-mysql/mysql.connection-kind.json';
const SHAPE = '@features/customers/domain/Customer.shape.json';
const STORE = 'features/customers/data/customers.store.json';
const SECRET = 'WILANIS_TEST_MYSQL_TREE_URL';

process.env[SECRET] ??= 'mysql://nobody@127.0.0.1:1/none';

type Docs = Record<string, unknown>;

/** A tree that keeps one collection over a mysql connection, as RFC 0022's guide writes one. */
function tree(): Docs {
  return {
    'project.json': {
      $schema: schemaRef('project'),
      description: 'a tree that keeps its customers in the team MySQL',
      name: 'kept-in-mysql',
      plugins: [{ use: '@std' }, { use: '@storage' }, { use: '@storage-mysql' }],
      secrets: { database: SECRET },
    },
    'connections/records.connection.json': {
      $schema: schemaRef('connection'),
      description: 'the database the records live in',
      kind: KIND,
      settings: { url: '{{secrets.database}}', pool: { max: 10 } },
    },
    'features/customers/feature.json': { $schema: schemaRef('feature'), description: 'who the registry keeps' },
    'features/customers/domain/Customer.shape.json': {
      $schema: schemaRef('shape'),
      description: 'one customer',
      layer: 'core',
      fields: {
        id: { type: 'string' },
        email: { type: 'string' },
        meta: { type: '@features/customers/domain/Meta.shape.json', required: false },
      },
    },
    'features/customers/domain/Meta.shape.json': {
      $schema: schemaRef('shape'),
      description: 'what else is known about one',
      layer: 'core',
      fields: { source: { type: 'string' } },
    },
    [STORE]: {
      $schema: schemaRef('store'),
      description: 'the customers kept so far',
      connection: CONNECTION,
      collections: { customers: { of: SHAPE, key: 'id', unique: [['email']] } },
    },
  };
}

const PLUGINS: Record<string, PluginModule> = { ...BUILTIN_PLUGINS, '@storage': storage, '@storage-mysql': mysql };
const scratch = mkdtempSync(join(tmpdir(), 'wilanis-mysql-tree-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Write a tree into a directory of its own and load it. */
function loaded(docs: Docs) {
  const dir = mkdtempSync(join(scratch, 'tree-'));
  for (const [relative, doc] of Object.entries(docs)) {
    const path = join(dir, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(doc));
  }
  return loadTree(dir, PLUGINS);
}

describe('a tree that names this engine', () => {
  it('stands: a store may name a connection of this kind, and the checker is content', () => {
    expect(checkTree(loaded(tree())).format()).toBe('');
  });

  it('the kind says it reaches a storage engine, and that a connection of it names a url and a pool', () => {
    const kind = loaded(tree()).registry.get('connection-kind', KIND);
    expect(kind?.doc.storage).toBe(true);
    expect(Object.keys(kind?.doc.settings.fields ?? {})).toEqual(['url', 'pool']);
    expect(kind?.doc.settings.fields.url.secret).toBe(true);
  });

  it('the kind says what the engine can do: DDL step by step, unique over the three scalars, and refs', () => {
    const loadedTree = loaded(tree());
    const emb = embedderFor(loadedTree);
    try {
      expect(capabilitiesOf(emb.env, loadedTree.resolve(CONNECTION))).toEqual({
        transactionalDdl: false,
        unique: ['string', 'number', 'boolean'],
        refs: true,
      });
    } finally {
      if (emb.blobs instanceof FileBlobStore) emb.blobs.destroy();
    }
  });

  it('a unique naming a shape field is refused, naming this kind and the classes it constrains', () => {
    const docs = tree();
    const store = docs[STORE] as { collections: { customers: { unique: string[][] } } };
    store.collections.customers.unique = [['email', 'meta']];
    const found = checkTree(loaded(docs)).items.filter(one => one.code === 'C008');
    expect(found).toHaveLength(1);
    expect(found[0].at).toBe('collections/customers/unique/0/1');
    expect(found[0].hint).toContain(`${KIND} constrains unique over string, number, boolean`);
  });
});
