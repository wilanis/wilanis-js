/**
 * The schema a connection names, made where the database has none (#847). A connection's `schema` setting says
 * where its tables sit, and the first statement that writes there -- the record `migrate` keeps, or a table
 * `ensure` creates -- finds it made, so a fresh database needs no `create schema` by hand before the first run.
 *
 * The catalog is asked before anything is created, since `create schema if not exists` asks for CREATE on the
 * database even where the schema is there. A role an operator gave a schema of its own and nothing more must
 * keep working, and the last case pins that.
 *
 * Skipped without `WILANIS_TEST_POSTGRES_URL`; see `engine.test.ts` for the container to run it against.
 */
import { randomUUID } from 'node:crypto';
import { TypeResolver } from '@wilanis/core';
import type { At, On } from '@wilanis/plugin-storage';
import { sql } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import { closePools, poolFor } from '../src/pool.js';
import { by, ENTRIES, engine, planFor, url } from './migrating.js';

const KIND = '@storage-postgres/postgres.connection-kind.json';
const types = new TypeResolver(() => undefined);

/** A connection of its own, in a schema no other case names, reached with `reach` (the test's URL by default). */
function fresh(reach = url): On & { schema: string } {
  const schema = `s847_${randomUUID().slice(0, 8)}`;
  return { connection: `@connections/${schema}.connection.json`, kind: KIND, settings: { url: reach, schema }, schema };
}

/** One collection on that connection, as `ensure` is handed it. */
const collectionOn = (on: On): At => ({
  ...on,
  name: 'e_items',
  shape: types.inline({ fields: { id: { type: 'string' }, url: { type: 'string' } } }),
  key: 'id',
  unique: [],
  refs: [],
  referenced: [],
  defaults: {},
});

/** The database as its owner reaches it, for what a case sets up and asks the catalog. */
const admin = () =>
  poolFor({ connection: '@connections/s847-admin.connection.json', kind: KIND, settings: { url } }, {}).db;

/** Whether the database holds a schema of this name. */
async function holds(schema: string): Promise<boolean> {
  const found = await sql`select 1 from pg_namespace where nspname = ${schema}`.execute(admin());
  return (found as { rows: unknown[] }).rows.length === 1;
}

/** Drop what a case made, whether or not it made it. */
const drop = (schema: string) => sql`drop schema if exists ${sql.ref(schema)} cascade`.execute(admin());

afterAll(async () => {
  if (url) await closePools();
});

describe.skipIf(!url)('the schema a connection names', () => {
  it('migrate makes it where the database has none, and keeps the record and the table there', async () => {
    const on = fresh();
    try {
      expect(await holds(on.schema)).toBe(false);
      await engine.apply(on, planFor({ m_entries: ENTRIES }), { m_entries: ENTRIES }, by);
      expect(await holds(on.schema)).toBe(true);
      expect(await engine.recorded(on, 'm_entries')).toEqual(ENTRIES);
      expect((await engine.inspect(on, 'm_entries'))?.key).toBe('id');
    } finally {
      await drop(on.schema);
    }
  });

  it('ensure makes it where the database has none, before it creates a table there', async () => {
    const on = fresh();
    try {
      expect(await engine.ensure([collectionOn(on)])).toEqual({ collections: 1, columns: 2, constraints: 0 });
      expect(await holds(on.schema)).toBe(true);
    } finally {
      await drop(on.schema);
    }
  });

  it('a role that may not create a schema still runs in the one it was given', async () => {
    const role = `r847_${randomUUID().slice(0, 8)}`;
    const reach = new URL(url ?? '');
    reach.username = role;
    reach.password = 'wilanis';
    const on = fresh(reach.toString());
    await sql`create role ${sql.ref(role)} login password 'wilanis'`.execute(admin());
    await sql`create schema ${sql.ref(on.schema)} authorization ${sql.ref(role)}`.execute(admin());
    try {
      await engine.apply(on, planFor({ m_entries: ENTRIES }), { m_entries: ENTRIES }, by);
      expect(await engine.ensure([collectionOn(on)])).toEqual({ collections: 1, columns: 2, constraints: 0 });
    } finally {
      await closePools();
      await drop(on.schema);
      await sql`drop role ${sql.ref(role)}`.execute(admin());
    }
  });
});
