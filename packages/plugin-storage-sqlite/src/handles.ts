/**
 * The handles this engine holds on its files. A connection's handle is made on first use and kept until the
 * teardown `postLoad` hands back, so a tree that never reaches a store opens no file. Every handle is opened
 * the same way, with the three pragmas the engine relies on: WAL, so a reader in another process never waits
 * on a writer; `foreign_keys`, since SQLite enforces no `refs` without it; and `busy_timeout`, so a writer
 * waits for the lock another process holds on the file rather than failing the moment it finds it held.
 *
 * A transaction holds a handle of its own (RFC 0022, settled on acceptance): a better-sqlite3 handle carries
 * one transaction at a time and a second `BEGIN` on it throws rather than waits, so `begin` opens a fresh
 * handle on the same file, takes the write lock on it with `BEGIN IMMEDIATE`, and closes it when the
 * transaction ends. A statement outside the transaction therefore never runs inside another run's.
 *
 * Within this process, a writer waits its turn on the file before it reaches SQLite (`turns.ts`): the busy
 * handler cannot wait for a lock its own process holds, since the driver is synchronous. A transaction takes
 * the turn before `BEGIN IMMEDIATE` and hands it on when it ends; the shared handle takes it per statement,
 * reads included, so a read of this process waits for a transaction of this process to end.
 *
 * A migration plan (RFC 0017) holds a handle of its own too, for the same reason and one more: a table rebuild
 * needs `foreign_keys` off, and a pragma set on the shared handle would hold for every statement on it.
 */
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { On } from '@wilanis/plugin-storage';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect, sql } from 'kysely';
import { busyTimeoutOf, type Settings } from './settings.js';
import { TurnTakingDialect, turnOn } from './turns.js';

/**
 * The file a connection names, resolved against the tree's root so a tree copied elsewhere carries its file.
 * `:memory:` is refused rather than opened: a transaction's handle on it would be a second, empty database,
 * and a database that forgets is the memory kind's.
 */
export function fileOf(on: On, root: string): string {
  const file = (on.settings as { file?: unknown }).file;
  if (typeof file !== 'string' || !file.trim())
    throw new Error(`connection '${on.connection}': no file; the kind requires one, relative to the tree's root`);
  if (file === ':memory:' || file.startsWith('file:'))
    throw new Error(
      `connection '${on.connection}': '${file}' is not a file; a transaction opens a second handle, and on ` +
        'an in-memory database that is a second, empty database -- name a path, or use @storage-memory',
    );
  return isAbsolute(file) ? file : resolve(root, file);
}

/** A database on the file, the file and its directory made where absent, with the pragmas every handle carries. */
export function openDatabase(file: string, busyTimeoutMs: number): Database.Database {
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file, { timeout: busyTimeoutMs });
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma(`busy_timeout = ${busyTimeoutMs}`);
  return db;
}

/**
 * Run some statements on a connection's own handle as one short transaction holding the write lock, and
 * answer what they answered: committed when they all ran, rolled back when one threw. The handle is held for
 * the whole of it, so no other statement of this process lands between the `BEGIN` and the `COMMIT`.
 */
export function locked<T>(db: Kysely<never>, work: (held: Kysely<never>) => Promise<T>): Promise<T> {
  return db.connection().execute(async held => {
    await sql`begin immediate`.execute(held);
    try {
      const answer = await work(held as Kysely<never>);
      await sql`commit`.execute(held);
      return answer;
    } catch (error) {
      await sql`rollback`.execute(held);
      throw error;
    }
  });
}

/** Throw where a row of the file names a record its reference's table does not hold, saying where. */
async function referencesHold(db: Kysely<never>): Promise<void> {
  const broken = (await sql<{ table: string; parent: string }>`pragma foreign_key_check`.execute(db)).rows;
  if (!broken.length) return;
  const where = [...new Set(broken.map(one => `${one.table} -> ${one.parent}`))].join(', ');
  throw new Error(`${broken.length} row(s) name a record their reference does not hold (${where})`);
}

/**
 * The work, then the check that every reference holds, then `COMMIT`; `ROLLBACK` where any of them throws, and
 * the first error thrown is the one answered.
 */
async function committed<T>(db: Kysely<never>, work: (db: Kysely<never>) => Promise<T>): Promise<T> {
  try {
    const answer = await work(db);
    await referencesHold(db);
    await sql`commit`.execute(db);
    return answer;
  } catch (error) {
    await sql`rollback`.execute(db).catch(() => undefined);
    throw error;
  }
}

/** Kysely over a transaction's handle, which holds the file's turn already. Destroying it closes the handle. */
const kyselyOf = (db: Database.Database) => new Kysely<never>({ dialect: new SqliteDialect({ database: db }) });

/** Kysely over a connection's shared handle, every statement taking the file's turn. Destroying it closes the handle. */
const sharedOf = (db: Database.Database, file: string, waitMs: number) =>
  new Kysely<never>({ dialect: new TurnTakingDialect({ database: db }, file, waitMs) });

/** Every handle one load of a tree made, by the connection it was made for. */
export class Handles {
  private readonly open = new Map<string, Kysely<never>>();
  /**
   * The handles transactions hold, each with the function that hands on its turn on the file, until each ends
   * -- or until teardown, which rolls back whichever has not.
   */
  private readonly held = new Map<Kysely<never>, () => void>();

  /** `root` is the tree's directory, which a relative `file` is read against. */
  constructor(
    private readonly root: string,
    private readonly settings: Settings,
  ) {}

  /** The handle for statements outside a transaction on this connection, opened on first use. */
  for(on: On): Kysely<never> {
    const made = this.open.get(on.connection);
    if (made) return made;
    const file = fileOf(on, this.root);
    const waitMs = busyTimeoutOf(this.settings);
    const db = sharedOf(openDatabase(file, waitMs), file, waitMs);
    this.open.set(on.connection, db);
    return db;
  }

  /**
   * A handle of its own on the connection's file, holding the write lock. It waits first for this process's
   * turn on the file, then `BEGIN IMMEDIATE` waits for a lock another process holds; each wait lasts up to
   * `busyTimeoutMs` and fails the node past it. The caller ends it through `end`.
   */
  async transaction(on: On): Promise<Kysely<never>> {
    const file = fileOf(on, this.root);
    const waitMs = busyTimeoutOf(this.settings);
    const handOn = await turnOn(file, waitMs);
    let db: Kysely<never> | undefined;
    try {
      db = kyselyOf(openDatabase(file, waitMs));
      await sql`begin immediate`.execute(db);
      this.held.set(db, handOn);
      return db;
    } catch (error) {
      try {
        await db?.destroy();
      } finally {
        handOn();
      }
      throw error;
    }
  }

  /**
   * Run a migration plan on a handle of its own, as one transaction holding the write lock, and answer what the
   * work answered. Foreign keys are off on that handle for its whole life: the table rebuild a plan may hold
   * drops a table others reference, and SQLite reads the pragma only outside a transaction. Before the commit,
   * `foreign_key_check` holds the file to every reference it declares, so turning them off loses no guarantee.
   * The handle waits its turn on the file as a transaction does, and the shared handle never sees the pragma.
   */
  async migrating<T>(on: On, work: (db: Kysely<never>) => Promise<T>): Promise<T> {
    const file = fileOf(on, this.root);
    const waitMs = busyTimeoutOf(this.settings);
    const handOn = await turnOn(file, waitMs);
    let db: Kysely<never> | undefined;
    try {
      db = kyselyOf(openDatabase(file, waitMs));
      await sql`pragma foreign_keys = off`.execute(db);
      await sql`begin immediate`.execute(db);
      return await committed(db, work);
    } finally {
      await (db?.destroy() ?? Promise.resolve()).finally(handOn);
    }
  }

  /**
   * End a transaction's handle with `commit` or `rollback`, close it, and hand on its turn on the file, whether
   * the word went through or not. A handle already ended, or closed by teardown, is left alone, so a second
   * ending is no ending.
   */
  async end(db: Kysely<never>, word: 'commit' | 'rollback'): Promise<void> {
    const handOn = this.held.get(db);
    if (!handOn) return;
    this.held.delete(db);
    try {
      await sql.raw(word).execute(db);
    } finally {
      await db.destroy().finally(handOn);
    }
  }

  /**
   * Close every handle this load opened, and forget them: what `postLoad` hands back. A transaction still open
   * at teardown is rolled back first, so a stopped tree neither commits half a run nor leaves the file held.
   */
  async close(): Promise<void> {
    const open = [...this.open.values()];
    this.open.clear();
    const held = [...this.held.keys()];
    await Promise.all(held.map(db => this.end(db, 'rollback').catch(() => undefined)));
    await Promise.all(open.map(db => db.destroy()));
  }
}
