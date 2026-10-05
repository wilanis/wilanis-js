/**
 * A declared `unique` is held by the index that covers its columns, never by an index whose name happens to
 * spell the same. Joining field names with `_` would name `["a_b"]` and `["a", "b"]` alike, and index names
 * are the file's, so two collections could collide too; a declaration taken for held by its name would then
 * go unenforced, silently. Each case here would have lost one of its constraints that way.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Type, TypeResolver } from '@wilanis/core';
import type { At } from '@wilanis/plugin-storage';
import { afterAll, describe, expect, it } from 'vitest';
import { makeSqliteEngine } from '../src/index.js';

const scratch = mkdtempSync(join(tmpdir(), 'wilanis-sqlite-uniques-'));
const made = makeSqliteEngine({ root: scratch, settings: {} });
afterAll(async () => {
  await made.close();
  rmSync(scratch, { recursive: true, force: true });
});

const types = new TypeResolver(() => undefined);
const shapeOf = (fields: string[]): Type =>
  types.inline({ fields: Object.fromEntries(['id', ...fields].map(name => [name, { type: 'string' }])) });

/** A collection of string fields on the one file, with the uniques it declares. */
const collection = (name: string, fields: string[], unique: string[][]): At => ({
  connection: '@connections/uniques.connection.json',
  kind: '@storage-sqlite/sqlite.connection-kind.json',
  settings: { file: 'uniques.sqlite' },
  name,
  shape: shapeOf(fields),
  key: 'id',
  unique,
  refs: [],
  referenced: [],
  defaults: {},
});

describe('two uniques whose fields would join to one name', () => {
  const at = collection('joined', ['a_b', 'a', 'b'], [['a_b'], ['a', 'b']]);

  it('are two indexes, and a second ensure makes neither again', async () => {
    expect((await made.engine.ensure([at])).constraints).toBe(2);
    expect((await made.engine.ensure([at])).constraints).toBe(0);
  });

  it('each refuses a duplicate of its own', async () => {
    await made.engine.put(at, { id: '1', a_b: 'x', a: 'p', b: 'q' }, { replace: true });
    const sameJoined = await made.engine.put(at, { id: '2', a_b: 'x', a: 'r', b: 's' }, { replace: true });
    expect(sameJoined.violated).toBe('unique [a_b]');
    const samePair = await made.engine.put(at, { id: '3', a_b: 'y', a: 'p', b: 'q' }, { replace: true });
    expect(samePair.violated).toBe('unique [a, b]');
    expect(await made.engine.count(at, undefined)).toBe(1);
  });
});

describe('two collections whose name and fields would join to one name', () => {
  const first = collection('a_b', ['c'], [['c']]);
  const second = collection('a', ['b_c'], [['b_c']]);

  it('each holds its own unique', async () => {
    expect((await made.engine.ensure([first, second])).constraints).toBe(2);
    await made.engine.put(first, { id: '1', c: 'x' }, { replace: true });
    await made.engine.put(second, { id: '1', b_c: 'x' }, { replace: true });
    expect((await made.engine.put(first, { id: '2', c: 'x' }, { replace: true })).violated).toBe('unique [c]');
    expect((await made.engine.put(second, { id: '2', b_c: 'x' }, { replace: true })).violated).toBe('unique [b_c]');
  });
});
