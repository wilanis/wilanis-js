/**
 * What a scope makes of a table (RFC 0015): a column beside the record, every declared `unique` held within
 * the scope rather than across it, and an index over the scope and the key so a scoped `get` is one index
 * read. `scoping.ts` decides when this runs; this file is what it does to the file, and what `ensure` reads
 * back to know which columns are a scope.
 *
 * A scope column is `TEXT` for a string and `REAL` for a number, as a field of a shape is, and `NOT NULL`,
 * since every row of a scoped collection belongs to one scope. SQLite adds a `NOT NULL` column without a
 * default to an empty table only, which is the rule the postgres engine keeps by choice: a row written before
 * the store declared a scope belongs to no scope, and no declaration can say which one. That is `drift`, and
 * RFC 0017's planner is where that migration belongs.
 */
import type { At, Scope } from '@wilanis/plugin-storage';
import { type Kysely, sql } from 'kysely';
import { columnsOf, indexColumnsOf, rowCount } from './catalog.js';
import { quoted } from './columns.js';
import { scopedIndexName, scopedUniqueName, uniqueName } from './names.js';

/** One scope column a table lacks, with the value that says what type it is kept in. */
export type Missing = [column: string, value: string | number];

/**
 * The column type one scope value is kept in: `TEXT` for a string, `REAL` for a number, the two a scope may
 * be. The checker refuses a read that types as anything else, and the handlers judge the value at run time,
 * so a value of another type reaching here is a tree reloaded under a store that changed, and it says so.
 */
export function scopeTypeOf(column: string, value: unknown): string {
  if (typeof value === 'string') return 'TEXT';
  if (typeof value === 'number') return 'REAL';
  throw new Error(`scope: '${column}' holds a string or a number, and this one is ${typeof value}`);
}

/** The columns a table has, folded to lower case as SQLite compares them; none where there is no such table. */
export async function namesOf(db: Kysely<never>, table: string): Promise<Set<string>> {
  return new Set((await columnsOf(db, table)).map(one => one.name.toLowerCase()));
}

/** The scope's columns a table lacks, with their values, in the order the scope spells them. */
export const lacking = (scope: Scope, has: Set<string>): Missing[] =>
  Object.entries(scope).filter(([column]) => !has.has(column.toLowerCase()));

/**
 * The columns a table keeps as a scope, read back from the index this engine made over them and the key. The
 * index is the record: a scope column is not a field of the shape, so nothing the tree declares says which
 * columns those are, and `ensure` would otherwise read one as a `NOT NULL` column the shape has lost. The key
 * is in the index too and is taken out again here. They come back in the index's order, which is the scope's.
 */
export async function scopeColumnsOf(db: Kysely<never>, at: At): Promise<string[]> {
  const key = at.key.toLowerCase();
  return (await indexColumnsOf(db, scopedIndexName(at.name))).filter(one => one.toLowerCase() !== key);
}

/** One scope column added to a table, `NOT NULL`; a table with rows is refused as `drift` rather than guessed at. */
async function addScopeColumn(db: Kysely<never>, at: At, [column, value]: Missing): Promise<void> {
  const type = scopeTypeOf(column, value);
  const rows = await rowCount(db, at.name);
  if (rows)
    throw new Error(
      `drift: ${at.name} holds ${rows} row(s) and no '${column}' column, and a row written before the store was ` +
        'scoped belongs to no scope; hint: run wilanis migrate to plan what those rows become',
    );
  await sql.raw(`ALTER TABLE ${quoted(at.name)} ADD COLUMN ${quoted(column)} ${type} NOT NULL`).execute(db);
}

/**
 * Every `unique` the store declares, made again with the scope columns in front of it, and the one it replaces
 * dropped: the unscoped one, or the one over a narrower scope where the collection gains a second column.
 * `[url, method]` taken under one tenant is then free under every other, which is what "judged within the
 * scope" means -- said once here rather than spelled into every index the store writes.
 */
async function rescopeUniques(db: Kysely<never>, at: At, before: string[], columns: string[]): Promise<void> {
  for (const fields of at.unique) {
    const replaced = before.length ? scopedUniqueName(at.name, before, fields) : uniqueName(at.name, fields);
    const over = [...columns, ...fields].map(quoted).join(', ');
    await sql.raw(`DROP INDEX IF EXISTS ${quoted(replaced)}`).execute(db);
    await sql
      .raw(`CREATE UNIQUE INDEX ${quoted(scopedUniqueName(at.name, columns, fields))} ON ${quoted(at.name)} (${over})`)
      .execute(db);
  }
}

/**
 * The index a scoped read is answered from: the scope columns and the key together. It is dropped first
 * rather than made only where it is missing, since a collection that gains a second scope column has to be
 * indexed by both, and one index by a fixed name is what tells `ensure` which columns are the scope.
 */
async function indexScope(db: Kysely<never>, at: At, columns: string[]): Promise<void> {
  const name = quoted(scopedIndexName(at.name));
  const over = [...columns, at.key].map(quoted).join(', ');
  await sql.raw(`DROP INDEX IF EXISTS ${name}`).execute(db);
  await sql.raw(`CREATE INDEX ${name} ON ${quoted(at.name)} (${over})`).execute(db);
}

/**
 * What a first scope costs a table: the columns it lacks added, the uniques made again within the scope and
 * the index made. Only `missing` is added as a column, but the uniques and the index are over every column
 * the scope names -- a constraint within half a scope would hold across the other half, which is no scope.
 */
export async function addScope(db: Kysely<never>, at: At, scope: Scope, missing: Missing[]): Promise<void> {
  const before = await scopeColumnsOf(db, at);
  const columns = Object.keys(scope);
  for (const one of missing) await addScopeColumn(db, at, one);
  await rescopeUniques(db, at, before, columns);
  await indexScope(db, at, columns);
}
