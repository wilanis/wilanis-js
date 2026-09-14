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

/** Drop a table between cases, so each one starts from a database that has never seen it. */
async function drop(name: string): Promise<void> {
  const { db } = poolFor(at(name), {});
  await sql`drop table if exists public.${sql.ref(name)} cascade`.execute(db);
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
