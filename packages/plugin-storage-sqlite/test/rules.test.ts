/**
 * X231 to X233: what this engine alone can judge, refused before anything runs and without opening a file. These
 * are the rules a reader meets as `wilanis check` output rather than as a driver error at three in the
 * morning, so every case here breaks one document of a small tree and reads the code back.
 *
 * Nothing here opens a file: a rule is a judgment over documents, and needing a database to judge one would
 * defeat the point of judging it at check time.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import { loadTree, type PluginModule, schemaRef } from '@wilanis/core';
import storage from '@wilanis/plugin-storage';
import { BUILTIN_PLUGINS } from '@wilanis/runtime';
import { describe, expect, it } from 'vitest';
import sqlite from '../src/index.js';

const CONNECTION = '@connections/records.connection.json';
const KIND = '@storage-sqlite/sqlite.connection-kind.json';
const SHAPE = '@features/customers/domain/Customer.shape.json';

type Docs = Record<string, unknown>;

/** A tree that keeps one collection over a sqlite connection, and passes as it stands. */
function tree(): Docs {
  return {
    'project.json': {
      $schema: schemaRef('project'),
      description: 'a tree that keeps what it observes in sqlite',
      name: 'kept-in-sqlite',
      plugins: [{ use: '@std' }, { use: '@storage' }, { use: '@storage-sqlite' }],
    },
    'connections/records.connection.json': {
      $schema: schemaRef('connection'),
      description: 'the file the records live in',
      kind: KIND,
      settings: { file: '.wilanis/records.sqlite' },
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
  '@storage-sqlite': sqlite,
};

/** Write a tree, check it, and answer each refusal as the code it is and the place it points at. */
function refusals(docs: Docs): (readonly [string, string])[] {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-sqlite-rules-'));
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

  it('X231 a field this engine has no column for', () => {
    expect(shape(doc => (doc.fields.file = { type: 'blob' }))).toEqual([['X231', 'collections/entries/of']]);
  });

  it('X232 a key this engine cannot key by', () => {
    const codes = refusals({
      ...editing('features/customers/domain/Customer.shape.json', doc => (doc.fields.id = { type: 'boolean' })),
    });
    expect(codes).toEqual([['X232', 'collections/entries/key']]);
  });

  it('X232 a key the configured keyType cannot answer', () => {
    const numbered = editing(
      'features/customers/domain/Customer.shape.json',
      doc => (doc.fields.id = { type: 'number' }),
    );
    expect(refusals(numbered)).toEqual([['X232', 'collections/entries/key']]);

    const counted = { ...numbered } as Docs;
    counted['project.json'] = {
      ...(numbered['project.json'] as Record<string, unknown>),
      plugins: [{ use: '@std' }, { use: '@storage' }, { use: '@storage-sqlite', settings: { keyType: 'identity' } }],
    };
    expect(refusals(counted)).toEqual([]);
  });

  it('X232 identity over a string key, which counts nothing', () => {
    const docs = tree();
    docs['project.json'] = {
      ...(docs['project.json'] as Record<string, unknown>),
      plugins: [{ use: '@std' }, { use: '@storage' }, { use: '@storage-sqlite', settings: { keyType: 'identity' } }],
    };
    expect(refusals(docs)).toEqual([['X232', 'collections/entries/key']]);
  });

  it('X233 a collection name SQLite keeps for its own', () => {
    expect(store(doc => (doc.collections = { sqlite_entries: { of: SHAPE, key: 'id' } }))).toEqual([
      ['X233', 'collections/sqlite_entries'],
    ]);
  });

  it('X233 two collections of one connection that fold to one table name', () => {
    expect(
      store(doc => {
        doc.collections = { entriesKept: { of: SHAPE, key: 'id' }, entrieskept: { of: SHAPE, key: 'id' } };
      }),
    ).toEqual([['X233', 'collections/entrieskept']]);
  });
});
