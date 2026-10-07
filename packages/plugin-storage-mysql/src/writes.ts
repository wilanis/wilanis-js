/**
 * The statements a write is made of. MySQL has no `RETURNING`, so a write answers what it can know without
 * one: `put` answers the record it was given, which is the record as stored (RFC 0003: a default never applies
 * to what `put` writes), and `patch` and `remove` read the row inside the same short transaction as the
 * statement (`engine.ts`).
 *
 * A `put` that may not replace is a plain `INSERT`, and a duplicate of the primary key is the `conflict` it
 * answers. It is not `INSERT IGNORE`: `IGNORE` turns more than a duplicate key into a warning, even in strict
 * mode. A string longer than its column would be cut and stored, and a `NULL` in a `NOT NULL` column given the
 * column's implicit default, so `put` would answer a record the table does not hold. Any other refusal of the
 * plain insert is thrown, and the engine answers a broken `unique` or `refs` as the violation it is.
 *
 * A `put` that may replace is an `INSERT`, and an `UPDATE` by key where the insert found the key held. It is not
 * `ON DUPLICATE KEY UPDATE`: that clause fires on any unique index, so a record repeating another's `unique`
 * would overwrite the other record rather than be refused.
 *
 * Under a scope (RFC 0015) every statement here is narrowed to it. The key is still global: a replacing `put` of
 * a key another scope holds finds no row of its own scope to update, and its insert finds the key held, so it
 * answers the `conflict` it is and touches the other scope's row not at all.
 */
import type { At, Scope } from '@wilanis/plugin-storage';
import type { Kysely } from 'kysely';
import { columnsOf, keyIn } from './rows.js';
import { within } from './scoping.js';
import { indexNamed } from './violations.js';

type Row = Record<string, unknown>;

/**
 * The row under that key within the scope, read on `db`, locked for the rest of its transaction where `lock`
 * says so. A row of another scope is not there.
 */
export async function rowAt(
  db: Kysely<never>,
  at: At,
  key: unknown,
  { scope, lock = false }: { scope?: Scope; lock?: boolean } = {},
): Promise<Row | undefined> {
  const query = db
    .selectFrom(at.name as never)
    .select(columnsOf(at) as never)
    .where(at.key as never, '=', keyIn(at, key) as never)
    .where(eb => within(eb as never, scope) as never);
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
  try {
    await insert(db, at, values);
    return true;
  } catch (error) {
    if (indexNamed(error) === 'PRIMARY') return false;
    throw error;
  }
}

/**
 * Write the row under its key within the scope, replacing whatever that scope holds there; answer whether it was
 * written. The update counts the row it found, changed or not (mysql2 asks for found rows). Where it finds none,
 * the insert is tried once more: a row removed between the two is written, and a key another scope holds is
 * found held, which is the `conflict` a replacing `put` answers. Under a scope `values` carries the scope
 * columns, so the update sets them to what they already are.
 */
export async function upsert(db: Kysely<never>, at: At, values: Row, scope?: Scope): Promise<boolean> {
  try {
    await insert(db, at, values);
    return true;
  } catch (error) {
    if (indexNamed(error) !== 'PRIMARY') throw error;
    const { [at.key]: key, ...rest } = values;
    if (!Object.keys(rest).length) return true;
    const result = await db
      .updateTable(at.name as never)
      .set(rest as never)
      .where(at.key as never, '=', key as never)
      .where(eb => within(eb as never, scope) as never)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0 || insertNew(db, at, values);
  }
}
