/**
 * What `Engine.ensure` does to the database: adds what the store declares and is not there, and refuses to
 * change anything that is. Additive everywhere, destructive nowhere, as the postgres and sqlite engines' are: a
 * column of another type, a column the shape no longer has, a required column a table full of rows would have
 * to be given a value for -- each is `drift`, thrown rather than repaired, because what to do about it is a
 * person's decision.
 *
 * The tables come first, then the unique indexes over them, then the foreign keys, since MySQL names the column
 * a foreign key points at and the table holding it has to be there. Every table is `ENGINE=InnoDB` and
 * `utf8mb4_bin`, named in the statement rather than left to the server's defaults.
 *
 * Nothing here is one transaction. MySQL commits before and after every DDL statement, which is why the kind
 * says `transactionalDdl: false`: a drift found half way leaves what was made before it made. The statements
 * run on the pool, never on a transaction's session, which a `CREATE` would commit.
 *
 * A table that keeps a scope (RFC 0015, `scope-table.ts`) has columns no field of the shape has, `NOT NULL`.
 * `ensure` reads which they are off the scope's index and holds them as the scope rather than as drift. They
 * take their share of every index they are in, so the widths it expects are the ones `widthsOf` gives with
 * the scope, and a `unique` declared after the table was scoped is made within the scope, as the ones before
 * it were. A declaration that would change a scope column's width is drift, as it is for a field's.
 */
import type { At, Made } from '@wilanis/plugin-storage';
import { type Kysely, sql } from 'kysely';
import { type Column, columnsOf, hasTable, keyOf, referencingOf, rowCount, uniquesOf } from './catalog.js';
import { columnTypeOf, declaredOf, type Field, fieldsOf, isJson, widthsOf } from './columns.js';
import { ensureKeys } from './keys.js';
import { quoted, refName, scopedUniqueName, uniqueName } from './names.js';
import { scopeFieldsOf } from './scope-table.js';
import { isIdentity, type Settings } from './settings.js';

/** What every table is created with: the storage engine `refs` and transactions need, and the binary collation. */
const TABLE_OPTIONS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin';

/** Run one statement this engine wrote out whole. */
const run = (db: Kysely<never>, statement: string) => sql.raw(statement).execute(db);

/** Whether two column lists are one constraint: the same columns, in any order, compared without case. */
const sameColumns = (left: string[], right: string[]) =>
  left.length === right.length && left.every(one => right.includes(one.toLowerCase()));

/** One column of a `CREATE TABLE`: its type, `NOT NULL` and its `CHECK`. */
function columnClause(at: At, field: Field, widths: Map<string, number>): string {
  const { column, check } = declaredOf(field, widths.get(field.name));
  const notNull = field.required || field.name === at.key ? ' NOT NULL' : '';
  return `${quoted(field.name)} ${column}${notNull}${check ? ` CHECK (${check})` : ''}`;
}

/** Create the table a collection is, with every column and the key; answer how many columns. */
async function createTable(db: Kysely<never>, at: At): Promise<number> {
  const widths = widthsOf(at);
  const fields = fieldsOf(at.shape);
  const clauses = fields.map(field => columnClause(at, field, widths));
  clauses.push(`PRIMARY KEY (${quoted(at.key)})`);
  await run(db, `CREATE TABLE ${quoted(at.name)} (${clauses.join(', ')}) ${TABLE_OPTIONS}`);
  return fields.length;
}

/**
 * A default as DDL spells it, in the expression form MySQL takes for every column type (8.0.13): a boolean as 0
 * or 1, JSON cast from its text, a string with its quotes and backslashes doubled.
 */
function literal(value: unknown, field: Field): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number' && !isJson(field.type)) return String(value);
  const text = (isJson(field.type) ? JSON.stringify(value) : String(value)).replace(/\\/g, '\\\\').replace(/'/g, "''");
  return isJson(field.type) ? `CAST('${text}' AS JSON)` : `'${text}'`;
}

/**
 * Add a column the shape has and the table does not. A required field is added with the default the store
 * declares for the rows already there; without one it is drift where the table holds rows, since MySQL would
 * give each an empty value no document wrote.
 */
async function addColumn(db: Kysely<never>, at: At, field: Field, widths: Map<string, number>): Promise<void> {
  const has = Object.hasOwn(at.defaults ?? {}, field.name);
  if (field.required && !has) {
    const rows = await rowCount(db, at.name);
    if (rows > 0)
      throw new Error(
        `drift: ${at.name}.${field.name} is required, the table holds ${rows} row(s), and no default says what ` +
          "they hold; declare one under the collection's defaults",
      );
  }
  const fill = has ? ` DEFAULT (${literal(at.defaults[field.name], field)})` : '';
  const { column, check } = declaredOf(field, widths.get(field.name));
  const clause = `${quoted(field.name)} ${column}${fill}${field.required ? ' NOT NULL' : ''}${check ? ` CHECK (${check})` : ''}`;
  await run(db, `ALTER TABLE ${quoted(at.name)} ADD COLUMN ${clause}`);
}

/**
 * The scope columns held against the width their share of the indexes gives them now. A `unique` declared after
 * the table was scoped holds the scope too, and may leave a string scope less room than it was made with: that
 * is drift, since narrowing a column the rows fill is a person's decision, as it is for a field.
 */
function judgeScope(at: At, columns: Column[], scope: Field[], widths: Map<string, number>): void {
  const types = new Map(columns.map(one => [one.name.toLowerCase(), one.type]));
  for (const field of scope) {
    const want = columnTypeOf(field.type, widths.get(field.name));
    if (types.get(field.name) !== want)
      throw new Error(
        `drift: ${at.name}.${field.name} is ${types.get(field.name)}, and the scope's share of the indexes that ` +
          `hold it says ${want}`,
      );
  }
}

/**
 * What the table already has, held against what the shape says: anything that would have to change is drift.
 * `found` holds the table's columns without its scope's.
 */
function judgeDrift(at: At, found: Map<string, Column>, widths: Map<string, number>): void {
  for (const field of fieldsOf(at.shape)) {
    const column = found.get(field.name.toLowerCase());
    const want = columnTypeOf(field.type, widths.get(field.name));
    if (column && column.type !== want)
      throw new Error(`drift: ${at.name}.${field.name} is ${column.type}, and the shape says ${want}`);
  }
  const declared = new Set(fieldsOf(at.shape).map(field => field.name.toLowerCase()));
  for (const [name, column] of found)
    if (!declared.has(name) && !column.nullable)
      throw new Error(`drift: ${at.name}.${name} is a column no field of the shape has, and it is not null`);
}

/**
 * One collection made ready: the table where there is none, the columns it has gained where there is one. The
 * columns the table keeps as a scope are set aside before the rest is judged: no field of the shape has one,
 * and that is what a scope column is, not a column the shape has lost.
 */
async function ensureOne(db: Kysely<never>, at: At): Promise<Made> {
  if (!(await hasTable(db, at.name))) return { collections: 1, columns: await createTable(db, at), constraints: 0 };
  const columns = await columnsOf(db, at.name);
  const scope = await scopeFieldsOf(db, at);
  const widths = widthsOf(at, scope);
  judgeScope(at, columns, scope, widths);
  const found = new Map(columns.map(one => [one.name.toLowerCase(), one]));
  for (const field of scope) found.delete(field.name);
  judgeDrift(at, found, widths);
  const added = fieldsOf(at.shape).filter(field => !found.has(field.name.toLowerCase()));
  for (const field of added) await addColumn(db, at, field, widths);
  return { collections: 0, columns: added.length, constraints: 0 };
}

/**
 * The index one declared `unique` is created as: over its fields alone on an unscoped table, and with the scope
 * columns in front of them on a scoped one, under the name `scope-table.ts` gives it. A unique declared after
 * the table gained its scope is then held within one scope exactly as one declared before it is.
 */
function uniqueOf(at: At, scope: string[], fields: string[]): { name: string; over: string[] } {
  if (!scope.length) return { name: uniqueName(at.name, fields), over: fields };
  return { name: scopedUniqueName(at.name, scope, fields), over: [...scope, ...fields] };
}

/**
 * Add the unique indexes a collection declares and its table does not hold yet; answer how many. A unique is
 * held when some unique index of the table covers exactly its columns, whatever that index is called -- on a
 * scoped table, its columns and the scope's, so the unscoped spelling is never put back beside the scoped one.
 */
async function addUniques(db: Kysely<never>, at: At): Promise<number> {
  const held = await uniquesOf(db, at.name);
  const scope = (await scopeFieldsOf(db, at)).map(field => field.name);
  let made = 0;
  for (const fields of at.unique) {
    const { name, over } = uniqueOf(at, scope, fields);
    if (held.some(columns => sameColumns(over, columns))) continue;
    await run(db, `CREATE UNIQUE INDEX ${quoted(name)} ON ${quoted(at.name)} (${over.map(quoted).join(', ')})`);
    held.push(over.map(one => one.toLowerCase()));
    made += 1;
  }
  return made;
}

/** Add the foreign keys a collection declares and its table does not hold yet, `ON DELETE RESTRICT`; answer how many. */
async function addRefs(db: Kysely<never>, at: At): Promise<number> {
  const held = await referencingOf(db, at.name);
  let made = 0;
  for (const ref of at.refs) {
    if (held.has(ref.field.toLowerCase())) continue;
    const key = await keyOf(db, ref.to);
    if (!key)
      throw new Error(`${at.name}.${ref.field} refs ${ref.to}, and the database holds no such table with a key`);
    await run(
      db,
      `ALTER TABLE ${quoted(at.name)} ADD CONSTRAINT ${quoted(refName(at.name, ref.field))} FOREIGN KEY ` +
        `(${quoted(ref.field)}) REFERENCES ${quoted(ref.to)} (${quoted(key)}) ON DELETE RESTRICT`,
    );
    made += 1;
  }
  return made;
}

/** Prepare every collection: the tables and columns, then the unique indexes, then the foreign keys. */
export async function ensureTables(db: Kysely<never>, collections: At[], settings: Settings): Promise<Made> {
  const made: Made = { collections: 0, columns: 0, constraints: 0 };
  for (const at of collections) {
    const one = await ensureOne(db, at);
    made.collections += one.collections;
    made.columns += one.columns;
  }
  for (const at of collections) made.constraints += await addUniques(db, at);
  for (const at of collections) made.constraints += await addRefs(db, at);
  if (isIdentity(settings)) await ensureKeys(db);
  return made;
}
