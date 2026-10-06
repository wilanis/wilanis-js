/**
 * RFC 0003 on this engine: what `ensure` makes and refuses, and the `unique` and `refs` a store declares,
 * unconditionally and with no service (RFC 0022, step 6).
 *
 * The `unique` and `refs` cases are @storage's shared ones, not restated here. `engine.test.ts` runs them on the
 * handle that made the file; this file runs them again on a handle opened after a reopen. SQLite keeps
 * `foreign_keys` on the handle and never in the file, so a handle opened without the pragma would accept a
 * dangling reference on a table declared `REFERENCES`. A second engine on the same file is that handle: the
 * first engine made every table and closed, and the second must still refuse what the declarations forbid --
 * on the handle outside a transaction and on the one a transaction opens.
 *
 * What is proved is the behaviour, not the line that sets it. The SQLite better-sqlite3 bundles is compiled
 * with `SQLITE_DEFAULT_FOREIGN_KEYS=1`, so a handle that forgot the pragma would still enforce `refs` today; a
 * handle that turned it off, or a driver built without that default, would not, and these cases fail then.
 *
 * The `ensure` cases are RFC 0003's for a relational engine, as `plugin-storage-postgres/test/ensure.test.ts`
 * holds them for postgres: additive everywhere, destructive nowhere, and here also all at once, since SQLite's
 * DDL is transactional (`transactionalDdl: true`).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Type, TypeResolver } from '@wilanis/core';
import type { At } from '@wilanis/plugin-storage';
import { cases } from '@wilanis/plugin-storage/suite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeSqliteEngine } from '../src/index.js';

const KIND = '@storage-sqlite/sqlite.connection-kind.json';
const scratch = mkdtempSync(join(tmpdir(), 'wilanis-sqlite-constraints-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/**
 * The shared cases about a declared constraint: a `unique`, a reference, and the `ensure` that makes them. They
 * are picked by name, so the count is held too: a case renamed out of the pick, or a new one the pick matches,
 * fails here; a new constraint case is picked only if its name says unique or reference.
 */
const CONSTRAINED = /unique|referenc|repeats nothing|^ensure /;
const constraintCases = cases.filter(one => CONSTRAINED.test(one.name));

describe('the unique and refs cases, on handles opened after a reopen', () => {
  const connection = {
    connection: '@connections/reopened.connection.json',
    kind: KIND,
    settings: { file: 'reopened.sqlite' },
  };
  const second = makeSqliteEngine({ root: scratch, settings: {} });
  afterAll(() => second.close());

  beforeAll(async () => {
    // the first engine makes every table, with its REFERENCES and its unique indexes, then lets go of the file
    const first = makeSqliteEngine({ root: scratch, settings: {} });
    try {
      for (const one of constraintCases) await one.run({ engine: first.engine, connection });
    } finally {
      await first.close();
    }
  });

  it('the pick holds every constraint case of the suite: nine of unique and refs, ensure, three in a transaction', () => {
    expect(constraintCases).toHaveLength(13);
  });

  for (const one of constraintCases) it(one.name, () => one.run({ engine: second.engine, connection }));
});

const types = new TypeResolver(() => undefined);
/** The shape a table is made from: one required column, one optional, one kept as JSON. */
const ENTRY: Type = types.inline({
  fields: {
    id: { type: 'string' },
    url: { type: 'string' },
    hits: { type: 'number' },
    tags: { type: 'string[]' },
    ua: { type: 'string', required: false },
  },
});
/** The two fields a table had before its shape grew. */
const BEFORE: Type = types.inline({ fields: { id: { type: 'string' }, url: { type: 'string' } } });

/** A collection on this file's database, with whatever the case declares about it. */
const at = (name: string, what: Partial<At> = {}): At => ({
  connection: '@connections/ensure.connection.json',
  kind: KIND,
  settings: { file: 'ensure.sqlite' },
  name,
  shape: ENTRY,
  key: 'id',
  unique: [],
  refs: [],
  referenced: [],
  defaults: {},
  ...what,
});

/** One row of the grown shape, for a case that only needs the table to hold one. */
const row = (id: string, url = `https://${id}`) => ({ id, url, hits: 1, tags: [] });
const NOTHING = { collections: 0, columns: 0, constraints: 0 };

describe('what ensure makes, and what it refuses to change', () => {
  const made = makeSqliteEngine({ root: scratch, settings: {} });
  const { engine } = made;
  afterAll(() => made.close());

  it('creates the tables, their columns and their constraints, and counts what it made', async () => {
    const target = at('e_target');
    const notes = at('e_new', { unique: [['url', 'hits']], refs: [{ from: 'e_new', field: 'ua', to: 'e_target' }] });
    expect(await engine.ensure([target, notes])).toEqual({ collections: 2, columns: 10, constraints: 2 });
  });

  it('a second run makes nothing, and counts nothing', async () => {
    await engine.ensure([at('e_again', { unique: [['url']] })]);
    expect(await engine.ensure([at('e_again', { unique: [['url']] })])).toEqual(NOTHING);
  });

  it('adds an optional column the shape gained to a table that is already there', async () => {
    await engine.ensure([at('e_added', { shape: BEFORE })]);
    const grown = types.inline({
      fields: { id: { type: 'string' }, url: { type: 'string' }, ua: { type: 'string', required: false } },
    });
    expect(await engine.ensure([at('e_added', { shape: grown })])).toEqual({
      collections: 0,
      columns: 1,
      constraints: 0,
    });
  });

  it('fills the rows already there with the default declared for a column it adds', async () => {
    const older = at('e_filled', { shape: BEFORE });
    await engine.ensure([older]);
    await engine.put(older, { id: '1', url: 'https://x' }, { replace: true });
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
    const before = at('e_typed', {
      shape: types.inline({ fields: { id: { type: 'string' }, hits: { type: 'string' } } }),
    });
    await engine.ensure([before]);
    await expect(engine.ensure([at('e_typed')])).rejects.toThrow(/drift: e_typed\.hits is TEXT/);
    expect(await engine.ensure([before])).toEqual(NOTHING);
  });

  it('refuses a required column added to a table with rows and no default for it', async () => {
    const older = at('e_required', { shape: BEFORE });
    await engine.ensure([older]);
    await engine.put(older, { id: '1', url: 'https://x' }, { replace: true });
    await expect(engine.ensure([at('e_required')])).rejects.toThrow(/drift: e_required\.hits is required/);
  });

  it('refuses a required column with no default on an empty table too, as SQLite does, and says so', async () => {
    await engine.ensure([at('e_required_empty', { shape: BEFORE })]);
    await expect(engine.ensure([at('e_required_empty')])).rejects.toThrow(
      /drift: e_required_empty\.hits is required, and SQLite adds a required column only with a default, even to an empty table/,
    );
  });

  it('refuses a unique the rows already there would break, and leaves the table as it was', async () => {
    const plain = at('e_unique_bad');
    await engine.ensure([plain]);
    await engine.put(plain, row('1', 'https://x'), { replace: true });
    await engine.put(plain, row('2', 'https://x'), { replace: true });
    await expect(engine.ensure([at('e_unique_bad', { unique: [['url']] })])).rejects.toThrow(
      /^drift: e_unique_bad declares unique \[url\], and rows the table already holds repeat it;/,
    );
    expect(await engine.count(plain, undefined)).toBe(2);
    expect((await engine.put(plain, row('3', 'https://x'), { replace: true })).violated).toBeUndefined();
  });

  it('on a scoped table, adds a unique the rows repeat only across scopes, and refuses one they repeat within one', async () => {
    const plain = at('e_unique_scoped');
    await engine.ensure([plain]);
    await engine.put(plain, row('1', 'https://x'), { replace: true, scope: { tenant: 'acme' } });
    await engine.put(plain, row('2', 'https://x'), { replace: true, scope: { tenant: 'beta' } });
    await engine.put(plain, row('3', 'https://y'), { replace: true, scope: { tenant: 'acme' } });
    await engine.put(plain, row('4', 'https://y'), { replace: true, scope: { tenant: 'acme' } });
    const both = at('e_unique_scoped', { unique: [['url'], ['url', 'hits']] });
    await expect(engine.ensure([both])).rejects.toThrow(
      /^drift: e_unique_scoped declares unique \[url\], and rows the table already holds repeat it within one scope;/,
    );
    expect(await engine.count(plain, undefined)).toBe(4);
    await engine.remove(plain, '4', { tenant: 'acme' });
    expect((await engine.ensure([both])).constraints).toBe(2);
  });

  it('refuses a reference over a column the table already had, which SQLite adds only by a rebuild', async () => {
    await engine.ensure([at('e_ref_target'), at('e_ref_late')]);
    const late = at('e_ref_late', { refs: [{ from: 'e_ref_late', field: 'ua', to: 'e_ref_target' }] });
    await expect(engine.ensure([late])).rejects.toThrow(/drift: e_ref_late\.ua gains a reference to e_ref_target/);
  });

  it('a drift in one collection leaves every other as it was: the whole ensure is one transaction', async () => {
    await engine.ensure([at('e_whole_typed', { shape: BEFORE })]);
    const drifting = at('e_whole_typed', {
      shape: types.inline({ fields: { id: { type: 'string' }, url: { type: 'number' } } }),
    });
    await expect(engine.ensure([at('e_whole_new'), drifting])).rejects.toThrow(/drift: e_whole_typed\.url/);
    expect((await engine.ensure([at('e_whole_new')])).collections).toBe(1);
  });
});
