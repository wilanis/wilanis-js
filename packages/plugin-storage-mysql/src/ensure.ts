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
 */
import type { At, Made } from '@wilanis/plugin-storage';
import { type Kysely, sql } from 'kysely';
import { columnsOf, hasTable, keyOf, referencingOf, rowCount, uniquesOf } from './catalog.js';
import { columnTypeOf, declaredOf, type Field, fieldsOf, isJson, widthsOf } from './columns.js';
import { ensureKeys } from './keys.js';
import { quoted, refName, uniqueName } from './names.js';
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
async function addColumn(db: Kysely<never>, at: At, field: Field): Promise<void> {
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
  const { column, check } = declaredOf(field, widthsOf(at).get(field.name));
  const clause = `${quoted(field.name)} ${column}${fill}${field.required ? ' NOT NULL' : ''}${check ? ` CHECK (${check})` : ''}`;
  await run(db, `ALTER TABLE ${quoted(at.name)} ADD COLUMN ${clause}`);
}

/** What the table already has, held against what the shape says: anything that would have to change is drift. */
function judgeDrift(at: At, found: Map<string, { type: string; nullable: boolean }>): void {
  const widths = widthsOf(at);
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

/** One collection made ready: the table where there is none, the columns it has gained where there is one. */
async function ensureOne(db: Kysely<never>, at: At): Promise<Made> {
  if (!(await hasTable(db, at.name))) return { collections: 1, columns: await createTable(db, at), constraints: 0 };
  const found = new Map((await columnsOf(db, at.name)).map(one => [one.name.toLowerCase(), one]));
  judgeDrift(at, found);
  const added = fieldsOf(at.shape).filter(field => !found.has(field.name.toLowerCase()));
  for (const field of added) await addColumn(db, at, field);
  return { collections: 0, columns: added.length, constraints: 0 };
}

/** Add the unique indexes a collection declares and its table does not hold yet; answer how many. */
async function addUniques(db: Kysely<never>, at: At): Promise<number> {
  const held = await uniquesOf(db, at.name);
  let made = 0;
  for (const fields of at.unique) {
    if (held.some(columns => sameColumns(fields, columns))) continue;
    const over = fields.map(quoted).join(', ');
    await run(db, `CREATE UNIQUE INDEX ${quoted(uniqueName(at.name, fields))} ON ${quoted(at.name)} (${over})`);
    held.push(fields.map(one => one.toLowerCase()));
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
