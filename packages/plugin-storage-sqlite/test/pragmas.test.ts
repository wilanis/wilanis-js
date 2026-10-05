/**
 * The places SQLite's defaults disagree with what a store means, and the engine sets them right (RFC 0022):
 * `LIKE` folds ASCII case, so `contains` and `startsWith` are compiled to functions that do not; a handle
 * enforces no `refs` and waits for no lock unless told, so every handle the engine opens is told -- the one a
 * transaction opens as much as the one outside it. And `busyTimeoutMs` is honoured: a second writer waits for
 * the file's lock that long, then fails with SQLite's own message.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Type } from '@wilanis/core';
import { type At, parseWhere } from '@wilanis/plugin-storage';
import { SHAPE } from '@wilanis/plugin-storage/suite';
import Database from 'better-sqlite3';
import { type Kysely, sql } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import { BUSY_TIMEOUT_MS, Handles, makeSqliteEngine } from '../src/index.js';
import { busyTimeoutOf } from '../src/settings.js';

const KIND = '@storage-sqlite/sqlite.connection-kind.json';
const scratch = mkdtempSync(join(tmpdir(), 'wilanis-sqlite-pragmas-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A collection of the suite's shape on a file of its own under the scratch directory. */
const atFile = (file: string, name = 'entries', shape: Type = SHAPE): At => ({
  connection: `@connections/${file}.connection.json`,
  kind: KIND,
  settings: { file: `${file}.sqlite` },
  name,
  shape,
  key: 'id',
  unique: [],
  refs: [],
  referenced: [],
  defaults: {},
});

const entry = (id: string, url: string, method: string) => ({ id, url, method, hits: 1, ok: true });

/** What one pragma reads on a handle. */
async function pragma(db: Kysely<never>, name: string): Promise<unknown> {
  const rows = (await sql.raw(`pragma ${name}`).execute(db)).rows as Record<string, unknown>[];
  return Object.values(rows[0] ?? {})[0];
}

describe('contains and startsWith match text as it is spelled', () => {
  const made = makeSqliteEngine({ root: scratch, settings: {} });
  afterAll(() => made.close());
  const at = atFile('case');
  const found = async (filter: unknown) =>
    (await made.engine.find(at, { where: parseWhere(filter, SHAPE) })).map(one => one.id).sort();

  it('contains is case-sensitive, as the memory engine is, where LIKE would fold', async () => {
    await made.engine.ensure([at]);
    await made.engine.put(at, entry('upper', 'https://x.example/GET', 'GET'), { replace: true });
    await made.engine.put(at, entry('lower', 'https://x.example/get', 'get'), { replace: true });
    expect(await found({ url: { contains: 'get' } })).toEqual(['lower']);
    expect(await found({ url: { contains: 'GET' } })).toEqual(['upper']);
  });

  it('startsWith is case-sensitive, and reads no pattern in the value', async () => {
    expect(await found({ method: { startsWith: 'G' } })).toEqual(['upper']);
    expect(await found({ method: { startsWith: 'g' } })).toEqual(['lower']);
    expect(await found({ url: { startsWith: 'HTTPS' } })).toEqual([]);
    expect(await found({ url: { startsWith: 'https://x.example/_et' } })).toEqual([]);
    expect(await found({ url: { contains: '%' } })).toEqual([]);
  });
});

describe('every handle the engine opens carries the pragmas', () => {
  const handles = new Handles(scratch, { busyTimeoutMs: 1234 });
  afterAll(() => handles.close());

  it('the handle outside a transaction: WAL, foreign keys on, and the configured busy timeout', async () => {
    const db = handles.for(atFile('pragmas'));
    expect(await pragma(db, 'journal_mode')).toBe('wal');
    expect(await pragma(db, 'foreign_keys')).toBe(1);
    expect(await pragma(db, 'busy_timeout')).toBe(1234);
  });

  it("a transaction's own handle carries the same three", async () => {
    const trx = await handles.transaction(atFile('pragmas'));
    try {
      expect(await pragma(trx, 'journal_mode')).toBe('wal');
      expect(await pragma(trx, 'foreign_keys')).toBe(1);
      expect(await pragma(trx, 'busy_timeout')).toBe(1234);
    } finally {
      await sql`rollback`.execute(trx);
      await trx.destroy();
    }
  });

  it('the file and the directory it sits in are made where absent', () => {
    handles.for(atFile('deep/er/file'));
    expect(existsSync(join(scratch, 'deep/er/file.sqlite'))).toBe(true);
  });

  it(':memory: is refused, since a transaction would open a second, empty database', () => {
    const memory = { ...atFile('memory'), settings: { file: ':memory:' } };
    expect(() => handles.for(memory)).toThrow(/':memory:' is not a file/);
  });

  it('the default busy timeout is 5000 milliseconds', () => {
    expect(BUSY_TIMEOUT_MS).toBe(5000);
    expect(busyTimeoutOf({})).toBe(5000);
  });
});

describe('busyTimeoutMs is honoured', () => {
  const made = makeSqliteEngine({ root: scratch, settings: { busyTimeoutMs: 300 } });
  afterAll(() => made.close());
  const at = atFile('busy');

  /** Hold the file's write lock from a handle of another writer for the length of `work`. */
  async function whileLocked(work: () => Promise<void>): Promise<void> {
    const other = new Database(join(scratch, 'busy.sqlite'));
    other.pragma('journal_mode = WAL');
    other.exec('begin immediate');
    try {
      await work();
    } finally {
      other.exec('rollback');
      other.close();
    }
  }

  it('a write waits for the lock another writer holds, then fails with the lock message', async () => {
    await made.engine.ensure([at]);
    await whileLocked(async () => {
      const started = Date.now();
      await expect(made.engine.put(at, entry('a', 'https://x', 'GET'), { replace: true })).rejects.toThrow(
        /database is locked/,
      );
      expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    });
  });

  it('a transaction waits for it too, at BEGIN IMMEDIATE rather than at commit', async () => {
    await whileLocked(async () => {
      const started = Date.now();
      await expect(made.engine.begin(at)).rejects.toThrow(/database is locked/);
      expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    });
  });

  it('once the lock is let go, the same write goes through', async () => {
    const answer = await made.engine.put(at, entry('a', 'https://x', 'GET'), { replace: true });
    expect(answer.conflict).toBe(false);
    expect((await made.engine.get(at, 'a')).record?.url).toBe('https://x');
  });
});

describe('teardown', () => {
  it('rolls back a transaction still open and lets go of the file, so another writer goes through at once', async () => {
    const made = makeSqliteEngine({ root: scratch, settings: { busyTimeoutMs: 100 } });
    const at = atFile('teardown');
    await made.engine.ensure([at]);
    const trx = await made.engine.begin(at);
    await trx.engine.put(at, entry('left', 'https://left', 'GET'), { replace: true });
    await made.close();

    const after = makeSqliteEngine({ root: scratch, settings: { busyTimeoutMs: 100 } });
    try {
      const next = await after.engine.put(at, entry('next', 'https://next', 'GET'), { replace: true });
      expect(next.conflict).toBe(false);
      expect((await after.engine.get(at, 'left')).record).toBeUndefined();
      await trx.rollback(); // ended already, by teardown: a second ending is no ending
    } finally {
      await after.close();
    }
  });
});
