/**
 * This engine, judged by the same cases the memory and postgres ones are. The behaviour is not restated here:
 * it is @storage's shared suite, which is what makes "this is an engine" one executable meaning rather than a
 * promise in a README. It needs nothing but a temporary directory, so unlike the postgres suite it runs in
 * every CI job, unconditionally.
 *
 * Never against `:memory:`: a transaction opens a handle of its own on the file, and on an in-memory database
 * that handle would be a second, empty database. What is proved instead is the point of the engine -- the file
 * is still there, records and all, when the tree is loaded a second time.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import { loadTree, type PluginModule, TypeResolver } from '@wilanis/core';
import storage, { type At, engines } from '@wilanis/plugin-storage';
import { cases } from '@wilanis/plugin-storage/suite';
import { BUILTIN_PLUGINS, embedderFor, FileBlobStore, postLoad } from '@wilanis/runtime';
import { afterAll, describe, expect, it } from 'vitest';
import sqlite, { makeSqliteEngine } from '../src/index.js';

const KIND = '@storage-sqlite/sqlite.connection-kind.json';
const CONNECTION = '@connections/records.connection.json';

const scratch = mkdtempSync(join(tmpdir(), 'wilanis-sqlite-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('what every engine answers alike', () => {
  const made = makeSqliteEngine({ root: scratch, settings: {} });
  // a directory that is not there yet: the engine makes it, as it makes the file
  const subject = {
    engine: made.engine,
    connection: { connection: CONNECTION, kind: KIND, settings: { file: 'suite/records.sqlite' } },
  };
  afterAll(() => made.close());
  for (const one of cases) it(one.name, () => one.run(subject));
});

/** A tree that keeps its entries in a SQLite file under `.wilanis`, as RFC 0022's guide writes one. */
function treeKeeping(): string {
  const dir = join(scratch, 'tree');
  const write = (relative: string, doc: unknown) => {
    const path = join(dir, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(doc));
  };
  write('project.json', {
    $schema: '@wilanis/project.schema.json',
    description: 'a tree that keeps its entries in one SQLite file',
    name: 'kept-in-sqlite',
    plugins: [{ use: '@std' }, { use: '@storage' }, { use: '@storage-sqlite' }],
  });
  write('connections/records.connection.json', {
    $schema: '@wilanis/connection.schema.json',
    description: 'the records, kept in one file under .wilanis, created on first use',
    kind: KIND,
    settings: { file: '.wilanis/records.sqlite' },
  });
  write('features/customers/feature.json', {
    $schema: '@wilanis/feature.schema.json',
    description: 'who the registry keeps',
  });
  write('features/customers/domain/Customer.shape.json', {
    $schema: '@wilanis/shape.schema.json',
    description: 'one observed call',
    layer: 'core',
    fields: { id: { type: 'string' }, url: { type: 'string' }, vip: { type: 'boolean', required: false } },
  });
  write('features/customers/data/customers.store.json', {
    $schema: '@wilanis/store.schema.json',
    description: 'the entries, kept in a file',
    connection: CONNECTION,
    collections: { entries: { of: '@features/customers/domain/Customer.shape.json', key: 'id' } },
  });
  return dir;
}

/** The shape the tree's collection keeps, as the resolver hands it to @storage. */
const CUSTOMER = new TypeResolver(() => undefined).inline({
  fields: { id: { type: 'string' }, url: { type: 'string' }, vip: { type: 'boolean', required: false } },
});

const PLUGINS: Record<string, PluginModule> = { ...BUILTIN_PLUGINS, '@storage': storage, '@storage-sqlite': sqlite };
const dir = treeKeeping();

/**
 * The tree loaded and every `postLoad` run, as `wilanis start` does, with the engine the plugin registered and
 * the collection as @storage would hand it one: the connection's settings as the tree states them.
 */
async function loaded() {
  const tree = loadTree(dir, PLUGINS);
  const emb = embedderFor(tree);
  const down = await postLoad(tree, emb, () => {});
  const path = tree.resolve(CONNECTION);
  const conn = (emb.env.connections as Record<string, { kind: string; settings?: Record<string, unknown> }>)[path];
  const engine = engines(emb.env).for(conn.kind);
  if (!engine) throw new Error(`no engine registered for '${conn.kind}'`);
  const at: At = {
    connection: path,
    kind: conn.kind,
    settings: conn.settings ?? {},
    name: 'entries',
    shape: CUSTOMER,
    key: 'id',
    unique: [],
    refs: [],
    referenced: [],
    defaults: {},
  };
  const close = async () => {
    await down();
    if (emb.blobs instanceof FileBlobStore) emb.blobs.destroy();
  };
  return { engine, at, close };
}

describe('a tree that names this engine', () => {
  it('stands: a store may name a connection of this kind, and the checker is content', () => {
    expect(checkTree(loadTree(dir, PLUGINS)).format()).toBe('');
  });

  it('the kind says it reaches a storage engine, and that a connection of it names a file', () => {
    const kind = loadTree(dir, PLUGINS).registry.get('connection-kind', KIND);
    expect(kind?.doc.storage).toBe(true);
    expect(Object.keys(kind?.doc.settings.fields ?? {})).toEqual(['file']);
  });

  it('what one load of the tree kept, a second load reads back from the file', async () => {
    const first = await loaded();
    await first.engine.ensure([first.at]);
    await first.engine.put(first.at, { id: 'a', url: 'https://kept.example', vip: true }, { replace: true });
    await first.close();

    const second = await loaded();
    try {
      expect((await second.engine.get(second.at, 'a')).record).toEqual({
        id: 'a',
        url: 'https://kept.example',
        vip: true,
      });
      expect(await second.engine.count(second.at, undefined)).toBe(1);
    } finally {
      await second.close();
    }
  });
});
