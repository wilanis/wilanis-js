/**
 * What `ensure` does to a database that is not empty. The shared suite covers what every engine answers; this
 * is the half that only a relational engine has -- a table that exists, a column that does not, and the
 * differences it refuses to repair.
 *
 * The rule it is here to pin: additive everywhere, destructive nowhere. `ensure` adds what the store declares
 * and is missing, and refuses `drift` for anything it would have to destroy or change, because what to do
 * about a column that no longer matches is a decision a person makes, not one a startup step makes at three in
 * the morning. A drift is thrown rather than answered: it is not a graph's outcome, it is a startup failure.
 *
 * Skipped without `WILANIS_TEST_POSTGRES_URL`; see `engine.test.ts` for the container to run it against.
 */
import { type Type, TypeResolver } from '@wilanis/core';
import type { At } from '@wilanis/plugin-storage';
import { sql } from 'kysely';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgresEngine } from '../src/engine.js';
import { closePools, poolFor } from '../src/pool.js';
import { forgetScopes } from '../src/scoping.js';

const url = process.env.WILANIS_TEST_POSTGRES_URL;
const KIND = '@storage-postgres/postgres.connection-kind.json';
const CONNECTION = '@connections/ensure.connection.json';

const types = new TypeResolver(() => undefined);
/** The shape a table is made from: one required column, one optional, one kept as jsonb. */
const ENTRY: Type = types.inline({
  fields: {
    id: { type: 'string' },
    url: { type: 'string' },
    hits: { type: 'number' },
    tags: { type: 'string[]' },
    ua: { type: 'string', required: false },
  },
});

const engine = new PostgresEngine({});
const connection = { connection: CONNECTION, kind: KIND, settings: { url } };

/** A collection of this test's connection, with whatever the case declares about it. */
const at = (name: string, what: Partial<At> = {}): At => ({
  ...connection,
  name,
  shape: ENTRY,
  key: 'id',
  unique: [],
  refs: [],
  referenced: [],
  defaults: {},
  ...what,
});

/**
 * Drop a table between cases, so each one starts from a database that has never seen it. What the engine
 * remembers about which tables keep a scope goes with it: that memo is knowledge about tables that are there,
 * and a case that drops one has made it false.
 */
async function drop(name: string): Promise<void> {
  const { db } = poolFor(at(name), {});
  await sql`drop table if exists public.${sql.ref(name)} cascade`.execute(db);
  forgetScopes();
}

afterAll(async () => {
  if (url) await closePools();
});

describe.skipIf(!url)('what ensure makes, and what it refuses to change', () => {
  beforeEach(async () => {
    for (const name of ['e_new', 'e_again', 'e_added', 'e_filled', 'e_typed', 'e_uniq', 'e_uniq_bad']) await drop(name);
  });

  it('creates the table, its columns and its constraints, and counts what it made', async () => {
    const made = await engine.ensure([at('e_new', { unique: [['url', 'hits']] })]);
    expect(made).toEqual({ collections: 1, columns: 5, constraints: 1 });
  });

  it('a second run makes nothing, and counts nothing', async () => {
    await engine.ensure([at('e_again', { unique: [['url']] })]);
    expect(await engine.ensure([at('e_again', { unique: [['url']] })])).toEqual({
      collections: 0,
      columns: 0,
      constraints: 0,
    });
  });

  it('adds a column the shape gained to a table that is already there', async () => {
    const before: Type = types.inline({ fields: { id: { type: 'string' }, url: { type: 'string' } } });
    await engine.ensure([at('e_added', { shape: before })]);
    const made = await engine.ensure([at('e_added')]);
    expect(made).toEqual({ collections: 0, columns: 3, constraints: 0 });
  });

  it('fills the rows already there with the default declared for a column it adds', async () => {
    const before: Type = types.inline({ fields: { id: { type: 'string' }, url: { type: 'string' } } });
    const older = at('e_filled', { shape: before });
    await engine.ensure([older]);
    await engine.put(older, { id: '1', url: 'https://x' }, true);

    const now = at('e_filled', { defaults: { ua: 'unknown', hits: 0, tags: [] } });
    await engine.ensure([now]);
    expect((await engine.get(now, '1')).record).toEqual({
      id: '1',
      url: 'https://x',
      hits: 0,
      tags: [],
      ua: 'unknown',
    });
  });

  it('refuses drift where a column is of another type, and changes nothing', async () => {
    const before: Type = types.inline({ fields: { id: { type: 'string' }, hits: { type: 'string' } } });
    await engine.ensure([at('e_typed', { shape: before })]);
    await expect(engine.ensure([at('e_typed')])).rejects.toThrow(/drift: e_typed.hits is text/);
  });

  it('refuses a required column added to a table with rows and no default for it', async () => {
    const before: Type = types.inline({ fields: { id: { type: 'string' }, url: { type: 'string' } } });
    const older = at('e_uniq', { shape: before });
    await engine.ensure([older]);
    await engine.put(older, { id: '1', url: 'https://x' }, true);
    await expect(engine.ensure([at('e_uniq')])).rejects.toThrow(/drift: e_uniq.hits is required/);
  });

  it('refuses a unique the rows already there would break, and leaves the table as it was', async () => {
    const collection = at('e_uniq_bad');
    await engine.ensure([collection]);
    await engine.put(collection, { id: '1', url: 'https://x', hits: 1, tags: [] }, true);
    await engine.put(collection, { id: '2', url: 'https://x', hits: 1, tags: [] }, true);
    await expect(engine.ensure([at('e_uniq_bad', { unique: [['url']] })])).rejects.toThrow();
    expect(await engine.count(collection, undefined)).toBe(2);
  });
});

/** One row of the shape this file's tables are made from, for a case that only needs the table to hold one. */
const one = (id: string) => ({ id, url: `https://${id}`, hits: 1, tags: [] });

/** What a table's catalog says: its columns, its unique constraints and its indexes, by name. */
async function catalogOf(name: string): Promise<{ columns: Column[]; constraints: string[]; indexes: string[] }> {
  const { db } = poolFor(at(name), {});
  const columns = (await sql<Column>`
    select column_name, data_type, is_nullable from information_schema.columns
    where table_schema = 'public' and table_name = ${name} order by ordinal_position
  `.execute(db)) as { rows: Column[] };
  const held = (await sql<{ conname: string }>`
    select c.conname from pg_constraint c join pg_class t on t.oid = c.conrelid
    where t.relname = ${name} and c.contype = 'u'
  `.execute(db)) as { rows: { conname: string }[] };
  const indexes = (await sql<{ indexname: string }>`
    select indexname from pg_indexes where schemaname = 'public' and tablename = ${name}
  `.execute(db)) as { rows: { indexname: string }[] };
  return {
    columns: columns.rows,
    constraints: held.rows.map(row => row.conname),
    indexes: indexes.rows.map(row => row.indexname),
  };
}

/** Until this many sessions are waiting for a lock on the table: the moment a race has lined up behind one. */
async function waitingOn(name: string, sessions: number): Promise<void> {
  const { db } = poolFor(at(name), {});
  for (let tries = 0; tries < 200; tries += 1) {
    const waiting = (await sql<{ n: string }>`
      select count(*) as n from pg_locks l join pg_class c on c.oid = l.relation
      where c.relname = ${name} and not l.granted
    `.execute(db)) as { rows: { n: string }[] };
    if (Number(waiting.rows[0]?.n) >= sessions) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`${sessions} session(s) never came to wait on ${name}`);
}

/** One column as `information_schema.columns` reports it, which is all these cases read back. */
interface Column {
  column_name: string;
  data_type: string;
  is_nullable: string;
}

/**
 * What a scope costs a table (RFC 0015, step 7). The scope is not on the collection an engine is given: the
 * contract hands it to an operation, so the table gains its column the first time one arrives -- under the
 * same rule every other column is added by, additive on an empty table and `drift` on one with rows.
 *
 * A row written before the store declared a scope belongs to no tenant, and no declaration can say which one:
 * giving it one would be inventing the answer to exactly the question a scope exists to ask. So it is refused,
 * and RFC 0017's planner is where that migration is written.
 */
describe.skipIf(!url)('what a scope costs the table', () => {
  beforeEach(async () => {
    for (const name of [
      'e_scope',
      'e_scope_rows',
      'e_scope_again',
      'e_scope_num',
      'e_scope_late',
      'e_scope_race',
      'e_scope_txn',
    ])
      await drop(name);
  });

  it('adds the column NOT NULL, the composite unique and the index over the scope and the key', async () => {
    const collection = at('e_scope', { unique: [['url', 'hits']] });
    await engine.ensure([collection]);
    await engine.put(collection, one('1'), { replace: true, scope: { tenant: 'acme' } });

    const { columns, constraints, indexes } = await catalogOf('e_scope');
    expect(columns.find(column => column.column_name === 'tenant')).toEqual({
      column_name: 'tenant',
      data_type: 'text',
      is_nullable: 'NO',
    });
    expect(constraints).toEqual(['wl_us_e_scope_tenant_url_hits']);
    expect(indexes).toContain('wl_i_e_scope_scope');
  });

  it('a number scope is kept as double precision, as a number field of a shape is', async () => {
    const collection = at('e_scope_num');
    await engine.ensure([collection]);
    await engine.put(collection, one('1'), { replace: true, scope: { owner: 7 } });
    const { columns } = await catalogOf('e_scope_num');
    expect(columns.find(column => column.column_name === 'owner')?.data_type).toBe('double precision');
  });

  it('refuses drift where the table holds rows and no scope column, and adds nothing', async () => {
    const collection = at('e_scope_rows');
    await engine.ensure([collection]);
    await engine.put(collection, one('1'), { replace: true });
    await expect(engine.put(collection, one('2'), { replace: true, scope: { tenant: 'acme' } })).rejects.toThrow(
      /drift: e_scope_rows holds 1 row\(s\) and no 'tenant' column/,
    );
    const { columns } = await catalogOf('e_scope_rows');
    expect(columns.map(column => column.column_name)).not.toContain('tenant');
  });

  it('a later ensure over a scoped table is content: a scope column is not a column the shape lost', async () => {
    const collection = at('e_scope_again', { unique: [['url']] });
    await engine.ensure([collection]);
    await engine.put(collection, one('1'), { replace: true, scope: { tenant: 'acme' } });
    expect(await engine.ensure([collection])).toEqual({ collections: 0, columns: 0, constraints: 0 });
    // the unique is still the scoped one: a second ensure must not put the unscoped spelling back beside it
    expect((await catalogOf('e_scope_again')).constraints).toEqual(['wl_us_e_scope_again_tenant_url']);
  });

  it('a unique declared after the table is scoped holds within one tenant, and not across them', async () => {
    const before = at('e_scope_late');
    await engine.ensure([before]);
    await engine.put(before, one('1'), { replace: true, scope: { tenant: 'acme' } });

    const after = at('e_scope_late', { unique: [['url']] });
    expect((await engine.ensure([after])).constraints).toBe(1);
    expect((await catalogOf('e_scope_late')).constraints).toEqual(['wl_us_e_scope_late_tenant_url']);

    const same = { url: 'https://same', hits: 1, tags: [] };
    const acme = await engine.put(after, { id: '2', ...same }, { replace: true, scope: { tenant: 'acme' } });
    const beta = await engine.put(after, { id: '3', ...same }, { replace: true, scope: { tenant: 'beta' } });
    expect([acme.violated, beta.violated]).toEqual([undefined, undefined]);
    const again = await engine.put(after, { id: '4', ...same }, { replace: true, scope: { tenant: 'acme' } });
    expect(again.violated).toBeDefined();
  });

  it('first scoped writes racing each other all land, and the column is added once', async () => {
    const collection = at('e_scope_race', { unique: [['url']] });
    await engine.ensure([collection]);
    // a share lock held elsewhere lets every writer read the catalog, and none alter the table, until it goes
    const { db } = poolFor(collection, {});
    const holder = await db.startTransaction().execute();
    await sql`lock table public.e_scope_race in share mode`.execute(holder);
    const racing = ['1', '2', '3', '4'].map(id =>
      engine.put(collection, one(id), { replace: true, scope: { tenant: `t${id}` } }),
    );
    await waitingOn('e_scope_race', racing.length);
    await holder.rollback().execute();

    const written = await Promise.all(racing);
    expect(written.every(answer => answer.violated === undefined)).toBe(true);
    expect(await engine.count(collection, undefined, { tenant: 't1' })).toBe(1);
    expect((await catalogOf('e_scope_race')).constraints).toEqual(['wl_us_e_scope_race_tenant_url']);
  });
  it('first scoped writes at once inside one transaction all land: the lock is theirs, so they take turns here', async () => {
    // a map over rows in an atomic graph writes them together on one session, which holds the lock already
    const collection = at('e_scope_txn', { unique: [['url']] });
    await engine.ensure([collection]);
    const trx = await engine.begin?.(collection);
    if (!trx) throw new Error('the postgres engine opened no transaction');
    const written = await Promise.all(
      ['1', '2', '3'].map(id => trx.engine.put(collection, one(id), { replace: true, scope: { tenant: 'acme' } })),
    );
    await trx.commit();
    expect(written.every(answer => answer.violated === undefined)).toBe(true);
    expect(await engine.count(collection, undefined, { tenant: 'acme' })).toBe(3);
  });
});
