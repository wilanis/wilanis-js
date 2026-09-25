/**
 * `wilanis_queue`: every statement the table broker runs, and nothing else. One row per message, in the schema
 * of the connection it was published to -- its queue, its body and headers as jsonb, how many times it has been
 * handed out, when it may next be, whose lock holds it until when, and when it was parked as dead.
 *
 * Every moment is the database's: `available_at`, `locked_until` and the wait before the next message falls due
 * are all asked of `now()` on the one server every worker shares, so two processes whose clocks drift still agree
 * on what is due. `attempts` is counted when a message is taken, and every later statement about that delivery
 * names the attempt it took: a worker whose lock expired and whose message another worker took since finds its
 * acknowledgement matches no row, so it cannot forget, retry or park a delivery that is no longer its own.
 */
import { randomUUID } from 'node:crypto';
import type { Kysely, RawBuilder } from 'kysely';
import { sql } from 'kysely';

/** The channel every publish and retry notifies on; the payload says which schema and queue. */
export const CHANNEL = 'wilanis_queue';

/** Where one connection's messages are kept: the session statements go to, and the schema the table is in. */
export interface Table {
  db: Kysely<never>;
  schema: string;
}

/** One message as the table hands it out: its id, the attempt this delivery is, what rode beside it. */
export interface Taken {
  id: string;
  attempt: number;
  headers: Record<string, string>;
  body: unknown;
}

/** The table, qualified by the connection's schema. */
const tableOf = (schema: string): RawBuilder<unknown> => sql`${sql.ref(schema)}.${sql.ref('wilanis_queue')}`;

/** What a notification about one queue carries, so a listener can tell the schemas one database holds apart. */
export const payloadOf = (schema: string, queue: string) => `${schema}.${queue}`;

/**
 * Whether a failed `create ... if not exists` lost the race to another process creating the same thing:
 * PostgreSQL checks before it takes the catalog lock, so two first contacts at once can both miss it.
 */
const lostTheRace = (error: unknown) => ['23505', '42P07'].includes(String((error as { code?: unknown }).code));

/** Run one DDL statement, where a process that made the same thing a moment earlier is not a failure. */
async function creating(statement: RawBuilder<unknown>, db: Kysely<never>): Promise<void> {
  try {
    await statement.execute(db);
  } catch (error) {
    if (!lostTheRace(error)) throw error;
  }
}

/** Create the queue table and its index where the schema has neither, and leave both alone where it has them. */
export async function ensureQueue({ db, schema }: Table): Promise<void> {
  await creating(
    sql`
      create table if not exists ${tableOf(schema)} (
        id uuid primary key,
        queue text not null,
        body jsonb not null,
        headers jsonb not null,
        attempts integer not null default 0,
        available_at timestamptz not null,
        locked_until timestamptz,
        dead_at timestamptz
      )
    `,
    db,
  );
  await creating(
    sql`create index if not exists wilanis_queue_due on ${tableOf(schema)} (queue, available_at) where dead_at is null`,
    db,
  );
}

/** One message to keep: what was published, and how long it waits before it may be handed out. */
export interface Put {
  queue: string;
  body: unknown;
  headers: Record<string, string>;
  delayMs: number;
}

/**
 * Keep one message and tell every listener its queue changed, in one statement. On a transaction's session
 * both wait for the commit -- PostgreSQL delivers a notification only once the transaction that raised it
 * commits -- so a message published in an atomic graph is neither kept nor announced if the graph rolls back.
 */
export async function putMessage({ db, schema }: Table, put: Put): Promise<string> {
  const id = randomUUID();
  await sql`
    with kept as (
      insert into ${tableOf(schema)} (id, queue, body, headers, available_at)
      values (${id}, ${put.queue}, ${JSON.stringify(put.body) ?? 'null'}::jsonb, ${JSON.stringify(put.headers)}::jsonb,
        now() + ${put.delayMs} * interval '1 millisecond')
      returning id
    )
    select pg_notify(${CHANNEL}, ${payloadOf(schema, put.queue)}) from kept
  `.execute(db);
  return id;
}

/** What one look at a queue found: the messages taken, and how long until the next could be, if any could. */
export interface Looked {
  taken: Taken[];
  /** Milliseconds until the soonest message not taken may be, by the database's clock; absent where none waits. */
  nextMs?: number;
}

/**
 * Take up to `room` messages that are due and nobody holds, locking each for `visibilityMs`, and say how long
 * until the next one could be -- in one transaction, so both are judged at the same `now()`.
 *
 * `skip locked` passes over a row another worker is taking at this instant. That row will be locked for the
 * visibility window by then, so it counts as due one window from now: a timer armed for it wakes when that lock
 * would expire, which is when a worker that died holding it gives it up. A row this call took is not counted --
 * it is in flight here, and a timer for its own lock would wake the consumer to find nothing.
 */
export async function takeDue(table: Table, queue: string, room: number, visibilityMs: number): Promise<Looked> {
  return table.db.transaction().execute(async trx => {
    const on = { ...table, db: trx as unknown as Kysely<never> };
    const taken = await lockDue(on, queue, room, visibilityMs);
    const nextMs = await nextDue(
      on,
      queue,
      taken.map(one => one.id),
      visibilityMs,
    );
    return { taken, nextMs };
  });
}

/** Lock up to `room` due messages nobody holds, one attempt higher, oldest first. */
async function lockDue({ db, schema }: Table, queue: string, room: number, visibilityMs: number): Promise<Taken[]> {
  const table = tableOf(schema);
  const answer = (await sql`
    update ${table} as q
    set attempts = q.attempts + 1, locked_until = now() + ${visibilityMs} * interval '1 millisecond'
    from (
      select id from ${table}
      where queue = ${queue} and dead_at is null and available_at <= now()
        and (locked_until is null or locked_until <= now())
      order by available_at, id
      limit ${room}
      for update skip locked
    ) as due
    where q.id = due.id
    returning q.id, q.attempts, q.headers, q.body, q.available_at
  `.execute(db)) as { rows: (Taken & { attempts: number; available_at: Date })[] };
  return answer.rows
    .sort((one, two) => one.available_at.getTime() - two.available_at.getTime())
    .map(row => ({ id: row.id, attempt: row.attempts, headers: row.headers, body: row.body }));
}

/** How long until the soonest message of the queue not just taken may be handed out; nothing where none waits. */
async function nextDue(
  { db, schema }: Table,
  queue: string,
  taken: string[],
  visibilityMs: number,
): Promise<number | undefined> {
  const due = sql`greatest(available_at, coalesce(locked_until, available_at))`;
  const answer = (await sql`
    select ceil(extract(epoch from (min(
      case when ${due} > now() then ${due} else now() + ${visibilityMs} * interval '1 millisecond' end
    ) - now())) * 1000) as wait
    from ${tableOf(schema)}
    where queue = ${queue} and dead_at is null and id <> all(${taken}::uuid[])
  `.execute(db)) as { rows: { wait: unknown }[] };
  const wait = answer.rows[0]?.wait;
  return wait === null || wait === undefined ? undefined : Math.max(0, Number(wait));
}

/** Forget one delivered message: the acknowledgement, where the delivery is still this one. */
export async function forget({ db, schema }: Table, taken: Taken): Promise<void> {
  await sql`delete from ${tableOf(schema)} where id = ${taken.id} and attempts = ${taken.attempt}`.execute(db);
}

/**
 * Let one delivered message be handed out again no sooner than `afterMs` from now, and tell every listener,
 * so a worker of another process with room for it takes it when it falls due rather than at its next look.
 */
export async function release({ db, schema }: Table, taken: Taken, queue: string, afterMs: number): Promise<void> {
  await sql`
    with released as (
      update ${tableOf(schema)}
      set available_at = now() + ${afterMs} * interval '1 millisecond', locked_until = null
      where id = ${taken.id} and attempts = ${taken.attempt}
      returning id
    )
    select pg_notify(${CHANNEL}, ${payloadOf(schema, queue)}) from released
  `.execute(db);
}

/** Park one delivered message as dead: it stays in the table for an operator, and is never handed out again. */
export async function park({ db, schema }: Table, taken: Taken): Promise<void> {
  await sql`
    update ${tableOf(schema)} set dead_at = now(), locked_until = null
    where id = ${taken.id} and attempts = ${taken.attempt}
  `.execute(db);
}

/**
 * Give back a message taken as a stop began, as if it had never been taken: the lock let go and the attempt
 * not counted, since nothing ran. It is due again at once, for whichever worker looks next.
 */
export async function untake({ db, schema }: Table, taken: Taken): Promise<void> {
  await sql`
    update ${tableOf(schema)} set attempts = attempts - 1, locked_until = null
    where id = ${taken.id} and attempts = ${taken.attempt}
  `.execute(db);
}

/** What was parked as dead on a queue, in the order it was parked. */
export async function parkedOn({ db, schema }: Table, queue: string): Promise<{ id: string; body: unknown }[]> {
  const answer = (await sql`
    select id, body from ${tableOf(schema)} where queue = ${queue} and dead_at is not null order by dead_at, id
  `.execute(db)) as { rows: { id: string; body: unknown }[] };
  return answer.rows;
}
