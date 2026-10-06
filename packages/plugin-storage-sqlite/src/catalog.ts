/**
 * What the file already holds, read from SQLite's own catalog: whether a table is there, its columns, the
 * references it makes and the indexes over it. `ensure` reads it to add only what is missing, and `put` and
 * `remove` read it to say which reference a refused write broke, since SQLite's foreign-key error names none.
 *
 * Every name is compared without case, as SQLite compares identifiers: `Notes` and `notes` are one table.
 */
import { type Kysely, sql } from 'kysely';

/** One column as `pragma_table_info` reports it. */
export interface Column {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

/** One reference as `pragma_foreign_key_list` reports it: the column, the table it names and that table's column. */
export interface ForeignKey {
  from: string;
  table: string;
  to: string | null;
}

/** The rows of one statement, which is how Kysely answers a raw query. */
async function rowsOf<T>(db: Kysely<never>, query: ReturnType<typeof sql<T>>): Promise<T[]> {
  return (await query.execute(db)).rows;
}

/** Whether the file holds a table of this name. */
export async function hasTable(db: Kysely<never>, table: string): Promise<boolean> {
  const rows = await rowsOf(
    db,
    sql<{ name: string }>`select name from sqlite_master where type = 'table' and name = ${table} collate nocase`,
  );
  return rows.length > 0;
}

/** The columns of a table, in the order it declares them; none where there is no such table. */
export const columnsOf = (db: Kysely<never>, table: string): Promise<Column[]> =>
  rowsOf(db, sql<Column>`select name, type, "notnull", pk from pragma_table_info(${table})`);

/** The references a table makes, one per column that holds another table's key. */
export const foreignKeysOf = (db: Kysely<never>, table: string): Promise<ForeignKey[]> =>
  rowsOf(db, sql<ForeignKey>`select "from", "table", "to" from pragma_foreign_key_list(${table})`);

/**
 * The column lists a table's unique indexes cover, each folded to lower case: what a declared `unique` is held
 * by, read off the index rather than off its name, so two declarations whose names would spell alike are
 * never mistaken for one. The primary key's own index is among them.
 */
export async function uniquesOf(db: Kysely<never>, table: string): Promise<string[][]> {
  const listed = await rowsOf(
    db,
    sql<{ name: string }>`select name from pragma_index_list(${table}) where "unique" = 1`,
  );
  const covered: string[][] = [];
  for (const index of listed) covered.push((await indexColumnsOf(db, index.name)).map(one => one.toLowerCase()));
  return covered;
}

/** The columns one index covers, in its order, as the index spells them; none where there is no such index. */
export async function indexColumnsOf(db: Kysely<never>, index: string): Promise<string[]> {
  const columns = await rowsOf(db, sql<{ name: string }>`select name from pragma_index_info(${index}) order by seqno`);
  return columns.map(one => String(one.name));
}

/** How many rows a table holds. */
export async function rowCount(db: Kysely<never>, table: string): Promise<number> {
  const rows = await rowsOf(db, sql<{ n: number }>`select count(*) as n from ${sql.id(table)}`);
  return Number(rows[0]?.n ?? 0);
}

/** Whether a table holds a row whose column holds this value. */
export async function holds(
  db: Kysely<never>,
  where: { table: string; column: string },
  value: unknown,
): Promise<boolean> {
  const rows = await rowsOf(
    db,
    sql<{ one: number }>`select 1 as one from ${sql.id(where.table)} where ${sql.id(where.column)} = ${value} limit 1`,
  );
  return rows.length > 0;
}

/** The column that is a table's primary key, where it has one of a single column. */
export async function keyOf(db: Kysely<never>, table: string): Promise<string | undefined> {
  const keyed = (await columnsOf(db, table)).filter(one => one.pk > 0);
  return keyed.length === 1 ? keyed[0].name : undefined;
}
