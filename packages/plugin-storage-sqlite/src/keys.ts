/**
 * The keys `newKey` answers. Under `uuidv7` a key is made in Node and nothing is written. Under `identity` a
 * key is a number reserved from the table `wilanis_keys` (`collection`, `next`): SQLite has no sequence the
 * engine can draw from ahead of an insert, so the engine keeps its own, and reserves in a short transaction
 * that holds the file's write lock -- two reservations, from this process or another, never answer one key.
 *
 * A reservation answers one past the highest key the collection has ever been handed or holds, whichever is
 * higher, so a record written with a key of its own moves the next reservation past it.
 */
import { randomBytes } from 'node:crypto';
import type { At } from '@wilanis/plugin-storage';
import { type Kysely, sql } from 'kysely';

/** The table the reserved keys are kept in, one row per collection. */
export const KEYS = 'wilanis_keys';

/** Make the table the reserved keys are kept in, where it is not there yet. */
export async function ensureKeys(db: Kysely<never>): Promise<void> {
  await sql`create table if not exists ${sql.id(KEYS)} (collection TEXT NOT NULL PRIMARY KEY, next INTEGER NOT NULL)`.execute(
    db,
  );
}

/** The next key the table has kept for a collection, or nothing where it never reserved one. */
async function keptFor(db: Kysely<never>, collection: string): Promise<number | undefined> {
  const rows = (
    await sql<{ next: number }>`select next from ${sql.id(KEYS)} where collection = ${collection}`.execute(db)
  ).rows;
  return rows.length ? Number(rows[0].next) : undefined;
}

/** One past the highest key the collection holds, or 1 where it holds none. */
async function pastHighest(db: Kysely<never>, at: At): Promise<number> {
  const rows = (
    await sql<{ top: number | null }>`select max(${sql.id(at.key)}) as top from ${sql.id(at.name)}`.execute(db)
  ).rows;
  return Math.floor(Number(rows[0]?.top ?? 0)) + 1;
}

/**
 * Reserve the next key of a collection on `db`, which the caller has put inside a transaction holding the
 * write lock: read what is kept, take the higher of it and one past the highest held, and keep the one after.
 */
export async function reserve(db: Kysely<never>, at: At): Promise<number> {
  await ensureKeys(db);
  const next = Math.max((await keptFor(db, at.name)) ?? 1, await pastHighest(db, at));
  await sql`
    insert into ${sql.id(KEYS)} (collection, next) values (${at.name}, ${next + 1})
    on conflict (collection) do update set next = excluded.next
  `.execute(db);
  return next;
}

/**
 * A UUID of version 7 (RFC 9562): the milliseconds since the epoch in the first 48 bits, then the version, the
 * variant and random bits. Keys made one after another sort in the order they were made, which keeps an index
 * over them from being written all over.
 */
export function uuidv7(): string {
  const bytes = randomBytes(16);
  const now = Date.now();
  for (let at = 0; at < 6; at += 1) bytes[at] = Math.floor(now / 2 ** (8 * (5 - at))) % 256;
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
