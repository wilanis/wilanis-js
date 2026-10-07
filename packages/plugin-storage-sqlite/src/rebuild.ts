/**
 * A table remade, for the steps SQLite's `ALTER TABLE` cannot take: a column changes type, becomes required or
 * optional, gains or loses a reference, or goes. SQLite has no `ALTER COLUMN`, and adds a reference only in the
 * statement that makes its column.
 *
 * The sequence is the one SQLite documents for "making other kinds of table schema changes" (the twelve steps),
 * not the shorter one that renames the old table out of the way first. The difference matters here: since
 * SQLite 3.26, renaming a table rewrites every `REFERENCES` to it in other tables, so renaming `notes` to
 * `old_notes` would leave each table that references `notes` pointing at `old_notes`, and dropping that would
 * break them. The documented order never renames the table others name: it makes `wl_rebuild_<name>`, copies
 * the rows, drops the old table and gives the new one its name, then makes the indexes again.
 *
 * Of the twelve steps, `apply.ts` and `handles.ts` hold the ones around a plan: foreign keys off before the
 * transaction (SQLite ignores the pragma inside one), one transaction for the whole plan rather than one per
 * table, and `PRAGMA foreign_key_check` before the commit. This file is the steps in between, for one table. A
 * failure at any of them rolls the whole plan back, the drop and the rename included: SQLite's DDL is
 * transactional.
 */
import type { Declared } from '@wilanis/plugin-storage';
import { type Kysely, sql } from 'kysely';
import { quoted } from './columns.js';
import { createTableSql, type Kept, same } from './ddl.js';
import { type Index, readTable, type Table } from './inspect.js';
import { folded, uniqueName } from './names.js';

/** What a step makes of a table: its columns in order, its references, and how a column is copied where not as itself. */
export interface Change {
  columns: Kept[];
  refs: Declared['refs'];
  /** a column's value computed from the row it is copied from, by the column's name; the column itself otherwise */
  from?: Record<string, string>;
}

/** One statement of DDL, run on the plan's handle. */
const run = (db: Kysely<never>, statement: string) => sql.raw(statement).execute(db);

/** What a column of the new table is copied from: what the step says, the old column of that name, or nothing. */
function sourceOf(column: Kept, table: Table, change: Change): string {
  const given = change.from?.[column.name];
  if (given) return given;
  return table.columns.some(one => same(one.name, column.name)) ? quoted(column.name) : 'NULL';
}

/** The `INSERT ... SELECT` that copies every row into the new table. */
function copySql(table: Table, into: string, change: Change): string {
  const names = change.columns.map(column => quoted(column.name)).join(', ');
  const values = change.columns.map(column => sourceOf(column, table, change)).join(', ');
  return `INSERT INTO ${quoted(into)} (${names}) SELECT ${values} FROM ${quoted(table.name)}`;
}

/**
 * The statement that makes one index again, or nothing where it cannot or need not be made. The primary key's
 * index comes back with the table. An index over a column the step removed goes with the column. A unique index
 * SQLite made for a `UNIQUE` written in the table has no DDL of its own, so it is made again as the unique index
 * `ensure` would have made.
 */
function remade(index: Index, table: Table, kept: Kept[]): string | undefined {
  if (index.pk) return undefined;
  if (!index.columns.every(column => kept.some(one => same(one.name, column)))) return undefined;
  if (index.sql) return index.sql;
  if (!index.unique) return undefined;
  const over = index.columns.map(quoted).join(', ');
  return `CREATE UNIQUE INDEX ${quoted(uniqueName(table.name, index.columns))} ON ${quoted(table.name)} (${over})`;
}

/**
 * Remake one table as a step changes it, inside the caller's transaction, and answer whether anything was done:
 * a step whose change the table already holds answers nothing, and the table is left as it is. The key, and
 * whether it is SQLite's own integer key, are the table's: no step that reaches here changes either.
 */
export async function rebuild(
  db: Kysely<never>,
  name: string,
  change: (table: Table) => Change | undefined,
): Promise<boolean> {
  const table = await readTable(db, name);
  if (!table) throw new Error(`rebuild ${name}: the file holds no such table`);
  const next = change(table);
  if (!next) return false;
  const temp = `wl_rebuild_${folded(table.name)}`;
  const layout = { columns: next.columns, key: table.key, integerKey: table.integerKey, refs: next.refs };
  await run(db, createTableSql(temp, layout));
  await run(db, copySql(table, temp, next));
  await run(db, `DROP TABLE ${quoted(table.name)}`);
  await run(db, `ALTER TABLE ${quoted(temp)} RENAME TO ${quoted(table.name)}`);
  for (const index of table.indexes) {
    const statement = remade(index, table, next.columns);
    if (statement) await run(db, statement);
  }
  return true;
}
