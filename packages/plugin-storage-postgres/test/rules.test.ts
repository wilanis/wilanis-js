/**
 * X221 to X223: what this engine alone can judge, refused before anything runs and without a database. These
 * are the rules a reader meets as `wilanis check` output rather than as a driver error at three in the
 * morning, so every case here breaks one document of a small tree and reads the code back.
 *
 * Nothing here connects to anything: a rule is a judgment over documents, and needing a database to judge one
 * would defeat the point of judging it at check time.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import { loadTree, type PluginModule, schemaRef } from '@wilanis/core';
import storage from '@wilanis/plugin-storage';
import { BUILTIN_PLUGINS } from '@wilanis/runtime';
import { describe, expect, it } from 'vitest';
import postgres from '../src/index.js';

const CONNECTION = '@connections/records.connection.json';
const KIND = '@storage-postgres/postgres.connection-kind.json';
const SHAPE = '@features/customers/domain/Customer.shape.json';

type Docs = Record<string, unknown>;

/** A tree that keeps one collection over a postgres connection, and passes as it stands. */
function tree(): Docs {
  return {
    'project.json': {
      $schema: schemaRef('project'),
      description: 'a tree that keeps what it observes in postgres',
      name: 'kept-in-postgres',
      plugins: [{ use: '@std' }, { use: '@storage' }, { use: '@storage-postgres' }],
      secrets: { database: 'WILANIS_TEST_DATABASE_URL' },
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

const PLUGINS: Record<string, PluginModule> = {
  ...BUILTIN_PLUGINS,
  '@storage': storage,
  '@storage-postgres': postgres,
};

/** Write a tree, check it, and answer each refusal as the code it is and the place it points at. */
function refusals(docs: Docs): (readonly [string, string])[] {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-pg-rules-'));
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

const store = (edit: (doc: any) => void) => refusals(editing('features/customers/data/customers.store.json', edit));
const shape = (edit: (doc: any) => void) => refusals(editing('features/customers/domain/Customer.shape.json', edit));

describe('what this engine refuses before anything runs', () => {
  it('passes as it stands, so every case below fails for the reason it names', () => {
    expect(refusals(tree())).toEqual([]);
  });

  it('X221 a field this engine has no column for', () => {
    expect(shape(doc => (doc.fields.file = { type: 'blob' }))).toEqual([['X221', 'collections/entries/of']]);
  });

  it('X222 a key this engine cannot key by', () => {
    const codes = refusals({
      ...editing('features/customers/domain/Customer.shape.json', doc => (doc.fields.id = { type: 'boolean' })),
    });
    expect(codes).toEqual([['X222', 'collections/entries/key']]);
  });

  it('X222 a key the configured keyType cannot answer', () => {
    const numbered = editing(
      'features/customers/domain/Customer.shape.json',
      doc => (doc.fields.id = { type: 'number' }),
    );
    expect(refusals(numbered)).toEqual([['X222', 'collections/entries/key']]);

    const counted = { ...numbered } as Docs;
    counted['project.json'] = {
      ...(numbered['project.json'] as Record<string, unknown>),
      plugins: [{ use: '@std' }, { use: '@storage' }, { use: '@storage-postgres', settings: { keyType: 'identity' } }],
    };
    expect(refusals(counted)).toEqual([]);
  });

  it('X222 identity over a string key, which counts nothing', () => {
    const docs = tree();
    docs['project.json'] = {
      ...(docs['project.json'] as Record<string, unknown>),
      plugins: [{ use: '@std' }, { use: '@storage' }, { use: '@storage-postgres', settings: { keyType: 'identity' } }],
    };
    expect(refusals(docs)).toEqual([['X222', 'collections/entries/key']]);
  });

  it('X223 a collection name longer than a table name PostgreSQL keeps whole', () => {
    const long = `entries${'X'.repeat(60)}`;
    expect(store(doc => (doc.collections = { [long]: { of: SHAPE, key: 'id' } }))).toEqual([
      ['X223', `collections/${long}`],
    ]);
  });

  it('X223 two collections of one connection that fold to one table name', () => {
    expect(
      store(doc => {
        doc.collections = { entriesKept: { of: SHAPE, key: 'id' }, entrieskept: { of: SHAPE, key: 'id' } };
      }),
    ).toEqual([['X223', 'collections/entrieskept']]);
  });
});
