/**
 * This engine, judged by the same cases the memory one is. The behaviour is not restated here: it is
 * @storage's shared suite, which is what makes "this is an engine" one executable meaning rather than a
 * promise in a README. If a filter answers different records here than in memory, one of these cases fails.
 *
 * It needs a database, so it is skipped without `WILANIS_TEST_POSTGRES_URL` -- a suite that silently passes
 * without one would be worse than no suite. CI starts no database, so it runs by hand:
 *
 *   docker run -d --rm --name wilanis-pg -e POSTGRES_PASSWORD=wilanis -e POSTGRES_DB=wilanis \
 *     -p 55432:5432 postgres:16-alpine
 *   WILANIS_TEST_POSTGRES_URL=postgres://postgres:wilanis@127.0.0.1:55432/wilanis \
 *     npx vitest run packages/plugin-storage-postgres
 *
 * Every case keeps its records in a collection of its own and prepares it with `ensure` itself, so the whole
 * suite runs against one database without the cases reaching each other.
 */
import { cases, emptyWhereCases, scopeCases } from '@wilanis/plugin-storage/suite';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { PostgresEngine } from '../src/engine.js';
import { closePools, poolFor } from '../src/pool.js';
import { forgetScopes } from '../src/scoping.js';

const url = process.env.WILANIS_TEST_POSTGRES_URL;
const KIND = '@storage-postgres/postgres.connection-kind.json';
const CONNECTION = '@connections/records.connection.json';

const subject = {
  engine: new PostgresEngine({}),
  connection: { connection: CONNECTION, kind: KIND, settings: { url } },
};

afterAll(async () => {
  if (url) await closePools();
});

describe.skipIf(!url)('what every engine answers alike', () => {
  for (const one of cases) it(one.name, () => one.run(subject));
});

/** A filter of no test, which this engine answers as no filter; SQLite and MySQL join once #848 lands. */
describe.skipIf(!url)('what a filter of no test answers', () => {
  for (const one of emptyWhereCases) it(one.name, () => one.run(subject));
});

/**
 * The scope cases, which this engine answers as the memory one does: the column beside the record, the
 * predicate on every statement, and a `unique` that holds within a scope rather than across every one. They
 * are the same list both engines run, which is what makes "two tenants never see each other's rows" one
 * promise and not two. Two of them began as this engine's own: a statement that carries the filter and the
 * predicate at once, and a scoped read of a table nothing has written yet, before its scope column exists.
 */
describe.skipIf(!url)('what an engine that keeps scopes answers', () => {
  // a scope case's table is a scope_ one, dropped before they run so a second run starts from none: a case that
  // widens a scope needs a table that does not keep the wider one already
  beforeAll(async () => {
    const { db } = poolFor({ ...subject.connection, name: 'any' }, {});
    const tables = (await sql<{ name: string }>`select tablename as name from pg_tables
      where schemaname = 'public' and tablename like 'scope\_%'`.execute(db)) as { rows: { name: string }[] };
    for (const { name } of tables.rows) await sql`drop table if exists public.${sql.ref(name)} cascade`.execute(db);
    forgetScopes();
  });
  for (const one of scopeCases) it(one.name, () => one.run(subject));
});
