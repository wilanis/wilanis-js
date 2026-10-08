/**
 * A table as DDL spells it, from what the planner says a collection is (RFC 0017): the column each field type
 * is kept in, its `CHECK`, `NOT NULL`, the key and the references. A `create` step writes a new table with it,
 * and a rebuild (`rebuild.ts`) writes the table a step leaves behind. `ensure` writes its tables with it too,
 * so a table made one way reads back the same as a table made the other.
 *
 * The map from a field type to its column, the text of each `CHECK` and the clause a column is written with live
 * here and nowhere else: `ensure.ts` makes its tables and adds its columns through them, `steps.ts` its creates
 * and adds, `rebuild.ts` its remade tables, and `inspect.ts` reads this same `CHECK` text back.
 */
import type { Declared, FieldType } from '@wilanis/plugin-storage';
import { folded } from './names.js';

/** The column type each field type is kept in. */
const COLUMN: Record<FieldType, string> = { string: 'TEXT', number: 'REAL', boolean: 'INTEGER', json: 'TEXT' };

/** An identifier as SQLite reads it whatever it spells: double-quoted, with any quote inside doubled. */
export const quoted = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** The column type a field of this type is kept in. */
export const columnFor = (type: FieldType): string => COLUMN[type];

/** The `CHECK` a column holds where its type holds more than the field may: 0 or 1 for a boolean, JSON text. */
export function checkFor(name: string, type: FieldType | undefined): string | undefined {
  if (type === 'boolean') return `${quoted(name)} IN (0, 1)`;
  if (type === 'json') return `json_valid(${quoted(name)})`;
  return undefined;
}

/** One column of a table, as a create or a rebuild makes it. */
export interface Kept {
  name: string;
  /** the field type it holds; absent for a scope column, which no field of the shape is */
  type?: FieldType;
  /** the SQLite column type it is declared with */
  column: string;
  required: boolean;
}

/** What a table is made of: its columns in order, the key, whether that is SQLite's own integer key, the references. */
export interface Layout {
  columns: Kept[];
  key: string;
  integerKey: boolean;
  refs: Declared['refs'];
}

/** Whether two names are one name, as SQLite compares identifiers. */
export const same = (left: string, right: string): boolean => folded(left) === folded(right);

/** The collection a column references, where the layout says it holds another collection's key. */
function referenceOf(refs: Declared['refs'], column: string): string | undefined {
  const field = Object.keys(refs).find(one => same(one, column));
  return field ? refs[field]?.collection : undefined;
}

/**
 * One column as DDL spells it: its type, the default the rows already there receive where it is added with
 * one, `NOT NULL`, the integer key, its `CHECK` and its reference.
 */
function clauseOf(column: Kept, layout: Layout, fill?: string): string {
  const isKey = same(column.name, layout.key);
  const filled = fill ? ` DEFAULT ${fill}` : '';
  const notNull = column.required || isKey ? ' NOT NULL' : '';
  const key = layout.integerKey && isKey ? ' PRIMARY KEY' : '';
  const check = checkFor(column.name, column.type);
  const checked = check ? ` CHECK (${check})` : '';
  const to = referenceOf(layout.refs, column.name);
  const references = to ? ` REFERENCES ${quoted(to)} ON DELETE RESTRICT` : '';
  return `${quoted(column.name)} ${column.column}${filled}${notNull}${key}${checked}${references}`;
}

/** The `CREATE TABLE` a layout is, under a name. */
export function createTableSql(name: string, layout: Layout): string {
  const clauses = layout.columns.map(column => clauseOf(column, layout));
  if (!layout.integerKey) clauses.push(`PRIMARY KEY (${quoted(layout.key)})`);
  return `CREATE TABLE ${quoted(name)} (${clauses.join(', ')})`;
}

/**
 * The `ALTER TABLE ... ADD COLUMN` that adds one column of a layout to the table in place, with the default
 * the rows already there receive where `fill` is one; `undefined` adds the column with none.
 */
export function addColumnSql(name: string, column: Kept, layout: Layout, fill: unknown): string {
  const filled = fill === undefined ? undefined : literal(fill, column.type);
  return `ALTER TABLE ${quoted(name)} ADD COLUMN ${clauseOf(column, layout, filled)}`;
}

/**
 * The layout a collection the plan creates is made with: every field in the order the tree declares it, and the
 * references it makes. The key is SQLite's own integer key where it is a number under `identity`, as `ensure`
 * makes it.
 */
export function layoutOf(declared: Declared, identity: boolean): Layout {
  const keyField = declared.fields[declared.key];
  const integerKey = identity && keyField?.type === 'number';
  const columns = Object.entries(declared.fields).map(([name, field]) => ({
    name,
    type: field.type,
    column: integerKey && name === declared.key ? 'INTEGER' : columnFor(field.type),
    required: field.required,
  }));
  return { columns, key: declared.key, integerKey, refs: declared.refs };
}

/**
 * A value as DDL spells it. A `DEFAULT`, or the value a `require` fills an empty row with, is part of the
 * statement rather than bound to it, so the literal is written out: a boolean as 0 or 1, JSON as its text, a
 * string with its quotes doubled.
 */
export function literal(value: unknown, type: FieldType | undefined): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean' && type !== 'json') return value ? '1' : '0';
  if (typeof value === 'number' && type !== 'json') return String(value);
  const text = type === 'json' ? JSON.stringify(value) : String(value);
  return `'${text.replace(/'/g, "''")}'`;
}
