/**
 * What `Engine.ensure` does to the file: adds what the store declares and is not there, and refuses to change
 * anything that is. Additive everywhere, destructive nowhere, as the postgres engine's: a column of another
 * type, a column the shape no longer has, a reference SQLite could add only by rebuilding the table -- each is
 * `drift`, thrown rather than repaired, because what to do about it is a person's decision.
 *
 * A `unique` is a unique index named after the declaration (`wl_u_<collection>_<fields>`), so it can be added
 * to a table that is already there, which a table constraint cannot. A `refs` is a column's `REFERENCES ...
 * ON DELETE RESTRICT`, which SQLite takes only when the column is made -- in the `CREATE TABLE`, or in the
 * `ADD COLUMN` of a field the table did not have.
 *
 * Everything happens in one transaction, since SQLite's DDL is transactional: a drift half way through leaves
 * the file exactly as it was. The table `wilanis_keys` is made here too where the plugin's `keyType` is
 * `identity`, beside the collections, and never under `uuidv7`.
 */
import type { At, Made } from '@wilanis/plugin-storage';
import { type Kysely, sql } from 'kysely';
import { columnsOf, foreignKeysOf, hasTable, indexes, rowCount } from './catalog.js';
import { declaredOf, type Field, fieldsOf, isJson, quoted } from './columns.js';
import { ensureKeys } from './keys.js';
import { isIdentity, type Settings } from './settings.js';

/** The name a unique index is created under, by the collection and the fields it holds together. */
export const uniqueName = (collection: string, fields: string[]) => `wl_u_${collection}_${fields.join('_')}`;

/** Whether a field is the key and kept as SQLite's own integer key: a number key under `identity`. */
const integerKey = (at: At, field: Field, settings: Settings) =>
  field.name === at.key && field.type.kind === 'number' && isIdentity(settings);

/** The column type a field is created with: `INTEGER` for an integer key, its declared column otherwise. */
const typeIn = (at: At, field: Field, settings: Settings) =>
  integerKey(at, field, settings) ? 'INTEGER' : declaredOf(field.name, field.type).column;

/** The `REFERENCES` clause a field carries where the collection declares it holds another's key. */
function referenceOf(at: At, field: Field): string {
  const ref = at.refs.find(one => one.field === field.name);
  return ref ? ` REFERENCES ${quoted(ref.to)} ON DELETE RESTRICT` : '';
}

/** One column of a `CREATE TABLE`: its type, `NOT NULL`, the key, its `CHECK` and its reference. */
function columnClause(at: At, field: Field, settings: Settings): string {
  const { check } = declaredOf(field.name, field.type);
  const notNull = field.required || field.name === at.key ? ' NOT NULL' : '';
  const key = integerKey(at, field, settings) ? ' PRIMARY KEY' : '';
  const checked = check ? ` CHECK (${check})` : '';
  return `${quoted(field.name)} ${typeIn(at, field, settings)}${notNull}${key}${checked}${referenceOf(at, field)}`;
}

/** Create the table a collection is, with every column, the key and the references; answer how many columns. */
async function createTable(db: Kysely<never>, at: At, settings: Settings): Promise<number> {
  const fields = fieldsOf(at.shape);
  const clauses = fields.map(field => columnClause(at, field, settings));
  const keyField = fields.find(field => field.name === at.key);
  if (!keyField || !integerKey(at, keyField, settings)) clauses.push(`PRIMARY KEY (${quoted(at.key)})`);
  await sql.raw(`CREATE TABLE ${quoted(at.name)} (${clauses.join(', ')})`).execute(db);
  return fields.length;
}

/**
 * A default as DDL spells it. A `DEFAULT` is part of the statement rather than a value bound to it, so the
 * literal is written out: a boolean as 0 or 1, JSON as its text, a string with its quotes doubled.
 */
function literal(value: unknown, field: Field): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number' && !isJson(field.type)) return String(value);
  const text = isJson(field.type) ? JSON.stringify(value) : String(value);
  return `'${text.replace(/'/g, "''")}'`;
}

/**
 * Add a column the shape has and the table does not. SQLite adds a `NOT NULL` column only with a default, so a
 * required field is added with the one the store declares for the rows already there, and is drift without
 * one. The default stays on the column, since SQLite cannot drop one; nothing reads it, because a `put` always
 * writes the whole record.
 */
async function addColumn(db: Kysely<never>, at: At, field: Field): Promise<void> {
  const { column, check } = declaredOf(field.name, field.type);
  const has = Object.hasOwn(at.defaults ?? {}, field.name);
  if (field.required && !has) {
    const rows = await rowCount(db, at.name);
    throw new Error(
      `drift: ${at.name}.${field.name} is required, the table holds ${rows} row(s), and SQLite adds a required ` +
        "column only with a default; declare one under the collection's defaults",
    );
  }
  const fill = has ? ` DEFAULT ${literal(at.defaults[field.name], field)}` : '';
  const notNull = field.required ? ' NOT NULL' : '';
  const checked = check ? ` CHECK (${check})` : '';
  const clause = `${quoted(field.name)} ${column}${fill}${notNull}${checked}${referenceOf(at, field)}`;
  await sql.raw(`ALTER TABLE ${quoted(at.name)} ADD COLUMN ${clause}`).execute(db);
}

/** What the table already has, held against what the shape says: anything that would have to change is drift. */
function judgeDrift(at: At, found: Map<string, { type: string; notnull: number }>, settings: Settings): void {
  for (const field of fieldsOf(at.shape)) {
    const column = found.get(field.name.toLowerCase());
    const want = typeIn(at, field, settings);
    if (column && column.type.toUpperCase() !== want)
      throw new Error(`drift: ${at.name}.${field.name} is ${column.type}, and the shape says ${want}`);
  }
  const declared = new Set(fieldsOf(at.shape).map(field => field.name.toLowerCase()));
  for (const [name, column] of found)
    if (!declared.has(name) && column.notnull)
      throw new Error(`drift: ${at.name}.${name} is a column no field of the shape has, and it is not null`);
}

/** A reference the collection declares over a column the table already had, which SQLite cannot add in place. */
async function judgeReferences(db: Kysely<never>, at: At, existed: Set<string>): Promise<void> {
  const held = new Set((await foreignKeysOf(db, at.name)).map(one => one.from.toLowerCase()));
  for (const ref of at.refs)
    if (existed.has(ref.field.toLowerCase()) && !held.has(ref.field.toLowerCase()))
      throw new Error(
        `drift: ${at.name}.${ref.field} gains a reference to ${ref.to}, and SQLite adds one to a column only by ` +
          'rebuilding the table, which ensure does not do',
      );
}

/**
 * One collection made ready: the table where there is none, the columns it has gained where there is one. A
 * reference made with its table or its column is a constraint made, and counted as one.
 */
async function ensureOne(db: Kysely<never>, at: At, settings: Settings): Promise<Made> {
  if (!(await hasTable(db, at.name)))
    return { collections: 1, columns: await createTable(db, at, settings), constraints: at.refs.length };
  const found = new Map((await columnsOf(db, at.name)).map(one => [one.name.toLowerCase(), one]));
  judgeDrift(at, found, settings);
  await judgeReferences(db, at, new Set(found.keys()));
  const added = fieldsOf(at.shape).filter(field => !found.has(field.name.toLowerCase()));
  for (const field of added) await addColumn(db, at, field);
  const referenced = added.filter(field => at.refs.some(ref => ref.field === field.name));
  return { collections: 0, columns: added.length, constraints: referenced.length };
}

/** Add the unique indexes a collection declares and the file does not hold yet; answer how many. */
async function addUniques(db: Kysely<never>, at: At, held: Set<string>): Promise<number> {
  let made = 0;
  for (const fields of at.unique) {
    const name = uniqueName(at.name, fields);
    if (held.has(name.toLowerCase())) continue;
    const over = fields.map(quoted).join(', ');
    await sql.raw(`CREATE UNIQUE INDEX ${quoted(name)} ON ${quoted(at.name)} (${over})`).execute(db);
    held.add(name.toLowerCase());
    made += 1;
  }
  return made;
}

/**
 * Prepare every collection: the tables and columns first, then the unique indexes over them, all on `db` --
 * which the caller has put inside one transaction, so a drift leaves the file as it was.
 */
export async function ensureTables(db: Kysely<never>, collections: At[], settings: Settings): Promise<Made> {
  const made: Made = { collections: 0, columns: 0, constraints: 0 };
  for (const at of collections) {
    const one = await ensureOne(db, at, settings);
    made.collections += one.collections;
    made.columns += one.columns;
    made.constraints += one.constraints;
  }
  const held = await indexes(db);
  for (const at of collections) made.constraints += await addUniques(db, at, held);
  if (isIdentity(settings)) await ensureKeys(db);
  return made;
}
