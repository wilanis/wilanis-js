/**
 * How a refused unique is named (#821). SQLite says which columns the index it refused is over, and a scoped
 * table holds each declared `unique` with the scope columns in front; the message is read in one place, against
 * the declaration in both spellings, so the answer is the `unique` the store declared whatever the engine put
 * beside it, and the key where no declaration is named.
 */
import { type Type, TypeResolver } from '@wilanis/core';
import type { At } from '@wilanis/plugin-storage';
import { describe, expect, it } from 'vitest';
import { writeViolation } from '../src/violations.js';

const types = new TypeResolver(() => undefined);
const shape: Type = types.inline({
  fields: Object.fromEntries(['id', 'url', 'method', 'name'].map(name => [name, { type: 'string' }])),
});

/** The entries collection: a unique over two fields and one over a third, keyed by id. */
const entries: At = {
  connection: '@connections/records.connection.json',
  kind: '@storage-sqlite/sqlite.connection-kind.json',
  settings: {},
  name: 'entries',
  shape,
  key: 'id',
  unique: [['url', 'method'], ['name']],
  refs: [],
  referenced: [],
  defaults: {},
};

/** The error better-sqlite3 throws for an index refusing, naming its columns as `<table>.<column>`. */
const refused = (...columns: string[]) => ({
  code: 'SQLITE_CONSTRAINT_UNIQUE',
  message: `UNIQUE constraint failed: ${columns.map(one => `entries.${one}`).join(', ')}`,
});

// a unique never asks the handle, so none is opened
const db = {} as never;

describe('a refused unique is named as the store declares it', () => {
  it('bare, on a table that keeps no scope', async () => {
    expect(await writeViolation(refused('url', 'method'), db, entries, { record: {} })).toBe('unique [url, method]');
    expect(await writeViolation(refused('name'), db, entries, { record: {} })).toBe('unique [name]');
  });

  it('with the scope columns in front, under the scope the write ran under', async () => {
    const scope = { tenant: 'acme' };
    const error = refused('tenant', 'url', 'method');
    expect(await writeViolation(error, db, entries, { record: {}, scope })).toBe('unique [url, method]');
    expect(await writeViolation(refused('tenant', 'name'), db, entries, { record: {}, scope })).toBe('unique [name]');
  });

  it('under two scope columns, in whatever order the index spells them', async () => {
    const scope = { tenant: 'acme', owner: 'ada' };
    const error = refused('owner', 'tenant', 'method', 'url');
    expect(await writeViolation(error, db, entries, { record: {}, scope })).toBe('unique [url, method]');
  });

  it('as the key where the columns name no declaration: the key itself, or a scoped index read without its scope', async () => {
    const key = { code: 'SQLITE_CONSTRAINT_PRIMARYKEY', message: 'UNIQUE constraint failed: entries.id' };
    expect(await writeViolation(key, db, entries, { record: {} })).toBe('unique [id]');
    expect(await writeViolation(refused('tenant', 'url', 'method'), db, entries, { record: {} })).toBe('unique [id]');
  });

  it('nothing where the error is no constraint at all', async () => {
    const other = { code: 'SQLITE_BUSY', message: 'database is locked' };
    expect(await writeViolation(other, db, entries, { record: {} })).toBeUndefined();
  });
});
