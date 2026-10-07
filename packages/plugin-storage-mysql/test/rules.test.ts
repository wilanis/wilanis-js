/**
 * X241 to X243: what this engine alone can judge, refused before anything runs and without a server. These are
 * the rules a reader meets as `wilanis check` output rather than as a driver error at three in the morning, so
 * every case here breaks one document of a small tree and reads the code back.
 *
 * Nothing here connects to anything, so it runs whether or not `WILANIS_TEST_MYSQL_URL` is set: a rule is a
 * judgment over documents, and needing a database to judge one would defeat the point of judging it at check
 * time.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import { loadTree, type PluginModule, schemaRef } from '@wilanis/core';
import storage from '@wilanis/plugin-storage';
import { BUILTIN_PLUGINS } from '@wilanis/runtime';
import { describe, expect, it } from 'vitest';
import mysql from '../src/index.js';

const CONNECTION = '@connections/records.connection.json';
const KIND = '@storage-mysql/mysql.connection-kind.json';
const SHAPE = '@features/customers/domain/Customer.shape.json';
const SECRET = 'WILANIS_TEST_MYSQL_RULES_URL';

process.env[SECRET] ??= 'mysql://nobody@127.0.0.1:1/none';

type Docs = Record<string, unknown>;

/** The plugins a project names, with the engine's own settings where it is given any. */
const named = (settings?: Record<string, unknown>) => [
  { use: '@std' },
  { use: '@storage' },
  settings ? { use: '@storage-mysql', settings } : { use: '@storage-mysql' },
];

/** A tree that keeps one collection over a mysql connection, and passes as it stands. */
function tree(): Docs {
  return {
    'project.json': {
      $schema: schemaRef('project'),
      description: 'a tree that keeps what it observes in mysql',
      name: 'kept-in-mysql',
      plugins: named(),
      secrets: { database: SECRET },
    },
    'connections/records.connection.json': {
      $schema: schemaRef('connection'),
      description: 'the database the records live in',
      kind: KIND,
      settings: { url: '{{secrets.database}}' },
    },
    'features/customers/feature.json': {
      $schema: schemaRef('feature'),
      description: 'who the registry keeps',
      effects: ['@storage/store.port.json#get'],
    },
    'features/customers/domain/Customer.shape.json': {
      $schema: schemaRef('shape'),
      description: 'one observed call',
      layer: 'core',
      fields: { id: { type: 'string' }, url: { type: 'string' }, hits: { type: 'number' } },
    },
    'features/customers/data/customers.store.json': {
      $schema: schemaRef('store'),
      description: 'the entries kept so far',
      connection: CONNECTION,
      collections: { entries: { of: SHAPE, key: 'id' } },
    },
  };
}

const PLUGINS: Record<string, PluginModule> = { ...BUILTIN_PLUGINS, '@storage': storage, '@storage-mysql': mysql };

/** Write a tree, check it, and answer each refusal as the code it is and the place it points at. */
function refusals(docs: Docs): (readonly [string, string])[] {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-mysql-rules-'));
  for (const [relative, doc] of Object.entries(docs)) {
    const path = join(dir, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(doc));
  }
  const found = checkTree(loadTree(dir, PLUGINS));
  rmSync(dir, { recursive: true, force: true });
  return found.items.map(one => [one.code, one.at ?? ''] as const);
}

/** The tree with one document replaced by the result of editing it. */
function editing(file: string, edit: (doc: any) => void): Docs {
  const docs = tree();
  edit(docs[file]);
  return docs;
}

/** The tree with the engine given these settings. */
function configured(docs: Docs, settings: Record<string, unknown>): Docs {
  return {
    ...docs,
    'project.json': { ...(docs['project.json'] as Record<string, unknown>), plugins: named(settings) },
  };
}

const SHAPE_FILE = 'features/customers/domain/Customer.shape.json';
const store = (edit: (doc: any) => void) => refusals(editing('features/customers/data/customers.store.json', edit));
const shape = (edit: (doc: any) => void) => refusals(editing(SHAPE_FILE, edit));

describe('what this engine refuses before anything runs', () => {
  it('passes as it stands, so every case below fails for the reason it names', () => {
    expect(refusals(tree())).toEqual([]);
  });

  it('X241 a blob field, which this engine has no column for', () => {
    expect(shape(doc => (doc.fields.file = { type: 'blob' }))).toEqual([['X241', 'collections/entries/of']]);
  });

  it('X242 a key this engine cannot key by', () => {
    expect(shape(doc => (doc.fields.id = { type: 'boolean' }))).toEqual([['X242', 'collections/entries/key']]);
  });

  it('X242 a number key uuidv7 cannot answer, which identity can', () => {
    const numbered = editing(SHAPE_FILE, doc => (doc.fields.id = { type: 'number' }));
    expect(refusals(numbered)).toEqual([['X242', 'collections/entries/key']]);
    expect(refusals(configured(numbered, { keyType: 'identity' }))).toEqual([]);
  });

  it('X242 identity over a string key, which counts nothing', () => {
    expect(refusals(configured(tree(), { keyType: 'identity' }))).toEqual([['X242', 'collections/entries/key']]);
  });

  it('X243 a collection name longer than MySQL keeps a table name', () => {
    const long = `entries${'X'.repeat(58)}`;
    expect(store(doc => (doc.collections = { [long]: { of: SHAPE, key: 'id' } }))).toEqual([
      ['X243', `collections/${long}`],
    ]);
    const longest = `entries${'X'.repeat(57)}`;
    expect(store(doc => (doc.collections = { [longest]: { of: SHAPE, key: 'id' } }))).toEqual([]);
  });

  it('X243 two collections of one connection that fold to one table name', () => {
    expect(
      store(doc => {
        doc.collections = { entriesKept: { of: SHAPE, key: 'id' }, entrieskept: { of: SHAPE, key: 'id' } };
      }),
    ).toEqual([['X243', 'collections/entrieskept']]);
  });

  it('X243 a field name longer than MySQL keeps a column name', () => {
    expect(shape(doc => (doc.fields[`hits${'X'.repeat(61)}`] = { type: 'number' }))).toEqual([
      ['X243', 'collections/entries/of'],
    ]);
    expect(shape(doc => (doc.fields[`hits${'X'.repeat(60)}`] = { type: 'number' }))).toEqual([]);
  });

  it('X243 two fields of one shape that fold to one column name', () => {
    expect(shape(doc => (doc.fields.hitS = { type: 'number' }))).toEqual([['X243', 'collections/entries/of']]);
  });
});
