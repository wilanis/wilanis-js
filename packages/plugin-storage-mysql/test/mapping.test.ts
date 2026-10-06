/**
 * What this engine does below the interface the shared suite judges: how wide a string an index holds may be,
 * what a table is created as, what a `put` without `replace` refuses -- a broken `unique`, and a string wider
 * than its column, which `INSERT IGNORE` would have cut and stored -- how `identity` reserves from `wilanis_keys`, and what every session of a pool is set up with.
 *
 * The widths are arithmetic and run everywhere. The rest needs a database and is skipped without
 * `WILANIS_TEST_MYSQL_URL` (`engine.test.ts` says how to run one).
 */
import type { Type } from '@wilanis/core';
import type { At } from '@wilanis/plugin-storage';
import { SHAPE } from '@wilanis/plugin-storage/suite';
import { sql } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import { declaredOf, widthsOf } from '../src/columns.js';
import { makeMysqlEngine, Pools } from '../src/index.js';

const url = process.env.WILANIS_TEST_MYSQL_URL;
const ON = { connection: '@connections/mapping.connection.json', kind: '@storage-mysql/mysql.connection-kind.json' };

/** A collection of the suite's shape, keyed by `id`, declaring whatever the case declares. */
const at = (name: string, declared: Partial<At> = {}): At => ({
  ...ON,
  settings: { url },
  name,
  shape: SHAPE,
  key: 'id',
  unique: [],
  refs: [],
  referenced: [],
  defaults: {},
  ...declared,
});

describe('how wide a string an index holds may be', () => {
  it('alone in an index it is 768 characters, the 3072 bytes InnoDB holds at four a character', () => {
    expect(widthsOf(at('w'))).toEqual(new Map([['id', 768]]));
    expect(widthsOf(at('w', { refs: [{ from: 'w', field: 'ua', to: 'other' }] })).get('ua')).toBe(768);
  });

  it('strings sharing an index share the bytes, with the 8 a number takes and the 1 a boolean takes', () => {
    expect(widthsOf(at('w', { unique: [['url', 'method']] })).get('url')).toBe(384);
    expect(widthsOf(at('w', { unique: [['url', 'hits']] })).get('url')).toBe(766);
    expect(widthsOf(at('w', { unique: [['url', 'ok']] })).get('url')).toBe(767);
    // the key in a unique with another string is held to the narrower of its two indexes
    expect(widthsOf(at('w', { unique: [['id', 'url']] })).get('id')).toBe(384);
  });

  it('a string no index holds is TEXT, a shape is JSON with no CHECK, a boolean is held to 0 or 1', () => {
    expect(widthsOf(at('w')).has('url')).toBe(false);
    expect(declaredOf({ name: 'url', type: { kind: 'string' }, required: true })).toEqual({
      column: 'TEXT COLLATE utf8mb4_bin',
    });
    expect(declaredOf({ name: 'meta', type: { kind: 'unknown' }, required: false })).toEqual({ column: 'JSON' });
    expect(declaredOf({ name: 'ok', type: { kind: 'boolean' }, required: true }).check).toBe('`ok` IN (0, 1)');
  });
});

describe.skipIf(!url)('what the database is asked to hold', () => {
  const made = makeMysqlEngine({ settings: {} });
  afterAll(() => made.close());

  it('a table is InnoDB and utf8mb4_bin, its constrained strings VARCHAR and the rest TEXT', async () => {
    const where = at('mapped_table', { unique: [['url', 'method']] });
    await made.engine.ensure([where]);
    const db = new Pools({}).for(where);
    try {
      const table = await sql<{ engine: string; collation: string }>`
        select ENGINE as engine, TABLE_COLLATION as collation from information_schema.TABLES
        where TABLE_SCHEMA = database() and TABLE_NAME = 'mapped_table'`.execute(db);
      expect(table.rows).toEqual([{ engine: 'InnoDB', collation: 'utf8mb4_bin' }]);
      const columns = await sql<{ name: string; type: string; collation: string | null }>`
        select COLUMN_NAME as name, COLUMN_TYPE as type, COLLATION_NAME as collation from information_schema.COLUMNS
        where TABLE_SCHEMA = database() and TABLE_NAME = 'mapped_table' order by ORDINAL_POSITION`.execute(db);
      expect(columns.rows.map(one => [one.name, one.type, one.collation])).toEqual([
        ['id', 'varchar(768)', 'utf8mb4_bin'],
        ['url', 'varchar(384)', 'utf8mb4_bin'],
        ['method', 'varchar(384)', 'utf8mb4_bin'],
        ['hits', 'double', null],
        ['ok', 'tinyint(1)', null],
        ['ua', 'text', 'utf8mb4_bin'],
      ]);
    } finally {
      await db.destroy();
    }
  });

  it('a put without replace that repeats a unique answers violated, not conflict, and writes nothing', async () => {
    const where = at('mapped_ignore', { unique: [['url']] });
    await made.engine.ensure([where]);
    const first = { id: 'a', url: 'https://one.example', method: 'GET', hits: 1, ok: true };
    await made.engine.put(where, first, { replace: true });
    const repeat = await made.engine.put(where, { ...first, id: 'b' }, { replace: false });
    expect(repeat).toEqual({ conflict: false, violated: 'unique [url]' });
    expect((await made.engine.put(where, first, { replace: false })).conflict).toBe(true);
    expect(await made.engine.count(where, undefined)).toBe(1);
  });

  it('a put without replace of a string one character wider than its column fails the node and writes nothing', async () => {
    const where = at('mapped_too_long');
    await made.engine.ensure([where]);
    const before = await made.engine.count(where, undefined);
    const wide = { id: 'x'.repeat(769), url: 'https://one.example', method: 'GET', hits: 1, ok: true };
    await expect(made.engine.put(where, wide, { replace: false })).rejects.toThrow(/too long/i);
    expect(await made.engine.count(where, undefined)).toBe(before);
  });
});

/** A collection keyed by a number, which `identity` reserves keys for. */
const NUMBERED: Type = {
  kind: 'object',
  name: 'Numbered',
  open: false,
  fields: { n: { type: { kind: 'number' }, required: true }, label: { type: { kind: 'string' }, required: true } },
};

describe.skipIf(!url)('what identity reserves, and what every session is set up with', () => {
  const made = makeMysqlEngine({ settings: { keyType: 'identity', statementTimeout: 1.5 } });
  afterAll(() => made.close());

  it('newKey reserves from wilanis_keys, past any key a record was written with, in a transaction too', async () => {
    const where = { ...at('mapped_numbered'), shape: NUMBERED, key: 'n' };
    await made.engine.ensure([where]);
    const first = Number(await made.engine.newKey(where));
    expect(Number(await made.engine.newKey(where))).toBe(first + 1);
    await made.engine.put(where, { n: first + 100, label: 'its own key' }, { replace: true });
    const trx = await made.engine.begin(where);
    expect(Number(await trx.engine.newKey(where))).toBe(first + 101);
    await trx.commit();
  });

  it('a session is strict, refuses an engine other than InnoDB, and holds reads to statementTimeout', async () => {
    const db = new Pools({ statementTimeout: 1.5 }).for({ ...ON, settings: { url } });
    try {
      const { rows } = await sql<{ timeout: number; mode: string }>`
        select @@SESSION.max_execution_time as timeout, @@SESSION.sql_mode as mode`.execute(db);
      expect(Number(rows[0].timeout)).toBe(1500);
      expect(rows[0].mode.split(',')).toEqual(expect.arrayContaining(['STRICT_ALL_TABLES', 'NO_ENGINE_SUBSTITUTION']));
    } finally {
      await db.destroy();
    }
  });
});
