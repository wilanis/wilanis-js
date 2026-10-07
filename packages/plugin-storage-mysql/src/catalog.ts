/**
 * What the database already holds, read from `information_schema` for the database the URL names: whether a
 * table is there, its columns, its indexes, its foreign keys and its key. `ensure` reads it to add only
 * what is missing. Table names are compared as written, since whether MySQL folds them is the host's setting.
 */
import { type Kysely, sql } from 'kysely';

/** One column as `information_schema.COLUMNS` reports it. */
export interface Column {
  name: string;
  /** the column type in lower case, as `varchar(768)`, `text`, `double`, `tinyint(1)`, `json` */
  type: string;
  nullable: boolean;
}

/** The rows of one statement, which is how Kysely answers a raw query. */
async function rowsOf<T>(db: Kysely<never>, query: ReturnType<typeof sql<T>>): Promise<T[]> {
  return (await query.execute(db)).rows;
}

/** Whether the database holds a table of this name. */
export async function hasTable(db: Kysely<never>, table: string): Promise<boolean> {
  const rows = await rowsOf(
    db,
    sql<{ name: string }>`select TABLE_NAME as name from information_schema.TABLES
      where TABLE_SCHEMA = database() and TABLE_NAME = ${table}`,
  );
  return rows.length > 0;
}

/** The columns of a table, in the order it declares them; none where there is no such table. */
export async function columnsOf(db: Kysely<never>, table: string): Promise<Column[]> {
  const rows = await rowsOf(
    db,
    sql<{ name: string; type: string; nullable: string }>`
      select COLUMN_NAME as name, COLUMN_TYPE as type, IS_NULLABLE as nullable from information_schema.COLUMNS
      where TABLE_SCHEMA = database() and TABLE_NAME = ${table} order by ORDINAL_POSITION`,
  );
  return rows.map(one => ({ name: one.name, type: String(one.type).toLowerCase(), nullable: one.nullable === 'YES' }));
}

/**
 * The column lists a table's unique indexes cover, each folded to lower case: what a declared `unique` is held
 * by, read off the index rather than off its name. The primary key is among them.
 */
export async function uniquesOf(db: Kysely<never>, table: string): Promise<string[][]> {
  const rows = await rowsOf(
    db,
    sql<{ index: string; name: string }>`
      select INDEX_NAME as \`index\`, COLUMN_NAME as name from information_schema.STATISTICS
      where TABLE_SCHEMA = database() and TABLE_NAME = ${table} and NON_UNIQUE = 0
      order by INDEX_NAME, SEQ_IN_INDEX`,
  );
  const byIndex = new Map<string, string[]>();
  for (const one of rows) byIndex.set(one.index, [...(byIndex.get(one.index) ?? []), String(one.name).toLowerCase()]);
  return [...byIndex.values()];
}

/** The columns of a table that hold another table's key through a foreign key, folded to lower case. */
export async function referencingOf(db: Kysely<never>, table: string): Promise<Set<string>> {
  const rows = await rowsOf(
    db,
    sql<{ name: string }>`
      select COLUMN_NAME as name from information_schema.KEY_COLUMN_USAGE
      where TABLE_SCHEMA = database() and TABLE_NAME = ${table} and REFERENCED_TABLE_NAME is not null`,
  );
  return new Set(rows.map(one => String(one.name).toLowerCase()));
}

/** The column that is a table's primary key, where it has one of a single column. */
export async function keyOf(db: Kysely<never>, table: string): Promise<string | undefined> {
  const rows = await rowsOf(
    db,
    sql<{ name: string }>`
      select COLUMN_NAME as name from information_schema.KEY_COLUMN_USAGE
      where TABLE_SCHEMA = database() and TABLE_NAME = ${table} and CONSTRAINT_NAME = 'PRIMARY'`,
  );
  return rows.length === 1 ? rows[0].name : undefined;
}

/** How many rows a table holds. */
export async function rowCount(db: Kysely<never>, table: string): Promise<number> {
  const rows = await rowsOf(db, sql<{ n: number }>`select count(*) as n from ${sql.id(table)}`);
  return Number(rows[0]?.n ?? 0);
}

/** The names of a table's indexes, the primary key's among them; none where there is no such table. */
export async function indexNamesOf(db: Kysely<never>, table: string): Promise<Set<string>> {
  const rows = await rowsOf(
    db,
    sql<{ index: string }>`select distinct INDEX_NAME as \`index\` from information_schema.STATISTICS
      where TABLE_SCHEMA = database() and TABLE_NAME = ${table}`,
  );
  return new Set(rows.map(one => one.index));
}

/** The columns one index of a table covers, in its order; none where the table has no such index. */
export async function indexColumnsOf(db: Kysely<never>, table: string, index: string): Promise<string[]> {
  const rows = await rowsOf(
    db,
    sql<{ name: string }>`select COLUMN_NAME as name from information_schema.STATISTICS
      where TABLE_SCHEMA = database() and TABLE_NAME = ${table} and INDEX_NAME = ${index} order by SEQ_IN_INDEX`,
  );
  return rows.map(one => one.name);
}
