/**
 * What a scope makes of a table (RFC 0015): a column beside the record, every declared `unique` held within the
 * scope rather than across it, and an index over the scope so a scoped read is one index read. `scoping.ts`
 * decides when this runs; this file is what it does to the table, and what `ensure` reads back to know which
 * columns are a scope.
 *
 * A scope column is a string or a number, as a field of a shape is, and `NOT NULL`, since every row of a scoped
 * collection belongs to one scope. A table with rows is refused as `drift`: a row written before the store
 * declared a scope belongs to no scope, and no declaration can say which one. RFC 0017's planner is where that
 * migration belongs. So a scope is only ever added to an empty table, which is what lets the same statement
 * narrow the strings a scoped `unique` holds: the scope takes its share of the index's 3072 bytes (`widthsOf`),
 * and no row is there to be cut.
 *
 * The scope index holds the scope columns alone. InnoDB puts the primary key at the end of every secondary
 * index already, so the index is `(tenant, id)` without spending the key's bytes a second time.
 *
 * Everything a scope costs is one `ALTER TABLE`. MySQL commits around every DDL statement, but one statement is
 * atomic in MySQL 8: a failure half way leaves the table as it was, never with the column and without the
 * scoped uniques that go with it.
 */
import type { At, Scope } from '@wilanis/plugin-storage';
import { type Kysely, type RawBuilder, sql } from 'kysely';
import { type Column, columnsOf, indexColumnsOf, indexNamesOf, rowCount } from './catalog.js';
import { columnTypeOf, declaredOf, type Field, fieldsOf, widthsOf } from './columns.js';
import { folded, quoted, refIndexName, scopedIndexName, scopedUniqueName, uniqueName } from './names.js';

/**
 * One scope column as the field the table keeps it in: a string or a number, required, named folded. The
 * checker refuses a read that types as anything else and the handlers judge the value at run time, so a value
 * of another type reaching here is a tree reloaded under a store that changed, and it says so.
 */
function scopeFieldOf(column: string, value: unknown): Field {
  if (typeof value === 'string') return { name: folded(column), type: { kind: 'string' }, required: true };
  if (typeof value === 'number') return { name: folded(column), type: { kind: 'number' }, required: true };
  throw new Error(`scope: '${column}' holds a string or a number, and this one is ${typeof value}`);
}

/** The columns a scope names as the fields the table keeps them in, in the order the scope spells them. */
export const scopeFieldsIn = (scope: Scope): Field[] =>
  Object.entries(scope).map(([column, value]) => scopeFieldOf(column, value));

/**
 * The columns a table keeps as a scope, read back as fields from the index this engine made over them. The
 * index is the record: a scope column is not a field of the shape, so nothing the tree declares says which
 * columns those are, and `ensure` would otherwise read one as a `NOT NULL` column the shape has lost. Each is a
 * number where its column is `double`, and a string otherwise, in the index's order, which is the scope's.
 */
export async function scopeFieldsOf(db: Kysely<never>, at: At): Promise<Field[]> {
  const names = await indexColumnsOf(db, at.name, scopedIndexName(at.name));
  if (!names.length) return [];
  const types = new Map((await columnsOf(db, at.name)).map(one => [one.name.toLowerCase(), one.type]));
  return names.map(name => ({
    name: folded(name),
    type: { kind: types.get(folded(name)) === 'double' ? 'number' : 'string' },
    required: true,
  }));
}

/** A column as `ADD` or `MODIFY` spells it: its type at the width `widthsOf` gave it, and `NOT NULL` where it is required. */
function definitionOf(at: At, field: Field, widths: Map<string, number>): string {
  const { column } = declaredOf(field, widths.get(field.name));
  const notNull = field.required || field.name === at.key ? ' NOT NULL' : '';
  return `${quoted(field.name)} ${column}${notNull}`;
}

/** A table with rows refused as `drift`, rather than its rows guessed into a scope. */
async function refuseRows(db: Kysely<never>, at: At, column: string): Promise<void> {
  const rows = await rowCount(db, at.name);
  if (rows)
    throw new Error(
      `drift: ${at.name} holds ${rows} row(s) and no '${column}' column, and a row written before the store was ` +
        'scoped belongs to no scope; hint: run wilanis migrate to plan what those rows become',
    );
}

/**
 * The strings already in the table that the scope's share of an index makes narrower: a field of a scoped
 * `unique`, and a scope column a wider scope now shares its index with. The table is empty, so no value is cut.
 * A `DEFAULT` the column carried is not said again: nothing reads one, since a `put` writes the whole record.
 */
function narrowed(at: At, has: Column[], scope: Field[], widths: Map<string, number>): string[] {
  const fields = [...fieldsOf(at.shape), ...scope];
  const types = new Map(has.map(one => [one.name.toLowerCase(), one.type]));
  return fields
    .filter(field => types.has(field.name.toLowerCase()))
    .filter(field => types.get(field.name.toLowerCase()) !== columnTypeOf(field.type, widths.get(field.name)))
    .map(field => `MODIFY COLUMN ${definitionOf(at, field, widths)}`);
}

/**
 * Every `unique` the store declares, made again with the scope columns in front of it, and the one it replaces
 * dropped: the unscoped one, or the one over a narrower scope where the collection gains a second column.
 * `[url, method]` taken under one tenant is then free under every other, which is what "judged within the
 * scope" means -- said once here rather than spelled into every index the store writes.
 */
function rescoped(at: At, before: string[], columns: string[], indexes: Set<string>): string[] {
  return at.unique.flatMap(fields => {
    const replaced = [uniqueName(at.name, fields), scopedUniqueName(at.name, before, fields)];
    const drops = replaced.filter(name => indexes.has(name)).map(name => `DROP INDEX ${quoted(name)}`);
    const over = [...columns, ...fields].map(quoted).join(', ');
    return [...drops, `ADD UNIQUE INDEX ${quoted(scopedUniqueName(at.name, columns, fields))} (${over})`];
  });
}

/**
 * An index over each `refs` field that a declared `unique` leads with, where the table has none yet. `ensure`
 * adds the uniques before the foreign keys, so MySQL takes such a unique as the foreign key's index and makes
 * none of its own. Once the scope stands in front of the unique it no longer leads with the field, and MySQL
 * refuses to drop it while the foreign key needs it. So the same `ALTER` gives the field an index first.
 */
function keptForRefs(at: At, indexes: Set<string>): string[] {
  return at.refs
    .filter(ref => at.unique.some(fields => fields[0] === ref.field))
    .filter(ref => !indexes.has(refIndexName(at.name, ref.field)))
    .map(ref => `ADD INDEX ${quoted(refIndexName(at.name, ref.field))} (${quoted(ref.field)})`);
}

/**
 * The index a scoped read is answered from, over every scope column. It is dropped and made again rather than
 * made only where it is missing, since a collection that gains a second scope column has to be indexed by
 * both, and one index by a fixed name is what tells `ensure` which columns are the scope.
 */
function reindexed(at: At, columns: string[], indexes: Set<string>): string[] {
  const name = quoted(scopedIndexName(at.name));
  const drop = indexes.has(scopedIndexName(at.name)) ? [`DROP INDEX ${name}`] : [];
  return [...drop, `ADD INDEX ${name} (${columns.map(quoted).join(', ')})`];
}

/**
 * The table made ready to keep this scope, from the columns as they are now: the columns it lacks added, the
 * strings the scope shares an index with narrowed, the uniques made again within the scope and the scope index
 * made, in one statement. Only a missing column is added, but the uniques and the index are over every column
 * the scope names -- a constraint within half a scope would hold across the other half, which is no scope.
 */
export async function addScope(db: Kysely<never>, at: At, scope: Scope): Promise<void> {
  const has = await columnsOf(db, at.name);
  const names = new Set(has.map(one => one.name.toLowerCase()));
  const fields = scopeFieldsIn(scope);
  const missing = fields.filter(field => !names.has(field.name));
  if (!has.length || !missing.length) return;
  await refuseRows(db, at, missing[0].name);
  const before = (await scopeFieldsOf(db, at)).map(field => field.name);
  const columns = fields.map(field => field.name);
  const widths = widthsOf(at, fields);
  const indexes = await indexNamesOf(db, at.name);
  const clauses = [
    ...narrowed(at, has, fields, widths),
    ...missing.map(field => `ADD COLUMN ${definitionOf(at, field, widths)}`),
    ...keptForRefs(at, indexes),
    ...rescoped(at, before, columns, indexes),
    ...reindexed(at, columns, indexes),
  ];
  await unchecked(db, sql.raw(`ALTER TABLE ${quoted(at.name)} ${clauses.join(', ')}`));
}

/**
 * Run one statement with the session's foreign-key checks off, and give the session back to the pool with the
 * checks it had. MySQL refuses to change a column a foreign key holds, even to narrow a `VARCHAR`, while the
 * checks are on, and a `refs` field in a scoped `unique` has to narrow. The table is empty, so no row can break a
 * reference, and the foreign key itself stays, with an index that leads with its column (`keptForRefs`). The
 * value is read and set back rather than set to `default`, which leaves this variable off in MySQL 8.0.16.
 */
async function unchecked(db: Kysely<never>, statement: RawBuilder<unknown>): Promise<void> {
  const { rows } = await sql<{ was: number }>`select @@session.foreign_key_checks as was`.execute(db);
  const was = Number(rows[0]?.was) === 0 ? 0 : 1;
  await sql`set session foreign_key_checks = 0`.execute(db);
  try {
    await statement.execute(db);
  } finally {
    await sql.raw(`set session foreign_key_checks = ${was}`).execute(db);
  }
}
