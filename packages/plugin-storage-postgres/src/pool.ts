/**
 * One pool per connection document, made on first use. `postLoad` opens nothing eagerly -- a tree that names
 * this plugin but never reaches a store opens no socket -- and hands back a teardown that destroys every pool
 * this plugin made, so `wilanis start` stops without a handle left open.
 *
 * The pools are kept per settings object rather than in module state, so loading a tree twice in one process
 * (a reload does exactly that) gets its own pools and the old ones are destroyed with the old tree.
 */
import type { On } from '@wilanis/plugin-storage';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { forgetScopes } from './scoping.js';

/** What the plugin was configured with, as `plugin.json` describes it. */
export interface Settings {
  statementTimeout?: number;
  keyType?: 'uuidv7' | 'identity';
  /** Seconds a queue delivery holds its message before another worker may take it. */
  queueVisibility?: number;
}

/** The connection settings a store's connection document carries. */
interface Connection {
  url?: unknown;
  schema?: unknown;
  pool?: { max?: unknown };
}

/**
 * The connections an environment carries: each one's kind, its settings with secrets substituted, and the path
 * of the connection it reaches under the profile -- a stand-in's own, where the profile puts one in. The path is
 * absent only from an environment made by hand, which names every connection as itself.
 */
type Connections = Record<string, { kind: string; settings: Record<string, unknown>; path?: string }>;

/**
 * A connection a caller names, as a pool and a transaction are kept for it: under the path it reaches, so a
 * stand-in and the connection it stands for share one pool, and a publish through one joins the transaction a
 * store call through the other opened. Nothing where the environment has no such connection.
 */
export function reachedOn(env: object, connection: string): On | undefined {
  const conn = (env as { connections?: Connections }).connections?.[connection];
  return conn && { connection: conn.path ?? connection, kind: conn.kind, settings: conn.settings };
}

/** Every pool one load of a tree made, by the connection each was made for. */
const pools = new Map<string, { db: Kysely<never>; schema: string }>();

/** The key a pool is kept under: the connection it was made for, in this load of this tree. */
const keyOf = (at: On) => `${at.connection}`;

/**
 * The database this connection reaches, and the schema its tables sit in. Made on first use: the first
 * operation against a connection opens the pool, and every later one finds it. It takes the connection alone
 * -- an `At` is one, and so is the `On` a migration names -- since a pool is per connection and knows nothing
 * of collections.
 */
export function poolFor(at: On, settings: Settings): { db: Kysely<never>; schema: string } {
  const key = keyOf(at);
  const made = pools.get(key);
  if (made) return made;
  const conn = at.settings as Connection;
  const url = typeof conn.url === 'string' ? conn.url : undefined;
  if (!url) throw new Error(`connection '${at.connection}': no url; the kind requires one, read from a secret`);
  const schema = typeof conn.schema === 'string' && conn.schema ? conn.schema : 'public';
  const max = typeof conn.pool?.max === 'number' ? conn.pool.max : 10;
  const timeout = settings.statementTimeout;
  const db = new Kysely<never>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({
        connectionString: url,
        max,
        ...(timeout === undefined ? {} : { statement_timeout: Math.round(timeout * 1000) }),
      }),
    }),
  });
  const opened = { db, schema };
  pools.set(key, opened);
  return opened;
}

/**
 * Whether a failed `create schema if not exists` lost the race to another process creating the same schema:
 * PostgreSQL checks before it takes the catalog lock, so two first contacts at once can both miss it.
 */
const lostTheRace = (error: unknown) => ['23505', '42P06'].includes(String((error as { code?: unknown }).code));

/**
 * Create the schema a connection names where the database has none, and leave it alone where it has one: what
 * runs before the first statement that writes into it, so a fresh database needs no `create schema` by hand.
 * The catalog is asked first, because `create schema if not exists` asks for CREATE on the database even where
 * the schema is there, and a role an operator gave a schema of its own and nothing more must keep working.
 */
export async function ensureSchema(db: Kysely<never>, schema: string): Promise<void> {
  const found = await sql`select 1 from pg_namespace where nspname = ${schema}`.execute(db);
  if ((found as { rows: unknown[] }).rows.length) return;
  try {
    await sql`create schema if not exists ${sql.ref(schema)}`.execute(db);
  } catch (error) {
    if (!lostTheRace(error)) throw error;
  }
}

/**
 * Destroy every pool this plugin opened, and forget them: what `postLoad` hands back as its teardown. What
 * the scope memo holds goes with them, since it is knowledge about the databases those pools reached and the
 * next load of the tree may reach others.
 */
export async function closePools(): Promise<void> {
  const open = [...pools.values()];
  pools.clear();
  forgetScopes();
  await Promise.all(open.map(one => one.db.destroy()));
}
