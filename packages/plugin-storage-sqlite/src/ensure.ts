/**
 * What `Engine.ensure` does to the file: adds what the store declares and is not there, and refuses to change
 * anything that is. Additive everywhere, destructive nowhere, as the postgres engine's: a column of another
 * type, a column the shape no longer has, a reference SQLite could add only by rebuilding the table -- each is
 * `drift`, thrown rather than repaired, because what to do about it is a person's decision. A table and a column
 * are written by `ddl.ts`, the same text the planner writes, so a table `ensure` made reads back as its record.
 *
 * A `unique` is a unique index (`wl_u_` and a hash of the declaration), so it can be added to a table that is
 * already there, which a table constraint cannot; one the rows already there repeat is drift. A `refs` is a
 * column's `REFERENCES ... ON DELETE RESTRICT`, which SQLite takes only when the column is made -- in the
 * `CREATE TABLE`, or in the `ADD COLUMN` of a field the table did not have.
 *
 * Everything happens in one transaction, since SQLite's DDL is transactional: a drift half way through leaves
 * the file exactly as it was. The table `wilanis_keys` is made here too where the plugin's `keyType` is
 * `identity`, beside the collections, and never under `uuidv7`.
 *
 * A table that keeps a scope (RFC 0015, `scope-table.ts`) has columns no field of the shape has, `NOT NULL`.
 * `ensure` reads which they are off the scope's index and holds them as the scope rather than as drift, and
 * a `unique` declared after the table was scoped is made within the scope, as the ones before it were.
 *
 * This is not what `@storage/storage.port.json#ensure` reaches. That operation goes over RFC 0017's planner --
 * `recorded` and `inspect` against what the tree declares, classed by the *Guide* table, applied by `apply.ts`
 * -- as it does on postgres. What is left here serves the callers of `Engine.ensure` that remain: the shared
 * suite, which makes the tables its cases write into.
 */
import type { At, Declared, Made } from '@wilanis/plugin-storage';
import { type Kysely, sql } from 'kysely';
import { columnsOf, foreignKeysOf, hasTable, uniquesOf } from './catalog.js';
import { fieldsOf, quoted, storedOf } from './columns.js';
import { addColumnSql, createTableSql, type Kept, type Layout, layoutOf } from './ddl.js';
import { ensureKeys } from './keys.js';
import { scopedUniqueName, uniqueName } from './names.js';
import { scopeColumnsOf } from './scope-table.js';
import { isIdentity, type Settings } from './settings.js';

/** Whether two column lists are one constraint: the same columns, in any order, compared without case. */
const sameColumns = (left: string[], right: string[]) =>
  left.length === right.length && left.every(one => right.includes(one.toLowerCase()));

/** A collection as `ddl.ts` reads one: its fields in the order the shape declares them, its key and its references. */
function declaredFrom(at: At): Declared {
  const fields: Declared['fields'] = {};
  for (const field of fieldsOf(at.shape))
    fields[field.name] = { type: storedOf(field.name, field.type), required: field.required };
  const refs: Declared['refs'] = {};
  for (const ref of at.refs) refs[ref.field] = { collection: ref.to, onRemove: 'refuse' };
  return { key: at.key, fields, unique: at.unique, refs };
}

/** The table a collection is made as: SQLite's own integer key where the key is a number under `identity`. */
const layoutFor = (at: At, settings: Settings): Layout => layoutOf(declaredFrom(at), isIdentity(settings));

/** Create the table a collection is, with every column, the key and the references; answer how many columns. */
async function createTable(db: Kysely<never>, at: At, layout: Layout): Promise<number> {
  await sql.raw(createTableSql(at.name, layout)).execute(db);
  return layout.columns.length;
}

/**
 * Add a column the shape has and the table does not. SQLite adds a `NOT NULL` column only with a default, even
 * to an empty table, so a required field is added with the one the store declares for the rows already there,
 * and is drift without one however many rows there are. The default stays on the column, since SQLite cannot
 * drop one; nothing reads it, because a `put` always writes the whole record.
 */
async function addColumn(db: Kysely<never>, at: At, column: Kept, layout: Layout): Promise<void> {
  const has = Object.hasOwn(at.defaults ?? {}, column.name);
  if (column.required && !has)
    throw new Error(
      `drift: ${at.name}.${column.name} is required, and SQLite adds a required column only with a default, even ` +
        "to an empty table; declare one under the collection's defaults",
    );
  const fill = has ? at.defaults[column.name] : undefined;
  await sql.raw(addColumnSql(at.name, column, layout, fill)).execute(db);
}

/** What the table already has, held against what the shape says: anything that would have to change is drift. */
function judgeDrift(at: At, found: Map<string, { type: string; notnull: number }>, layout: Layout): void {
  for (const column of layout.columns) {
    const held = found.get(column.name.toLowerCase());
    if (held && held.type.toUpperCase() !== column.column)
      throw new Error(`drift: ${at.name}.${column.name} is ${held.type}, and the shape says ${column.column}`);
  }
  const declared = new Set(layout.columns.map(column => column.name.toLowerCase()));
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
 * reference made with its table or its column is a constraint made, and counted as one. The columns the table
 * keeps as a scope are set aside before the rest is judged: no field of the shape has one, and that is what
 * a scope column is, not a column the shape has lost.
 */
async function ensureOne(db: Kysely<never>, at: At, settings: Settings): Promise<Made> {
  const layout = layoutFor(at, settings);
  if (!(await hasTable(db, at.name)))
    return { collections: 1, columns: await createTable(db, at, layout), constraints: at.refs.length };
  const found = new Map((await columnsOf(db, at.name)).map(one => [one.name.toLowerCase(), one]));
  for (const column of await scopeColumnsOf(db, at)) found.delete(column.toLowerCase());
  judgeDrift(at, found, layout);
  await judgeReferences(db, at, new Set(found.keys()));
  const added = layout.columns.filter(column => !found.has(column.name.toLowerCase()));
  for (const column of added) await addColumn(db, at, column, layout);
  const referenced = added.filter(column => at.refs.some(ref => ref.field === column.name));
  return { collections: 0, columns: added.length, constraints: referenced.length };
}

/**
 * The index one declared `unique` is created as: over its fields alone on an unscoped table, and with the
 * scope columns in front of them on a scoped one, under the name `scope-table.ts` gives it. A unique declared
 * after the table gained its scope is then held within one scope exactly as one declared before it is.
 */
function uniqueOf(at: At, scoped: string[], fields: string[]): { name: string; over: string[] } {
  if (!scoped.length) return { name: uniqueName(at.name, fields), over: fields };
  return { name: scopedUniqueName(at.name, scoped, fields), over: [...scoped, ...fields] };
}

/**
 * Create the index one `unique` is, or refuse it as drift where rows the table already holds repeat it. SQLite
 * refuses such an index with `SQLITE_CONSTRAINT_UNIQUE` and makes nothing. The engine takes that refusal as the
 * answer rather than asking with a query of its own, so a `NULL`, which a unique index never holds against
 * another, counts exactly as SQLite counts it. The message names the fields the store declared, never the
 * scope columns in front of them.
 */
async function createUnique(
  db: Kysely<never>,
  at: At,
  fields: string[],
  index: { name: string; over: string[] },
): Promise<void> {
  const { name, over } = index;
  try {
    await sql
      .raw(`CREATE UNIQUE INDEX ${quoted(name)} ON ${quoted(at.name)} (${over.map(quoted).join(', ')})`)
      .execute(db);
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'SQLITE_CONSTRAINT_UNIQUE') throw error;
    const within = over.length > fields.length ? ' within one scope' : '';
    throw new Error(
      `drift: ${at.name} declares unique [${fields.join(', ')}], and rows the table already holds repeat ` +
        `it${within}; make them differ before ensure adds it`,
    );
  }
}

/**
 * Add the unique indexes a collection declares and its table does not hold yet; answer how many. A unique is
 * held when some unique index of the table covers exactly its columns, whatever that index is called -- on a
 * scoped table, its columns and the scope's, so the unscoped spelling is never put back beside the scoped one.
 */
async function addUniques(db: Kysely<never>, at: At): Promise<number> {
  const held = await uniquesOf(db, at.name);
  const scoped = await scopeColumnsOf(db, at);
  let made = 0;
  for (const fields of at.unique) {
    const index = uniqueOf(at, scoped, fields);
    if (held.some(columns => sameColumns(index.over, columns))) continue;
    await createUnique(db, at, fields, index);
    held.push(index.over.map(one => one.toLowerCase()));
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
  for (const at of collections) made.constraints += await addUniques(db, at);
  if (isIdentity(settings)) await ensureKeys(db);
  return made;
}
