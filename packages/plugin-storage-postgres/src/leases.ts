/**
 * `wilanis_schedule`: the lease keeper this engine answers for @schedule (RFC 0010, *Lease keepers*). One row
 * per trigger -- who holds it, until when, and the last tick recorded as fired -- in the database the
 * connection reaches, so a tree with a store needs no second service to schedule on several instances.
 *
 * The table is created on first contact, as `wilanis_migrations` is, and never by a step of a plan: a plan says
 * what the tree declares, and the lease is this engine's own furniture. A tree may name a lease and never run
 * `ensure`, so the keeper cannot wait for one.
 *
 * Every hold is judged by the database's clock, never this process's: two instances whose clocks drift still
 * agree on whether a hold has expired, since `now()` is asked of the one server they share.
 */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { Leases } from '@wilanis/plugin-storage';
import { type Kysely, type RawBuilder, sql } from 'kysely';
import { poolFor, type Settings } from './pool.js';

/** The connections an environment carries, with their kinds and their settings, secrets substituted. */
type Connections = Record<string, { kind: string; settings: Record<string, unknown> }>;

/** Where one connection's leases are kept: its pool, and the lease table qualified by the connection's schema. */
interface Kept {
  db: Kysely<never>;
  table: RawBuilder<unknown>;
}

/** The lease table, qualified by the connection's schema. */
const tableIn = (schema: string) => sql`${sql.ref(schema)}.${sql.ref('wilanis_schedule')}`;

/**
 * Whether a failed `create table if not exists` lost the race to another process creating the same table:
 * PostgreSQL checks for the table before taking the catalog lock, so two first contacts at once can both miss
 * it and the second answers a duplicate in the catalog rather than finding the table there.
 */
const lostTheRace = (error: unknown) => ['23505', '42P07'].includes(String((error as { code?: unknown }).code));

/** Create the lease table where the schema has none, and leave it alone where it has one. */
async function ensureLeases(db: Kysely<never>, schema: string): Promise<void> {
  try {
    await sql`
      create table if not exists ${tableIn(schema)} (
        name text primary key,
        holder text,
        held_until timestamptz,
        last_fired timestamptz
      )
    `.execute(db);
  } catch (error) {
    if (!lostTheRace(error)) throw error;
  }
}

/** A timestamp as the driver hands it back, as the ISO 8601 the scheduler names its ticks in. */
const isoOf = (value: unknown) => (value instanceof Date ? value : new Date(String(value))).toISOString();

/**
 * The lease keeper for every connection of the postgres kind in one environment. Each keeper is one holder:
 * a process names itself once, so a renewal is recognised as the same holder asking again and a second
 * process, or a second keeper in the same one, is another holder.
 */
export class TableLeases implements Leases {
  private readonly holder = `${hostname()}:${process.pid}:${randomUUID()}`;
  private readonly ready = new Map<string, Promise<Kept>>();

  /** `env` is read at each call for the connection's settings, as a store's handler reads them. */
  constructor(
    private readonly env: object,
    private readonly settings: Settings,
  ) {}

  /** The pool and table a connection's leases are kept in, the table created on the first call against it. */
  private keptOn(connection: string): Promise<Kept> {
    const made = this.ready.get(connection);
    if (made) return made;
    const opening = this.open(connection);
    this.ready.set(connection, opening);
    opening.catch(() => this.ready.delete(connection));
    return opening;
  }

  /** Reach the connection's database and make sure the lease table is there. */
  private async open(connection: string): Promise<Kept> {
    const conn = (this.env as { connections?: Connections }).connections?.[connection];
    if (!conn) throw new Error(`lease on '${connection}': not a connection of this tree`);
    const { db, schema } = poolFor({ connection, kind: conn.kind, settings: conn.settings }, this.settings);
    await ensureLeases(db, schema);
    return { db, table: tableIn(schema) };
  }

  /**
   * RFC 0010's one statement: insert the hold, or take it over where the hold there has expired or is already
   * this holder's, and only while no tick at or after this one has been marked fired. `returning` answers a
   * row exactly when the hold is this holder's, so two processes never both hold one trigger.
   */
  async acquire(connection: string, name: string, scheduled: string, ttlMs: number): Promise<boolean> {
    const { db, table } = await this.keptOn(connection);
    const answer = (await sql<{ holder: string }>`
      insert into ${table} as held (name, holder, held_until)
      values (${name}, ${this.holder}, now() + ${ttlMs} * interval '1 millisecond')
      on conflict (name) do update set holder = excluded.holder, held_until = excluded.held_until
      where (held.held_until is null or held.held_until < now() or held.holder = excluded.holder)
        and (held.last_fired is null or held.last_fired < ${scheduled}::timestamptz)
      returning holder
    `.execute(db)) as { rows: { holder: string }[] };
    return answer.rows.length === 1;
  }

  /** Let the hold go now, where it is this holder's; another holder's hold is not this one's to end. */
  async release(connection: string, name: string): Promise<void> {
    const { db, table } = await this.keptOn(connection);
    await sql`
      update ${table} set held_until = now() where name = ${name} and holder = ${this.holder}
    `.execute(db);
  }

  /** The tick last recorded as fired for the trigger, or nothing where none ever was. */
  async lastFired(connection: string, name: string): Promise<string | undefined> {
    const { db, table } = await this.keptOn(connection);
    const answer = (await sql<{ last_fired: unknown }>`
      select last_fired from ${table} where name = ${name}
    `.execute(db)) as { rows: { last_fired: unknown }[] };
    const last = answer.rows[0]?.last_fired;
    return last === null || last === undefined ? undefined : isoOf(last);
  }

  /** Record the tick as fired, never moving the record back: a late mark of an earlier tick changes nothing. */
  async markFired(connection: string, name: string, scheduled: string): Promise<void> {
    const { db, table } = await this.keptOn(connection);
    await sql`
      insert into ${table} as held (name, last_fired) values (${name}, ${scheduled}::timestamptz)
      on conflict (name) do update set last_fired = greatest(held.last_fired, excluded.last_fired)
    `.execute(db);
  }
}
