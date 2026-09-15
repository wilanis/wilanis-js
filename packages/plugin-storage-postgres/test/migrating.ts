/**
 * What the migration cases against a real database share: the connection they reach, the two collections they
 * declare, and the helpers that set a case up (RFC 0017).
 *
 * It is a module of its own rather than a preamble repeated twice because both suites drive the same engine
 * against the same tables -- `migrate.test.ts` asks what the five members answer, and `catalog.test.ts` asks
 * whether the record and the catalog say the same thing -- and a second copy of `clean()` would let the two
 * drift over which tables a case starts from.
 *
 * Skipped without `WILANIS_TEST_POSTGRES_URL`; see `engine.test.ts` for the container to run it against.
 */
import type { Applying, Declared, On, Recording, Step } from '@wilanis/plugin-storage';
import { plan } from '@wilanis/plugin-storage';
import { sql } from 'kysely';
import { PostgresEngine } from '../src/engine.js';
import { poolFor } from '../src/pool.js';

/** The database these cases reach, or nothing, in which case every suite here skips. */
export const url = process.env.WILANIS_TEST_POSTGRES_URL;

const KIND = '@storage-postgres/postgres.connection-kind.json';

/**
 * The connection a suite is asked about, in a schema of its own. Test files run in parallel and both suites
 * here drive the same collections, so a shared schema would have one file dropping the tables another was
 * counting rows in; a schema apiece is how the engine already separates two connections of one database, and
 * it carries `wilanis_migrations` with it rather than leaving the record behind in `public`.
 */
export function connectionIn(schema: string): On {
  return { connection: `@connections/${schema}.connection.json`, kind: KIND, settings: { url, schema } };
}

/** The engine under test, kept for the whole file as a tree would keep it. */
export const engine = new PostgresEngine({});

/** Who a case says applied the plan, so the record has a row it did not have to invent. */
export const by: Applying = { by: 'rfontes@build-1', tree: 'monitor' };

/** The `entries` collection as the tree declares it: keyed by id, one url per method, an optional agent. */
export const ENTRIES: Declared = {
  key: 'id',
  fields: {
    id: { type: 'string', required: true },
    url: { type: 'string', required: true },
    method: { type: 'string', required: true },
    ua: { type: 'string', required: false },
  },
  unique: [['url', 'method']],
  refs: {},
};

/** The `notes` collection: a note of an entry, so it references one and declares no `unique` of its own. */
export const NOTES: Declared = {
  key: 'id',
  fields: { id: { type: 'string', required: true }, entryId: { type: 'string', required: false } },
  unique: [],
  refs: { entryId: { collection: 'm_entries', onRemove: 'refuse' } },
};

/** The database a connection reaches, for the statements that set a case up. */
export const dbOf = (on: On) => poolFor(on, {}).db;

/**
 * Everything a suite drives its schema with: the connection, the database under it, a `clean` that empties the
 * schema between cases, and an `apply` that records who ran the plan.
 */
export interface Driving {
  on: On;
  /** the schema this suite's tables and record sit in, for the statements a case writes by hand */
  schema: string;
  db: () => ReturnType<typeof dbOf>;
  clean: () => Promise<void>;
  apply: (steps: Step[], record: Recording) => ReturnType<typeof engine.apply>;
}

/**
 * A suite's own schema and the helpers over it. The schema is dropped and remade rather than the tables
 * dropped one by one, so a case starts from a database that has never seen any of them -- including the
 * `wilanis_migrations` the engine makes on first contact.
 */
export function driving(schema: string): Driving {
  const on = connectionIn(schema);
  const db = () => dbOf(on);
  return {
    on,
    schema,
    db,
    clean: async () => {
      await sql`drop schema if exists ${sql.ref(schema)} cascade`.execute(db());
      await sql`create schema ${sql.ref(schema)}`.execute(db());
    },
    apply: (steps, record) => engine.apply(on, steps, record, by),
  };
}

/**
 * The steps the planner writes for collections a database has never recorded. Every case that makes a table
 * goes through this rather than through a hand-written `create`, so what a fresh plan actually does is what
 * these cases apply: a create that recorded a guarantee it never made would go unnoticed otherwise.
 */
export const planFor = (declared: Record<string, Declared>) => plan({}, declared, {}).steps;
