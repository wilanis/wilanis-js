/**
 * The statements a write is made of. MySQL has no `RETURNING`, so a write answers what it can know without
 * one: `put` answers the record it was given, which is the record as stored (RFC 0003: a default never applies
 * to what `put` writes), and `patch` and `remove` read the row inside the same short transaction as the
 * statement (`engine.ts`).
 *
 * A `put` that may not replace is `INSERT IGNORE`, and whether it wrote is read off the affected rows. `IGNORE`
 * turns every refusal into a warning, a broken `unique` or `refs` as much as the key already held, so where
 * nothing was written and the key is not held the row is inserted once more without it: that statement fails
 * with the refusal `IGNORE` swallowed, and the engine answers it as the violation it is.
 *
 * A `put` that may replace is an `INSERT`, and an `UPDATE` by key where the insert found the key held. It is not
 * `ON DUPLICATE KEY UPDATE`: that clause fires on any unique index, so a record repeating another's `unique`
 * would overwrite the other record rather than be refused.
 */
import type { At } from '@wilanis/plugin-storage';
import type { Kysely } from 'kysely';
import { columnsOf, keyIn } from './rows.js';
import { indexNamed } from './violations.js';

type Row = Record<string, unknown>;

/** The row under that key, read on `db`, locked for the rest of its transaction where `lock` says so. */
export async function rowAt(db: Kysely<never>, at: At, key: unknown, lock = false): Promise<Row | undefined> {
  const query = db
    .selectFrom(at.name as never)
    .select(columnsOf(at) as never)
    .where(at.key as never, '=', keyIn(at, key) as never);
  return (await (lock ? query.forUpdate() : query).executeTakeFirst()) as Row | undefined;
}

/** Insert one row, failing on whatever the table refuses. */
const insert = (db: Kysely<never>, at: At, values: Row) =>
  db
    .insertInto(at.name as never)
    .values(values as never)
    .execute();

/**
 * Write the row where its key is not held; answer whether it was written. A key already held is the `conflict`
 * a `put` without `replace` answers; any other refusal is thrown, to be answered as the violation it is.
 */
export async function insertNew(db: Kysely<never>, at: At, values: Row): Promise<boolean> {
  const result = await db
    .insertInto(at.name as never)
    .ignore()
    .values(values as never)
    .executeTakeFirst();
  if (Number(result.numInsertedOrUpdatedRows ?? 0n) > 0) return true;
  if (await rowAt(db, at, values[at.key])) return false;
  await insert(db, at, values);
  return true;
}

/**
 * Write the row under its key, replacing whatever is there. The update counts the row it found, changed or not
 * (mysql2 asks for found rows), so a row removed between the insert and the update is inserted again.
 */
export async function upsert(db: Kysely<never>, at: At, values: Row): Promise<void> {
  try {
    await insert(db, at, values);
  } catch (error) {
    if (indexNamed(error) !== 'PRIMARY') throw error;
    const { [at.key]: key, ...rest } = values;
    if (!Object.keys(rest).length) return;
    const result = await db
      .updateTable(at.name as never)
      .set(rest as never)
      .where(at.key as never, '=', key as never)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) === 0) await insert(db, at, values);
  }
}
