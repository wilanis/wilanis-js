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
import storage, { type At, capabilitiesOf, engines } from '@wilanis/plugin-storage';
import { cases } from '@wilanis/plugin-storage/suite';
import { BUILTIN_PLUGINS, embedderFor, FileBlobStore, postLoad } from '@wilanis/runtime';
import { afterAll, describe, expect, it } from 'vitest';
import sqlite, { makeSqliteEngine } from '../src/index.js';

const KIND = '@storage-sqlite/sqlite.connection-kind.json';
const CONNECTION = '@connections/records.connection.json';
const SHARED = '@connections/shared.connection.json';

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
    profiles: {
      shared: {
        description: 'the records kept in the shared file, which stands in for their own',
        bindings: {},
        connections: { [CONNECTION]: SHARED },
      },
    },
  });
  write('connections/shared.connection.json', {
    $schema: '@wilanis/connection.schema.json',
    description: 'a second file, which the shared profile reaches in place of the records',
    kind: KIND,
    settings: { file: '.wilanis/shared.sqlite' },
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
async function loaded(profile?: string) {
  const tree = loadTree(dir, PLUGINS);
  const emb = embedderFor(tree, profile ? { profile } : {});
  const down = await postLoad(tree, emb, () => {});
  const named = tree.resolve(CONNECTION);
  const conn = (
    emb.env.connections as Record<string, { kind: string; settings?: Record<string, unknown>; path?: string }>
  )[named];
  const path = conn.path ?? named;
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
  const put = (record: Record<string, unknown>) =>
    storage.handlers['@storage/store.port.json#put']({
      in: { store: '@features/customers/data/customers.store.json', collection: 'entries', record },
      ctx: { env: emb.env } as never,
    });
  return { engine, at, close, put, resolve: tree.resolve };
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

  it('the kind says what the engine can do: transactional DDL, unique over the three scalars, and refs', async () => {
    const tree = loadTree(dir, PLUGINS);
    const emb = embedderFor(tree);
    try {
      expect(capabilitiesOf(emb.env, tree.resolve(CONNECTION))).toEqual({
        transactionalDdl: true,
        unique: ['string', 'number', 'boolean'],
        refs: true,
      });
    } finally {
      if (emb.blobs instanceof FileBlobStore) emb.blobs.destroy();
    }
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

/**
 * A stand-in: under `shared` the profile reaches `shared.connection.json` wherever `records.connection.json` is
 * named, and @storage hands the engine the reached connection's path (#774). The engine keeps its handles, and a
 * transaction's join, by that path, so a store naming the records writes into the shared file, on the handle
 * every name reaching that file shares.
 */
describe('a connection a profile stands in for another', () => {
  it("is written in the stand-in's file, under the stand-in's path", async () => {
    const under = await loaded('shared');
    try {
      expect(under.at.connection).toBe(under.resolve(SHARED));
      await under.engine.ensure([under.at]);
      await under.put({ id: 's', url: 'https://shared.example' });
      const direct = { ...under.at, connection: under.resolve(SHARED), settings: { file: '.wilanis/shared.sqlite' } };
      expect((await under.engine.get(direct, 's')).record).toEqual({ id: 's', url: 'https://shared.example' });
    } finally {
      await under.close();
    }
    const own = await loaded();
    try {
      expect((await own.engine.get(own.at, 's')).record).toBeUndefined();
    } finally {
      await own.close();
    }
  });
});
