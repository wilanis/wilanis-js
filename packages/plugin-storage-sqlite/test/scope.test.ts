/**
 * This engine keeps a scope (RFC 0015) as the memory and postgres engines do, judged first by the same shared
 * cases: a row belongs to the scope it was written under, no key crosses one, a key is still global, a
 * `unique` holds within a scope, and a read with no scope -- a view -- sees every row. They need nothing but a
 * temporary directory, so unlike the postgres run they run in every CI job, unconditionally.
 *
 * Then what a scope costs the file, which no shared case can see: the column, `NOT NULL` and typed by the
 * value; the uniques made again with the scope in front; the index over the scope and the key that tells a
 * later `ensure` which columns are the scope; `drift` on a table with rows; and first scoped writes at once,
 * outside a transaction and inside one, all landing with the column added once.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { At, Record_ } from '@wilanis/plugin-storage';
import { SHAPE, scopeCases } from '@wilanis/plugin-storage/suite';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { makeSqliteEngine } from '../src/index.js';

const KIND = '@storage-sqlite/sqlite.connection-kind.json';
const CONNECTION = '@connections/records.connection.json';

const scratch = mkdtempSync(join(tmpdir(), 'wilanis-sqlite-scope-'));
const made = makeSqliteEngine({ root: scratch, settings: {} });
const { engine } = made;
afterAll(async () => {
  await made.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe('what an engine that keeps scopes answers', () => {
  const subject = { engine, connection: { connection: CONNECTION, kind: KIND, settings: { file: 'suite.sqlite' } } };
  for (const one of scopeCases) it(one.name, () => one.run(subject));
});

// a connection of its own: a handle is kept per connection, so sharing the suite's would reach the suite's file
const COSTS = '@connections/costs.connection.json';
const FILE = 'costs.sqlite';

/** A collection of the suite's shape on the file these cases inspect, with the uniques it declares. */
const at = (name: string, unique: string[][] = []): At => ({
  connection: COSTS,
  kind: KIND,
  settings: { file: FILE },
  name,
  shape: SHAPE,
  key: 'id',
  unique,
  refs: [],
  referenced: [],
  defaults: {},
});

/** One record of the suite's shape, its url given so a case can make two collide under a unique. */
const one = (id: string, url = `https://one.example/${id}`): Record_ => ({ id, url, method: 'GET', hits: 1, ok: true });

/** What the file says about a table: its columns, and its indexes with the columns each covers. */
function catalogOf(table: string) {
  const db = new Database(join(scratch, FILE), { readonly: true });
  try {
    const columns = db.prepare('select name, type, "notnull" from pragma_table_info(?)').all(table) as {
      name: string;
      type: string;
      notnull: number;
    }[];
    const listed = db.prepare('select name, "unique" from pragma_index_list(?)').all(table) as {
      name: string;
      unique: number;
    }[];
    const cover = (index: string) =>
      (db.prepare('select name from pragma_index_info(?) order by seqno').all(index) as { name: string }[]).map(
        column => column.name,
      );
    const indexes = listed
      .filter(index => !index.name.startsWith('sqlite_autoindex'))
      .map(index => ({ unique: index.unique === 1, over: cover(index.name) }));
    return { columns, indexes };
  } finally {
    db.close();
  }
}

describe('what a scope costs the file', () => {
  it('adds the column NOT NULL, the uniques within the scope and the index over the scope and the key', async () => {
    const collection = at('c_scope', [['url', 'method']]);
    await engine.ensure([collection]);
    await engine.put(collection, one('1'), { replace: true, scope: { tenant: 'acme' } });
    const { columns, indexes } = catalogOf('c_scope');
    expect(columns.find(column => column.name === 'tenant')).toEqual({ name: 'tenant', type: 'TEXT', notnull: 1 });
    expect(indexes).toContainEqual({ unique: true, over: ['tenant', 'url', 'method'] });
    expect(indexes).toContainEqual({ unique: false, over: ['tenant', 'id'] });
    expect(indexes).not.toContainEqual({ unique: true, over: ['url', 'method'] });
  });

  it('a number scope is kept as REAL, as a number field of a shape is', async () => {
    const collection = at('c_scope_num');
    await engine.ensure([collection]);
    await engine.put(collection, one('1'), { replace: true, scope: { owner: 7 } });
    expect(catalogOf('c_scope_num').columns.find(column => column.name === 'owner')?.type).toBe('REAL');
    expect(await engine.count(collection, undefined, { owner: 7 })).toBe(1);
    expect(await engine.count(collection, undefined, { owner: 8 })).toBe(0);
  });

  it('refuses drift where the table holds rows and no scope column, and adds nothing', async () => {
    const collection = at('c_scope_rows');
    await engine.ensure([collection]);
    await engine.put(collection, one('1'), { replace: true });
    await expect(engine.put(collection, one('2'), { replace: true, scope: { tenant: 'acme' } })).rejects.toThrow(
      /drift: c_scope_rows holds 1 row\(s\) and no 'tenant' column/,
    );
    expect(catalogOf('c_scope_rows').columns.map(column => column.name)).not.toContain('tenant');
  });

  it('a later ensure over a scoped table is content: a scope column is not a column the shape lost', async () => {
    const collection = at('c_scope_again', [['url']]);
    await engine.ensure([collection]);
    await engine.put(collection, one('1'), { replace: true, scope: { tenant: 'acme' } });
    expect(await engine.ensure([collection])).toEqual({ collections: 0, columns: 0, constraints: 0 });
    // the unique is still the scoped one: a second ensure must not put the unscoped spelling back beside it
    const uniques = catalogOf('c_scope_again').indexes.filter(index => index.unique);
    expect(uniques).toEqual([{ unique: true, over: ['tenant', 'url'] }]);
  });

  it('a unique declared after the table is scoped holds within one scope, and not across them', async () => {
    const before = at('c_scope_late');
    await engine.ensure([before]);
    await engine.put(before, one('1'), { replace: true, scope: { tenant: 'acme' } });

    const after = at('c_scope_late', [['url']]);
    expect((await engine.ensure([after])).constraints).toBe(1);
    const acme = await engine.put(after, one('2', 'https://same'), { replace: true, scope: { tenant: 'acme' } });
    const beta = await engine.put(after, one('3', 'https://same'), { replace: true, scope: { tenant: 'beta' } });
    expect([acme.violated, beta.violated]).toEqual([undefined, undefined]);
    const again = await engine.put(after, one('4', 'https://same'), { replace: true, scope: { tenant: 'acme' } });
    expect(again.violated).toBe('unique [url]');
  });

  it('a collection that gains a second scope column holds its uniques within both', async () => {
    const collection = at('c_scope_wider', [['url']]);
    await engine.ensure([collection]);
    await engine.find(collection, { scope: { tenant: 'acme' } });
    await engine.find(collection, { scope: { tenant: 'acme', owner: 'ada' } });
    const uniques = catalogOf('c_scope_wider').indexes.filter(index => index.unique);
    expect(uniques).toEqual([{ unique: true, over: ['tenant', 'owner', 'url'] }]);
    const ada = { tenant: 'acme', owner: 'ada' };
    const grace = { tenant: 'acme', owner: 'grace' };
    await engine.put(collection, one('1', 'https://same'), { replace: true, scope: ada });
    const other = await engine.put(collection, one('2', 'https://same'), { replace: true, scope: grace });
    expect(other.violated).toBeUndefined();
  });

  it('first scoped writes at once all land, and the column is added once', async () => {
    const collection = at('c_scope_race', [['url']]);
    await engine.ensure([collection]);
    const written = await Promise.all(
      ['1', '2', '3', '4'].map(id => engine.put(collection, one(id), { replace: true, scope: { tenant: `t${id}` } })),
    );
    expect(written.every(answer => answer.violated === undefined && !answer.conflict)).toBe(true);
    expect(await engine.count(collection, undefined, { tenant: 't1' })).toBe(1);
    expect(await engine.count(collection, undefined, undefined)).toBe(4);
  });

  it('first scoped writes at once inside one transaction all land: they take turns on its handle', async () => {
    const collection = at('c_scope_txn', [['url']]);
    await engine.ensure([collection]);
    const trx = await engine.begin(collection);
    const written = await Promise.all(
      ['1', '2', '3'].map(id => trx.engine.put(collection, one(id), { replace: true, scope: { tenant: 'acme' } })),
    );
    await trx.commit();
    expect(written.every(answer => answer.violated === undefined)).toBe(true);
    expect(await engine.count(collection, undefined, { tenant: 'acme' })).toBe(3);
  });

  it('a scope added inside a transaction that rolls back is gone, and the next scoped write adds it again', async () => {
    const collection = at('c_scope_undone');
    await engine.ensure([collection]);
    const trx = await engine.begin(collection);
    await trx.engine.put(collection, one('1'), { replace: true, scope: { tenant: 'acme' } });
    await trx.rollback();
    expect(catalogOf('c_scope_undone').columns.map(column => column.name)).not.toContain('tenant');
    await engine.put(collection, one('2'), { replace: true, scope: { tenant: 'acme' } });
    expect(await engine.count(collection, undefined, { tenant: 'acme' })).toBe(1);
  });

  it('a second load of the tree reads the scope off the file: ensure is content and the rows stay apart', async () => {
    const collection = at('c_scope_reload', [['url']]);
    await engine.ensure([collection]);
    await engine.put(collection, one('1'), { replace: true, scope: { tenant: 'acme' } });
    const again = makeSqliteEngine({ root: scratch, settings: {} });
    try {
      expect(await again.engine.ensure([collection])).toEqual({ collections: 0, columns: 0, constraints: 0 });
      expect((await again.engine.get(collection, '1', { tenant: 'globex' })).record).toBeUndefined();
      expect((await again.engine.get(collection, '1', { tenant: 'acme' })).record?.id).toBe('1');
    } finally {
      await again.close();
    }
  });
});
