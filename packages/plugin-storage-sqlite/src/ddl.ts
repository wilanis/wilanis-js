/**
 * A table as DDL spells it, from what the planner says a collection is (RFC 0017): the column each field type
 * is kept in, its `CHECK`, `NOT NULL`, the key and the references. A `create` step writes a new table with it,
 * and a rebuild (`rebuild.ts`) writes the table a step leaves behind. Both spell a column exactly as `ensure`
 * does, so a table made one way reads back the same as a table made the other.
 */
import type { Declared, FieldType } from '@wilanis/plugin-storage';
import { quoted } from './columns.js';
import { folded } from './names.js';

/** The column type each field type is kept in, as `columns.ts` maps a shape's field. */
const COLUMN: Record<FieldType, string> = { string: 'TEXT', number: 'REAL', boolean: 'INTEGER', json: 'TEXT' };

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

/** One column of a `CREATE TABLE`: its type, `NOT NULL`, the integer key, its `CHECK` and its reference. */
function clauseOf(column: Kept, layout: Layout): string {
  const isKey = same(column.name, layout.key);
  const notNull = column.required || isKey ? ' NOT NULL' : '';
  const key = layout.integerKey && isKey ? ' PRIMARY KEY' : '';
  const check = checkFor(column.name, column.type);
  const checked = check ? ` CHECK (${check})` : '';
  const to = referenceOf(layout.refs, column.name);
  const references = to ? ` REFERENCES ${quoted(to)} ON DELETE RESTRICT` : '';
  return `${quoted(column.name)} ${column.column}${notNull}${key}${checked}${references}`;
}

/** The `CREATE TABLE` a layout is, under a name. */
export function createTableSql(name: string, layout: Layout): string {
  const clauses = layout.columns.map(column => clauseOf(column, layout));
  if (!layout.integerKey) clauses.push(`PRIMARY KEY (${quoted(layout.key)})`);
  return `CREATE TABLE ${quoted(name)} (${clauses.join(', ')})`;
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
