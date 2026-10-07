/**
 * What the file holds for a collection, read back from SQLite's own catalog (RFC 0017): as the `Declared` the
 * planner compares, and as the whole table a rebuild remakes. `inspect` answers the first, and `rebuild.ts`
 * reads the second, so what the catalog says a table is has one reading and not two.
 *
 * SQLite keeps fewer column types than a shape has field types, so the type alone does not say what a field
 * is: a boolean is an `INTEGER` and JSON is `TEXT`. The `CHECK` this engine writes beside each is what tells
 * them apart, and it is read off the table's own `CREATE TABLE` text, which SQLite keeps up to date as
 * columns are added and renamed. The columns a table keeps as a scope (RFC 0015) are read off the scope's
 * index, as `ensure` reads them, and are no field: the record never names one.
 */
import type { Declared, DeclaredField, FieldType } from '@wilanis/plugin-storage';
import { type Kysely, sql } from 'kysely';
import { type Column, columnsOf, foreignKeysOf, indexColumnsOf } from './catalog.js';
import { type Kept, type Layout, same } from './ddl.js';
import { scopedIndexName } from './names.js';

/** One index over a table: its name, whether it is unique, whether it is the primary key's, its columns, its DDL. */
export interface Index {
  name: string;
  unique: boolean;
  pk: boolean;
  columns: string[];
  /** the `CREATE INDEX` it was made with; absent for an index SQLite made for a constraint of the table */
  sql?: string;
}

/** A table as the catalog holds it: its layout, its name as the file spells it, its scope and its indexes. */
export interface Table extends Layout {
  name: string;
  scope: string[];
  indexes: Index[];
}

/** The table's name as the file spells it and its `CREATE TABLE` text, or nothing where there is no such table. */
async function definitionOf(db: Kysely<never>, table: string): Promise<{ name: string; sql: string } | undefined> {
  const rows = await sql<{ name: string; sql: string }>`
    select name, sql from sqlite_master where type = 'table' and name = ${table} collate nocase
  `.execute(db);
  return rows.rows[0];
}

/** A name as a pattern matches it in DDL: double-quoted with its quotes doubled, or bare and not part of a longer word. */
function spelled(name: string): string {
  const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `(?:"${escaped(name.replace(/"/g, '""'))}"|(?<![\\w"])${escaped(name)}(?![\\w"]))`;
}

/** Whether the table's DDL holds the `CHECK` this engine writes for JSON, or for a boolean, over a column. */
const checksJson = (ddl: string, name: string) =>
  new RegExp(`json_valid\\s*\\(\\s*${spelled(name)}\\s*\\)`, 'i').test(ddl);
const checksBoolean = (ddl: string, name: string) =>
  new RegExp(`${spelled(name)}\\s+IN\\s*\\(\\s*0\\s*,\\s*1\\s*\\)`, 'i').test(ddl);

/**
 * The field type a column holds, in the words every engine shares: the `CHECK` first, then SQLite's own rules
 * of affinity for a column this engine did not make. A type nothing else fits is JSON.
 */
function fieldTypeOf(column: Column, ddl: string): FieldType {
  if (checksJson(ddl, column.name)) return 'json';
  if (checksBoolean(ddl, column.name)) return 'boolean';
  const type = column.type.toUpperCase();
  if (/INT|REAL|FLOA|DOUB|NUM/.test(type)) return 'number';
  if (type.includes('BOOL')) return 'boolean';
  if (/CHAR|CLOB|TEXT/.test(type)) return 'string';
  return 'json';
}

/** Every index over a table, with the columns it covers and the DDL it was made with. */
async function indexesOf(db: Kysely<never>, table: string): Promise<Index[]> {
  const listed = await sql<{ name: string; unique: number; origin: string; sql: string | null }>`
    select l.name, l."unique", l.origin, m.sql from pragma_index_list(${table}) l
    left join sqlite_master m on m.type = 'index' and m.name = l.name
  `.execute(db);
  const out: Index[] = [];
  for (const one of listed.rows)
    out.push({
      name: one.name,
      unique: one.unique === 1,
      pk: one.origin === 'pk',
      columns: await indexColumnsOf(db, one.name),
      sql: one.sql ?? undefined,
    });
  return out;
}

/** The references a table makes: the column that holds another table's key, and the table it names. */
async function refsOf(db: Kysely<never>, table: string): Promise<Declared['refs']> {
  const refs: Declared['refs'] = {};
  for (const one of await foreignKeysOf(db, table)) refs[one.from] = { collection: one.table, onRemove: 'refuse' };
  return refs;
}

/** The columns the scope's index covers beside the key: what the table keeps as a scope, in the scope's order. */
function scopeIn(indexes: Index[], table: string, key: string): string[] {
  const index = indexes.find(one => same(one.name, scopedIndexName(table)));
  return (index?.columns ?? []).filter(one => !same(one, key));
}

/** One column as a rebuild keeps it: a field with the type it holds, or a scope column, which holds none. */
function keptOf(column: Column, ddl: string, at: { key: string; scope: string[] }): Kept {
  const required = column.notnull === 1 || same(column.name, at.key);
  if (at.scope.some(one => same(one, column.name))) return { name: column.name, column: column.type, required };
  return { name: column.name, type: fieldTypeOf(column, ddl), column: column.type, required };
}

/** The whole of a table as the catalog holds it, or nothing where the file has no such table. */
export async function readTable(db: Kysely<never>, table: string): Promise<Table | undefined> {
  const held = await definitionOf(db, table);
  if (!held) return undefined;
  const columns = await columnsOf(db, held.name);
  const keyed = columns.filter(one => one.pk > 0);
  const key = keyed.length === 1 ? keyed[0].name : '';
  const indexes = await indexesOf(db, held.name);
  const scope = scopeIn(indexes, held.name, key);
  return {
    name: held.name,
    columns: columns.map(one => keptOf(one, held.sql, { key, scope })),
    key,
    integerKey: keyed.length === 1 && keyed[0].type.toUpperCase() === 'INTEGER',
    refs: await refsOf(db, held.name),
    scope,
    indexes,
  };
}

/**
 * The `unique` lists a table holds, as the store declares them: every unique index but the primary key's, its
 * scope columns taken out, since a scoped unique is the declared one with the scope in front.
 */
function uniquesOf(table: Table): string[][] {
  const lists = new Map<string, string[]>();
  for (const index of table.indexes.filter(one => one.unique && !one.pk)) {
    const fields = index.columns.filter(column => !table.scope.some(one => same(one, column)));
    lists.set(fields.join(','), fields);
  }
  return [...lists.values()];
}

/** A table read back as the planner's `Declared`: its fields, its key, its uniques and its references. */
export function declaredOfTable(table: Table): Declared {
  const fields: Record<string, DeclaredField> = {};
  for (const column of table.columns)
    if (column.type) fields[column.name] = { type: column.type, required: column.required };
  return { key: table.key, fields, unique: uniquesOf(table), refs: table.refs };
}

/** What the catalog holds for one collection, as a `Declared`, or nothing where the file has no such table. */
export async function inspectTable(db: Kysely<never>, table: string): Promise<Declared | undefined> {
  const held = await readTable(db, table);
  return held ? declaredOfTable(held) : undefined;
}
