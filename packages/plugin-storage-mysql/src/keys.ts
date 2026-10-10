/**
 * The keys `newKey` answers. Under `uuidv7` a key is made in Node and nothing is written. Under `identity` a
 * key is a number reserved from the table `wilanis_keys` (`collection`, `next`): `AUTO_INCREMENT` answers only
 * after an insert, and `newKey` answers before one, so the engine keeps its own counter and reserves from it in
 * a short transaction that locks the collection's row -- two reservations, from this process or another, never
 * answer one key.
 *
 * The row is made before any transaction locks it, in a statement of its own: a `SELECT ... FOR UPDATE` of a
 * row that is not there locks the gap instead, and two first reservations would then wait on each other. A
 * reservation answers one past the highest key the collection has ever been handed or holds, whichever is
 * higher, so a record written with a key of its own moves the next reservation past it.
 *
 * The table is made by `ensure` under `identity`, and by the first reservation where `ensure` has not run: a
 * `CREATE TABLE` commits whatever transaction its session holds, so it is never run inside one.
 */
import { randomBytes } from 'node:crypto';
import { type At, betweenStatements, type Run } from '@wilanis/plugin-storage';
import { type Kysely, sql } from 'kysely';

/** The table the reserved keys are kept in, one row per collection. */
export const KEYS = 'wilanis_keys';

/** Make the table the reserved keys are kept in, where it is not there yet. Never inside a transaction. */
export async function ensureKeys(db: Kysely<never>): Promise<void> {
  await sql`
    create table if not exists ${sql.id(KEYS)} (
      collection VARCHAR(64) COLLATE utf8mb4_bin NOT NULL PRIMARY KEY, next BIGINT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin
  `.execute(db);
}

/** Make the table and the collection's row where either is not there, outside any transaction. */
export async function seedKeys(db: Kysely<never>, collection: string): Promise<void> {
  await ensureKeys(db);
  await sql`insert ignore into ${sql.id(KEYS)} (collection, next) values (${collection}, 1)`.execute(db);
}

/** One past the highest key the collection holds, or 1 where it holds none. */
async function pastHighest(db: Kysely<never>, at: At): Promise<number> {
  const rows = (
    await sql<{ top: number | null }>`select max(${sql.id(at.key)}) as top from ${sql.id(at.name)}`.execute(db)
  ).rows;
  return Math.floor(Number(rows[0]?.top ?? 0)) + 1;
}

/**
 * Reserve the next key of a collection on `db`, which the caller has put inside a transaction, the row seeded
 * already: lock the row, take the higher of what it keeps and one past the highest held, and keep the one after.
 * Three statements, and a run cancelled between two of them is stopped there (RFC 0012).
 */
export async function reserve(db: Kysely<never>, at: At, run?: Run): Promise<number> {
  const rows = (
    await sql<{ next: number }>`select next from ${sql.id(KEYS)} where collection = ${at.name} for update`.execute(db)
  ).rows;
  betweenStatements(run);
  const next = Math.max(Number(rows[0]?.next ?? 1), await pastHighest(db, at));
  betweenStatements(run);
  await sql`update ${sql.id(KEYS)} set next = ${next + 1} where collection = ${at.name}`.execute(db);
  return next;
}

/**
 * A UUID of version 7 (RFC 9562): the milliseconds since the epoch in the first 48 bits, then the version, the
 * variant and random bits. Keys made one after another sort in the order they were made, which keeps the
 * primary key's index from being written all over.
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
