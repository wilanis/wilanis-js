/**
 * The handles this engine holds on its files. A connection's handle is made on first use and kept until the
 * teardown `postLoad` hands back, so a tree that never reaches a store opens no file. Every handle is opened
 * the same way, with the three pragmas the engine relies on: WAL, so a reader never waits on a writer;
 * `foreign_keys`, since SQLite enforces no `refs` without it; and `busy_timeout`, so a writer waits for the
 * file's lock rather than failing the moment another handle holds it.
 *
 * A transaction holds a handle of its own (RFC 0022, settled on acceptance): a better-sqlite3 handle carries
 * one transaction at a time and a second `BEGIN` on it throws rather than waits, so `begin` opens a fresh
 * handle on the same file, takes the write lock on it with `BEGIN IMMEDIATE`, and closes it when the
 * transaction ends. A statement outside the transaction therefore never runs inside another run's.
 */
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { On } from '@wilanis/plugin-storage';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect, sql } from 'kysely';
import { busyTimeoutOf, type Settings } from './settings.js';

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

/** Kysely over one handle. Destroying it closes the handle. */
const kyselyOf = (db: Database.Database) => new Kysely<never>({ dialect: new SqliteDialect({ database: db }) });

/** Every handle one load of a tree made, by the connection it was made for. */
export class Handles {
  private readonly open = new Map<string, Kysely<never>>();
  /** The handles transactions hold, until each ends -- or until teardown, which rolls back whichever has not. */
  private readonly held = new Set<Kysely<never>>();

  /** `root` is the tree's directory, which a relative `file` is read against. */
  constructor(
    private readonly root: string,
    private readonly settings: Settings,
  ) {}

  /** The handle for statements outside a transaction on this connection, opened on first use. */
  for(on: On): Kysely<never> {
    const made = this.open.get(on.connection);
    if (made) return made;
    const db = kyselyOf(openDatabase(fileOf(on, this.root), busyTimeoutOf(this.settings)));
    this.open.set(on.connection, db);
    return db;
  }

  /**
   * A handle of its own on the connection's file, holding the write lock: `BEGIN IMMEDIATE` waits for the lock
   * up to `busyTimeoutMs` and fails the node past it. The caller ends it through `end`.
   */
  async transaction(on: On): Promise<Kysely<never>> {
    const db = kyselyOf(openDatabase(fileOf(on, this.root), busyTimeoutOf(this.settings)));
    try {
      await sql`begin immediate`.execute(db);
      this.held.add(db);
      return db;
    } catch (error) {
      await db.destroy();
      throw error;
    }
  }

  /**
   * End a transaction's handle with `commit` or `rollback`, and close it whether the word went through or
   * not. A handle already ended, or closed by teardown, is left alone, so a second ending is no ending.
   */
  async end(db: Kysely<never>, word: 'commit' | 'rollback'): Promise<void> {
    if (!this.held.delete(db)) return;
    try {
      await sql.raw(word).execute(db);
    } finally {
      await db.destroy();
    }
  }

  /**
   * Close every handle this load opened, and forget them: what `postLoad` hands back. A transaction still open
   * at teardown is rolled back first, so a stopped tree neither commits half a run nor leaves the file held.
   */
  async close(): Promise<void> {
    const open = [...this.open.values()];
    this.open.clear();
    const held = [...this.held];
    await Promise.all(held.map(db => this.end(db, 'rollback').catch(() => undefined)));
    await Promise.all(open.map(db => db.destroy()));
  }
}
