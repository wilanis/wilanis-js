/**
 * What the planner cases share (RFC 0017): the engine they drive, a fresh file for every case, the collections
 * they declare, and the readers that let a case say what the file holds without going through the engine.
 *
 * A case gets a file of its own rather than a cleaned one: a file is cheap, and a case that starts from a file
 * nothing has touched cannot pass because of what the case before it left behind. The raw handles read the file
 * as any SQLite tool would, which is how a case proves that a failed plan left it exactly as it was.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Applying, Declared, On, Recording, Step } from '@wilanis/plugin-storage';
import { plan } from '@wilanis/plugin-storage';
import Database from 'better-sqlite3';
import { makeSqliteEngine } from '../src/index.js';

const KIND = '@storage-sqlite/sqlite.connection-kind.json';

/** Who a case says applied the plan, so the record has a row it did not have to invent. */
export const by: Applying = { by: 'rfontes@build-1', tree: 'entries' };

/** The `entries` collection: keyed by id, one url per method, and a field of each type the planner knows. */
export const ENTRIES: Declared = {
  key: 'id',
  fields: {
    id: { type: 'string', required: true },
    url: { type: 'string', required: true },
    method: { type: 'string', required: true },
    code: { type: 'string', required: false },
    hits: { type: 'number', required: false },
    vip: { type: 'boolean', required: false },
    tags: { type: 'json', required: false },
  },
  unique: [['url', 'method']],
  refs: {},
};

/** The `notes` collection: a note of an entry, so it references one. */
export const NOTES: Declared = {
  key: 'id',
  fields: { id: { type: 'string', required: true }, entryId: { type: 'string', required: false } },
  unique: [],
  refs: { entryId: { collection: 'entries', onRemove: 'refuse' } },
};

/** The steps the planner writes for collections a file has never recorded, so a case applies what a plan does. */
export const planFor = (declared: Record<string, Declared>): Step[] => plan({}, declared, {}).steps;

/** Every row of one table, every column, in key order: what a rebuild must carry whole. */
export const rowsOf = (db: Database.Database, table: string): Record<string, unknown>[] =>
  db.prepare(`select * from "${table}" order by id`).all() as Record<string, unknown>[];

/** What a file holds, read as any SQLite tool reads it: every table, index and row, in a stable order. */
export interface Snapshot {
  schema: unknown[];
  rows: Record<string, unknown[]>;
}

/**
 * The engine a test file drives and everything it needs around it. `fresh` answers a connection on a file no
 * case has touched; `raw` opens that file as any SQLite tool would; `close` lets go of every handle and file.
 */
export function planning(prefix: string) {
  const scratch = mkdtempSync(join(tmpdir(), `wilanis-sqlite-${prefix}-`));
  const made = makeSqliteEngine({ root: scratch, settings: {} });
  const opened: Database.Database[] = [];
  let files = 0;
  const fresh = (): On => {
    files += 1;
    return {
      connection: `@connections/${prefix}${files}.connection.json`,
      kind: KIND,
      settings: { file: `${prefix}${files}.sqlite` },
    };
  };
  const raw = (on: On): Database.Database => {
    const db = new Database(join(scratch, String(on.settings.file)));
    db.pragma('foreign_keys = ON');
    opened.push(db);
    return db;
  };
  const snapshot = (on: On): Snapshot => {
    const db = raw(on);
    const schema = db
      .prepare(`select type, name, sql from sqlite_master where name not like 'sqlite_%' order by name`)
      .all();
    const tables = schema.filter(one => (one as { type: string }).type === 'table') as { name: string }[];
    const rows = Object.fromEntries(
      tables.map(one => [one.name, db.prepare(`select * from "${one.name}" order by rowid`).all()]),
    );
    return { schema, rows };
  };
  return {
    engine: made.engine,
    fresh,
    raw,
    snapshot,
    apply: (on: On, steps: Step[], record: Recording) => made.engine.apply(on, steps, record, by),
    close: async () => {
      for (const db of opened) db.close();
      await made.close();
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}
