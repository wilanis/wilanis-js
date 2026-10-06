/**
 * The pools this engine holds, one per connection, made at the first operation and destroyed by the teardown
 * `postLoad` hands back, so a tree that never reaches a store opens no socket. They are kept per load of a tree
 * rather than in module state, so a reload gets pools of its own and the old ones go with the old tree.
 *
 * Every session a pool opens is set up the same way. It is strict, so a string longer than its column fails the
 * write instead of being cut to fit, and an engine other than InnoDB is refused instead of put in its place:
 * `refs` and transactions need InnoDB. Where the plugin's `statementTimeout` is set, the session's
 * `MAX_EXECUTION_TIME` is too, which MySQL applies to reads alone; a write has no server-side deadline.
 *
 * A transaction holds one session of the pool from `START TRANSACTION` until it ends, the way postgres's holds a
 * connection: exclusivity is the pool's, and InnoDB's isolation does the rest.
 */
import type { On } from '@wilanis/plugin-storage';
import { CompiledQuery, type DatabaseConnection, Kysely, MysqlDialect, sql } from 'kysely';
import mysql from 'mysql2';
import { type Settings, timeoutMsOf } from './settings.js';

/** The connection settings a store's connection document carries. */
interface Connection {
  url?: unknown;
  pool?: { max?: unknown };
}

/** How many sessions a pool holds open at once where the connection says nothing. */
export const POOL_MAX = 10;

/** The statements every session runs once, when the pool opens it. */
function sessionSetup(settings: Settings): (connection: DatabaseConnection) => Promise<void> {
  const timeout = timeoutMsOf(settings);
  return async connection => {
    await connection.executeQuery(
      CompiledQuery.raw(
        "SET SESSION sql_mode = CONCAT_WS(',', NULLIF(@@SESSION.sql_mode, ''), 'STRICT_ALL_TABLES', 'NO_ENGINE_SUBSTITUTION')",
      ),
    );
    if (timeout !== undefined)
      await connection.executeQuery(CompiledQuery.raw(`SET SESSION MAX_EXECUTION_TIME = ${timeout}`));
  };
}

/** Kysely over a new pool for this connection, opening nothing until the first statement. */
function poolOf(on: On, settings: Settings): Kysely<never> {
  const conn = on.settings as Connection;
  const url = typeof conn.url === 'string' && conn.url ? conn.url : undefined;
  if (!url) throw new Error(`connection '${on.connection}': no url; the kind requires one, read from a secret`);
  const max = typeof conn.pool?.max === 'number' ? conn.pool.max : POOL_MAX;
  const pool = mysql.createPool({ uri: url, connectionLimit: max, jsonStrings: true });
  return new Kysely<never>({ dialect: new MysqlDialect({ pool, onCreateConnection: sessionSetup(settings) }) });
}

/**
 * One session of the pool, held until `release` is called: Kysely lends a session for the length of a callback,
 * so the callback waits on a promise only `release` settles.
 */
function hold(db: Kysely<never>): Promise<{ on: Kysely<never>; release: () => void }> {
  return new Promise((resolve, reject) => {
    db.connection()
      .execute(on => new Promise<void>(release => resolve({ on: on as Kysely<never>, release })))
      .catch(reject);
  });
}

/**
 * Run some statements on one session as one short transaction, and answer what they answered: committed when
 * they all ran, rolled back when one threw. `patch`, `remove` and a key's reservation read and write in one.
 */
export function short<T>(db: Kysely<never>, work: (held: Kysely<never>) => Promise<T>): Promise<T> {
  return db.connection().execute(async held => {
    await sql`start transaction`.execute(held);
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

/** Every pool one load of a tree made, by the connection it was made for, and the transactions open on them. */
export class Pools {
  private readonly open = new Map<string, Kysely<never>>();
  /** The sessions transactions hold, each with the way to give it back to its pool. */
  private readonly held = new Map<Kysely<never>, () => void>();
  /** The collections whose `wilanis_keys` row this load has made, by connection and name (`keys.ts`). */
  readonly seeded = new Set<string>();

  constructor(private readonly settings: Settings) {}

  /** The pool for this connection, made on first use. */
  for(on: On): Kysely<never> {
    const made = this.open.get(on.connection);
    if (made) return made;
    const db = poolOf(on, this.settings);
    this.open.set(on.connection, db);
    return db;
  }

  /** One session of the connection's pool, inside `START TRANSACTION`. The caller ends it through `end`. */
  async transaction(on: On): Promise<Kysely<never>> {
    const { on: trx, release } = await hold(this.for(on));
    try {
      await sql`start transaction`.execute(trx);
    } catch (error) {
      release();
      throw error;
    }
    this.held.set(trx, release);
    return trx;
  }

  /**
   * End a transaction with `commit` or `rollback`, and give its session back whether the word went through or
   * not. A transaction already ended, or rolled back by teardown, is left alone.
   */
  async end(trx: Kysely<never>, word: 'commit' | 'rollback'): Promise<void> {
    const release = this.held.get(trx);
    if (!release) return;
    this.held.delete(trx);
    try {
      await sql.raw(word).execute(trx);
    } finally {
      release();
    }
  }

  /**
   * Destroy every pool this load made, and forget them: what `postLoad` hands back. A transaction still open is
   * rolled back first, so a stopped tree never commits half a run.
   */
  async close(): Promise<void> {
    const held = [...this.held.keys()];
    await Promise.all(held.map(trx => this.end(trx, 'rollback').catch(() => undefined)));
    const open = [...this.open.values()];
    this.open.clear();
    this.seeded.clear();
    await Promise.all(open.map(db => db.destroy()));
  }
}
