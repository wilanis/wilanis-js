/**
 * What the catalog holds for a collection, lowered to the `Declared` the planner compares (RFC 0017). This is
 * the comparison RFC 0003 put in `ensure`, taken over: `ensure` asked "is this column the type the shape
 * says?" one column at a time and threw `drift`; here the whole table is read back as a declaration, and
 * whoever asked compares it with whatever they hold.
 *
 * It reads `information_schema.columns` for the fields, and `table_constraints` joined to `key_column_usage`
 * for the key, the uniques and the references -- the three views RFC 0017 names, and nothing outside them.
 */
import type { Declared, DeclaredField, FieldType } from '@wilanis/plugin-storage';
import { type Kysely, sql } from 'kysely';

/** One column as `information_schema.columns` reports it. */
export interface Column {
  column_name: string;
  data_type: string;
  is_nullable: string;
}

/** One column of one constraint, as the two views report it together. */
interface Held {
  constraint_name: string;
  constraint_type: string;
  column_name: string;
  ordinal_position: number;
  foreign_table: string | null;
}

/** The type a column of this database is, in the words every engine shares. A type nothing else fits is json. */
function fieldTypeOf(data: string): FieldType {
  if (data === 'text' || data === 'character varying' || data === 'character') return 'string';
  if (data === 'double precision' || data === 'numeric' || data === 'integer' || data === 'bigint') return 'number';
  if (data === 'boolean') return 'boolean';
  return 'json';
}

/**
 * Every column of a table, in the order it declares them, or nothing at all where the schema holds no such
 * table. This is the one query in this engine against `information_schema.columns`: RFC 0003's `ensure` made
 * its own and now reads this one, so what the catalog says a table is has one answer and not two.
 */
export async function columnsOf(db: Kysely<never>, schema: string, table: string): Promise<Column[] | undefined> {
  const answer = (await sql<Column>`
    select column_name, data_type, is_nullable
    from information_schema.columns
    where table_schema = ${schema} and table_name = ${table}
    order by ordinal_position
  `.execute(db)) as { rows: Column[] };
  return answer.rows.length ? answer.rows : undefined;
}

/**
 * Every constraint over a table, one row per column of one, with the table a foreign key points at. The join
 * is the one RFC 0017 names: `table_constraints` says what a constraint is and `key_column_usage` which
 * columns it is over, in the order it holds them, which is what makes a compound `unique` read back as a list.
 */
async function constraintsOf(db: Kysely<never>, schema: string, table: string): Promise<Held[]> {
  const answer = (await sql<Held>`
    select tc.constraint_name, tc.constraint_type, kcu.column_name, kcu.ordinal_position,
           ccu.table_name as foreign_table
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on kcu.constraint_name = tc.constraint_name and kcu.constraint_schema = tc.constraint_schema
    left join information_schema.constraint_column_usage ccu
      on ccu.constraint_name = tc.constraint_name and ccu.constraint_schema = tc.constraint_schema
      and tc.constraint_type = 'FOREIGN KEY'
    where tc.table_schema = ${schema} and tc.table_name = ${table}
      and tc.constraint_type in ('PRIMARY KEY', 'UNIQUE', 'FOREIGN KEY')
    order by tc.constraint_name, kcu.ordinal_position
  `.execute(db)) as { rows: Held[] };
  return answer.rows;
}

/** The columns of each constraint of one type, in the order the constraint holds them. */
function grouped(held: Held[], type: string): Map<string, Held[]> {
  const byName = new Map<string, Held[]>();
  for (const one of held.filter(row => row.constraint_type === type)) {
    const columns = byName.get(one.constraint_name) ?? [];
    columns.push(one);
    byName.set(one.constraint_name, columns);
  }
  return byName;
}

/** The column the primary key is over: what the collection is keyed by, as the catalog knows it. */
function keyOf(held: Held[]): string {
  const [first] = [...grouped(held, 'PRIMARY KEY').values()];
  return first?.[0]?.column_name ?? '';
}

/**
 * The `unique` lists the table holds, the primary key excluded -- the key is a `unique` the database keeps of
 * its own accord, and the store declares it as `key` and never as a `unique`, so reading it back as one would
 * make every recorded collection differ from every declared one.
 */
function uniquesOf(held: Held[]): string[][] {
  return [...grouped(held, 'UNIQUE').values()].map(columns => columns.map(one => one.column_name));
}

/** The references the table makes: the field that holds another table's key, and the table it points at. */
function refsOf(held: Held[]): Declared['refs'] {
  const refs: Declared['refs'] = {};
  for (const columns of grouped(held, 'FOREIGN KEY').values()) {
    const one = columns[0];
    if (one?.foreign_table) refs[one.column_name] = { collection: one.foreign_table, onRemove: 'refuse' };
  }
  return refs;
}

/** Every column as a field: the type it is kept in, and whether a row may leave it empty. */
function fieldsOf(columns: Column[]): Record<string, DeclaredField> {
  const fields: Record<string, DeclaredField> = {};
  for (const column of columns)
    fields[column.column_name] = { type: fieldTypeOf(column.data_type), required: column.is_nullable === 'NO' };
  return fields;
}

/**
 * What the catalog holds for one table, as a `Declared`, or nothing where the schema has no such table. The
 * key's column is `NOT NULL` in the database whatever the shape says, so a key read back is required, which is
 * what a lowered declaration says of it too.
 */
export async function inspectTable(db: Kysely<never>, schema: string, table: string): Promise<Declared | undefined> {
  const columns = await columnsOf(db, schema, table);
  if (!columns) return undefined;
  const held = await constraintsOf(db, schema, table);
  return { key: keyOf(held), fields: fieldsOf(columns), unique: uniquesOf(held), refs: refsOf(held) };
}
