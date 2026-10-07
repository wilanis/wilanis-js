/**
 * The lease keeper this engine answers for @schedule, against a real database: who holds a tick, how a hold
 * is renewed, expires and is let go, and why a tick marked fired is granted to nobody however late a clock
 * asks. Two keepers are two holders, as two processes would be, over one table.
 *
 * A connection whose schema the database does not hold yet finds it made on first contact, as `migrate` does
 * (#868), so a tree that schedules before it stores needs no `create schema` by hand.
 *
 * It needs a database, so the database cases are skipped without `WILANIS_TEST_POSTGRES_URL`, as the shared
 * suite is (`engine.test.ts` says how to run one). That the plugin registers its keeper needs none.
 */
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { leases } from '@wilanis/plugin-storage';
import { sql } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import plugin from '../src/index.js';
import { TableLeases } from '../src/leases.js';
import { closePools, poolFor } from '../src/pool.js';

const url = process.env.WILANIS_TEST_POSTGRES_URL;
const KIND = '@storage-postgres/postgres.connection-kind.json';
const CONNECTION = '@connections/records.connection.json';
const env = { connections: { [CONNECTION]: { kind: KIND, settings: { url } } } };

const T3 = '2026-01-01T03:00:00.000Z';
const T4 = '2026-01-01T04:00:00.000Z';
const T2 = '2026-01-01T02:00:00.000Z';

/** A trigger no other case names, so every case starts from no row at all. */
const fresh = () => `@features/t/${randomUUID()}.trigger.json`;
/** Two keepers over one table: two holders, as two processes would be. */
const pair = () => [new TableLeases(env, {}), new TableLeases(env, {})] as const;

/** The database as its owner reaches it, to drop what a case made. */
const admin = () =>
  poolFor({ connection: '@connections/s868-admin.connection.json', kind: KIND, settings: { url } }, {}).db;

afterAll(async () => {
  await closePools();
});

describe('the keeper this engine registers', () => {
  it('is registered from postLoad under the kind it grants, beside the engine', async () => {
    const tree = { connections: {} };
    const down = await plugin.postLoad?.({
      env: tree,
      settings: {},
      scope: { canon: (ref: string) => ref },
    } as never);
    expect(leases(tree).for(KIND)).toBeInstanceOf(TableLeases);
    if (typeof down === 'function') await down();
  });
});

describe.skipIf(!url)('a lease kept in postgres', () => {
  it('grants one tick to one holder, and renews it for that holder', async () => {
    const [one, two] = pair();
    const name = fresh();
    expect(await one.acquire(CONNECTION, name, T3, 30_000)).toBe(true);
    expect(await two.acquire(CONNECTION, name, T3, 30_000)).toBe(false);
    expect(await one.acquire(CONNECTION, name, T3, 30_000)).toBe(true);
  });

  it('takes a tick once across two keepers asking at the same moment', async () => {
    const [one, two] = pair();
    const name = fresh();
    const answers = await Promise.all([
      one.acquire(CONNECTION, name, T3, 30_000),
      two.acquire(CONNECTION, name, T3, 30_000),
    ]);
    expect(answers.filter(Boolean)).toHaveLength(1);
  });

  it('lets another holder take a hold that expired', async () => {
    const [one, two] = pair();
    const name = fresh();
    expect(await one.acquire(CONNECTION, name, T3, 50)).toBe(true);
    await sleep(150);
    expect(await two.acquire(CONNECTION, name, T3, 30_000)).toBe(true);
    expect(await one.acquire(CONNECTION, name, T3, 30_000)).toBe(false);
  });

  it('lets another holder take a released hold without waiting it out', async () => {
    const [one, two] = pair();
    const name = fresh();
    expect(await one.acquire(CONNECTION, name, T3, 30_000)).toBe(true);
    await two.release(CONNECTION, name);
    expect(await two.acquire(CONNECTION, name, T3, 30_000)).toBe(false);
    await one.release(CONNECTION, name);
    expect(await two.acquire(CONNECTION, name, T3, 30_000)).toBe(true);
  });

  it('refuses a tick marked fired, or an earlier one, to every holder, and grants a later one', async () => {
    const [one, two] = pair();
    const name = fresh();
    expect(await one.acquire(CONNECTION, name, T3, 30_000)).toBe(true);
    await one.markFired(CONNECTION, name, T3);
    await one.release(CONNECTION, name);
    for (const keeper of [one, two]) {
      expect(await keeper.acquire(CONNECTION, name, T3, 30_000)).toBe(false);
      expect(await keeper.acquire(CONNECTION, name, T2, 30_000)).toBe(false);
    }
    expect(await two.acquire(CONNECTION, name, T4, 30_000)).toBe(true);
  });

  it('remembers the last tick fired, and never moves it back', async () => {
    const [one, two] = pair();
    const name = fresh();
    expect(await one.lastFired(CONNECTION, name)).toBeUndefined();
    await one.markFired(CONNECTION, name, T3);
    expect(await two.lastFired(CONNECTION, name)).toBe(T3);
    await two.markFired(CONNECTION, name, T2);
    expect(await one.lastFired(CONNECTION, name)).toBe(T3);
    await two.markFired(CONNECTION, name, T4);
    expect(await one.lastFired(CONNECTION, name)).toBe(T4);
  });
});

describe.skipIf(!url)('a lease on a schema the database does not hold yet', () => {
  it('makes the schema on first contact, and keeps the lease there', async () => {
    const schema = `s868_${randomUUID().slice(0, 8)}`;
    const connection = `@connections/${schema}.connection.json`;
    const keeper = new TableLeases({ connections: { [connection]: { kind: KIND, settings: { url, schema } } } }, {});
    const name = fresh();
    try {
      expect(await keeper.acquire(connection, name, T3, 30_000)).toBe(true);
      await keeper.markFired(connection, name, T3);
      const kept =
        await sql`select 1 from ${sql.ref(schema)}.${sql.ref('wilanis_schedule')} where name = ${name}`.execute(
          admin(),
        );
      expect((kept as { rows: unknown[] }).rows).toHaveLength(1);
    } finally {
      await sql`drop schema if exists ${sql.ref(schema)} cascade`.execute(admin());
    }
  });
});
