/**
 * The keys `newKey` answers under each `keyType`. Under `uuidv7` a key is made in Node and nothing is written;
 * under `identity` a number is reserved from `wilanis_keys`, which `ensure` makes beside the collections and
 * never under `uuidv7`. The shared suite already holds that two keys differ and that neither is taken; these
 * hold what the RFC adds on top of that.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TypeResolver } from '@wilanis/core';
import type { At } from '@wilanis/plugin-storage';
import { sql } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import { Handles, makeSqliteEngine } from '../src/index.js';

const scratch = mkdtempSync(join(tmpdir(), 'wilanis-sqlite-keys-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const types = new TypeResolver(() => undefined);
const keyed = (type: string) => types.inline({ fields: { id: { type }, url: { type: 'string' } } });

/** A collection keyed by a field of that type, on a file of its own. */
const atFile = (file: string, type: string): At => ({
  connection: `@connections/${file}.connection.json`,
  kind: '@storage-sqlite/sqlite.connection-kind.json',
  settings: { file: `${file}.sqlite` },
  name: 'entries',
  shape: keyed(type),
  key: 'id',
  unique: [],
  refs: [],
  referenced: [],
  defaults: {},
});

/** Whether the file a collection sits on holds wilanis_keys, read on a handle of the test's own. */
async function tableNamed(at: At): Promise<boolean> {
  const handles = new Handles(scratch, {});
  try {
    const { rows } = await sql`select name from sqlite_master where name = 'wilanis_keys'`.execute(handles.for(at));
    return rows.length > 0;
  } finally {
    await handles.close();
  }
}

describe('under uuidv7', () => {
  const made = makeSqliteEngine({ root: scratch, settings: {} });
  afterAll(() => made.close());

  it('a string key is a version 7 UUID, made in Node, and wilanis_keys is never made', async () => {
    const at = atFile('uuid', 'string');
    await made.engine.ensure([at]);
    const key = String(await made.engine.newKey(at));
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await tableNamed(at)).toBe(false);
  });

  it('a number key is not one it answers, and says so', async () => {
    await expect(made.engine.newKey(atFile('uuid-number', 'number'))).rejects.toThrow(
      /keyType 'uuidv7' answers no key/,
    );
  });
});

describe('under identity', () => {
  const made = makeSqliteEngine({ root: scratch, settings: { keyType: 'identity' } });
  afterAll(() => made.close());

  it('ensure makes wilanis_keys beside the collection', async () => {
    const at = atFile('identity', 'number');
    await made.engine.ensure([at]);
    expect(await tableNamed(at)).toBe(true);
  });

  it('keys are reserved one after another, and a key written past them moves the next one beyond it', async () => {
    const at = atFile('identity', 'number');
    expect(await made.engine.newKey(at)).toBe(1);
    expect(await made.engine.newKey(at)).toBe(2);
    await made.engine.put(at, { id: 10, url: 'https://ten' }, { replace: true });
    expect(await made.engine.newKey(at)).toBe(11);
  });

  it('a key reserved inside a transaction is reserved on its handle, and kept when it commits', async () => {
    const at = atFile('identity', 'number');
    const trx = await made.engine.begin(at);
    expect(await trx.engine.newKey(at)).toBe(12);
    await trx.commit();
    expect(await made.engine.newKey(at)).toBe(13);
  });

  it("the number key is the table's own integer key, so a fraction is refused by the file", async () => {
    const at = atFile('identity', 'number');
    await expect(made.engine.put(at, { id: 1.5, url: 'https://half' }, { replace: true })).rejects.toThrow(
      /datatype mismatch/,
    );
  });
});
