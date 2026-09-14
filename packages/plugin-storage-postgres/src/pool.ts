/**
 * One pool per connection document, made on first use. `postLoad` opens nothing eagerly -- a tree that names
 * this plugin but never reaches a store opens no socket -- and hands back a teardown that destroys every pool
 * this plugin made, so `wilanis start` stops without a handle left open.
 *
 * The pools are kept per settings object rather than in module state, so loading a tree twice in one process
 * (a reload does exactly that) gets its own pools and the old ones are destroyed with the old tree.
 */
import type { At } from '@wilanis/plugin-storage';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

/** What the plugin was configured with, as `plugin.json` describes it. */
export interface Settings {
  statementTimeout?: number;
  keyType?: 'uuidv7' | 'identity';
}

/** The connection settings a store's connection document carries. */
interface Connection {
  url?: unknown;
  schema?: unknown;
  pool?: { max?: unknown };
}

/** Every pool one load of a tree made, by the connection each was made for. */
const pools = new Map<string, { db: Kysely<never>; schema: string }>();

/** The key a pool is kept under: the connection it was made for, in this load of this tree. */
const keyOf = (at: At) => `${at.connection}`;

/**
 * The database this collection lives in, and the schema its tables sit in. Made on first use: the first
 * operation against a connection opens the pool, and every later one finds it.
 */
export function poolFor(at: At, settings: Settings): { db: Kysely<never>; schema: string } {
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

/** Destroy every pool this plugin opened, and forget them: what `postLoad` hands back as its teardown. */
export async function closePools(): Promise<void> {
  const open = [...pools.values()];
  pools.clear();
  await Promise.all(open.map(one => one.db.destroy()));
}
