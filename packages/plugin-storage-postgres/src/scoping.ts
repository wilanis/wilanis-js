/**
 * The scope as this engine keeps it: a column beside the record, a predicate on every statement, and the
 * constraints that make a `unique` hold within one scope rather than across every one of them (RFC 0015).
 *
 * A scope column is not a field of the shape, so `columns.ts` never sees one and a record read back never
 * carries one. It is the store's word about who is calling, and this file is the whole of what PostgreSQL is
 * asked to do about it: `text` or `double precision` by what the read answers, `NOT NULL`, in front of every
 * declared `unique`, and indexed with the key so a scoped `get` is one index read.
 *
 * Row-level security is not used, and the RFC says why: a policy on the table would enforce the rule a second
 * time where neither the checker nor `describe` nor the viewer could see it, with a session variable the pool
 * would have to set and reset on every checkout, and the memory engine could not enforce it at all. The rule
 * is enforced once, here, where the statement is built.
 *
 * Which columns a collection is scoped by is not on `At`: the contract hands a scope to an operation and
 * declares none, exactly as the memory engine reads it. So the columns this engine keeps are the ones a
 * scope names, and the table gains them the first time one arrives -- under RFC 0003's own rule, additive on
 * an empty table and `drift` on one with rows, since a row without a tenant cannot be given one by a
 * declaration. RFC 0017's planner is where that migration belongs.
 */
import type { At, Scope } from '@wilanis/plugin-storage';
import { type Expression, type ExpressionBuilder, type Kysely, sql } from 'kysely';
import { folded } from './columns.js';
import { columnsOf } from './inspect.js';
import { scopedIndexName, scopedUniqueName, uniqueName } from './names.js';

type Builder = ExpressionBuilder<never, never>;

/**
 * Where a scope is being kept: the schema and the table, which every statement here names together.
 *
 * `lasting` says whether what this makes will still be there afterwards, which is false inside a transaction:
 * a scope column added there is undone by a rollback, so remembering it would leave this process sure of a
 * column the database no longer has.
 */
export interface Where {
  schema: string;
  table: string;
  lasting: boolean;
}

/** The columns a scope names, folded as the database keeps them, in the order the scope spells them. */
export const scopeColumns = (scope: Scope | undefined): string[] => Object.keys(scope ?? {}).map(folded);

/**
 * The column type one scope value is kept in: `text` for a string, `double precision` for a number, which are
 * the two a scope may be. The checker has already refused a read that types as anything else (C012), so a
 * value of another type reaching here is a tree reloaded under a store that changed, and it says so.
 */
export function scopeTypeOf(column: string, value: string | number): string {
  if (typeof value === 'string') return 'text';
  if (typeof value === 'number') return 'double precision';
  throw new Error(`scope: '${column}' holds a string or a number, and this one is ${typeof value}`);
}

/**
 * Every scope column as one condition: `<column> = $n` per column the scope names, joined. `undefined` is the
 * unscoped case and means every row -- a collection that declares none, and a view, which is the one declared
 * way across a scope -- so it is the condition that holds of every row and never an empty one that would
 * match nothing. Saying it as `true` rather than as an absent predicate is what lets every statement below
 * carry the scope the same way, so none of them can be built having forgotten it.
 *
 * `of` qualifies each column with a table, which the `on conflict do update` of a replacing `put` needs: a
 * bare column there stands between the row already kept and the `excluded` one being written, and Postgres
 * refuses it as ambiguous. Naming the table says the predicate is about the row that is there.
 */
export function within(eb: Builder, scope: Scope | undefined, of?: string): Expression<unknown> {
  const tests = Object.entries(scope ?? {}).map(([column, value]) =>
    eb(eb.ref((of ? `${of}.${folded(column)}` : folded(column)) as never), '=', sql`${value}` as never),
  );
  return tests.length ? (eb.and(tests as never) as never) : (sql<boolean>`true` as never);
}

/** The scope columns as a row is written with them: what `put` adds beside the record's own columns. */
export function scopeValues(scope: Scope | undefined): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(scope ?? {})) values[folded(column)] = value;
  return values;
}

/**
 * The columns of a table this engine keeps as a scope, read back from the index it created over them. The
 * index is the record: a scope column is not a field of the shape, so nothing the tree declares says which
 * columns those are, and `ensure` would otherwise read one as a `NOT NULL` column the shape has lost.
 *
 * It is the index and not a comment or a naming convention because the index has to be there anyway -- the
 * RFC asks for `(tenant, id)` so a scoped `get` is one index read -- and a fact already written is a better
 * record than a second one kept beside it. The key is in that index too and is taken out again here: it is a
 * field of the shape and was never a scope column. They come back in the index's order, which is the scope's,
 * since a scoped unique is named by its columns in that order.
 */
export async function scopeColumnsOf(
  db: Kysely<never>,
  at: At,
  where: { schema: string; table: string },
): Promise<Set<string>> {
  const found = (await sql<{ column_name: string }>`
    select a.attname as column_name
    from pg_index i
    join pg_class c on c.oid = i.indrelid
    join pg_class ic on ic.oid = i.indexrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum = any(i.indkey)
    where n.nspname = ${where.schema} and c.relname = ${where.table}
      and ic.relname = ${scopedIndexName(at.name)}
    order by array_position(i.indkey::smallint[], a.attnum)
  `.execute(db)) as { rows: { column_name: string }[] };
  const columns = new Set(found.rows.map(one => one.column_name));
  columns.delete(folded(at.key));
  return columns;
}

/** How many rows a table holds, which is what decides whether a column may still be added to it. */
async function rowsIn(db: Kysely<never>, schema: string, table: string): Promise<number> {
  const counted = (await sql<{ n: string }>`
    select count(*) as n from ${sql.ref(schema)}.${sql.ref(table)}
  `.execute(db)) as { rows: { n: string }[] };
  return Number(counted.rows[0]?.n ?? 0);
}

/**
 * One scope column added to a table that lacks it: `NOT NULL`, since every row of a scoped collection belongs
 * to one. A table with rows is refused as `drift` rather than filled with a guess -- a row written before the
 * store declared a scope belongs to no tenant, and no declaration can say which.
 */
async function addScopeColumn(db: Kysely<never>, where: Where, column: string, type: string): Promise<void> {
  const { schema, table } = where;
  const rows = await rowsIn(db, schema, table);
  if (rows)
    throw new Error(
      `drift: ${table} holds ${rows} row(s) and no '${column}' column, and a row written before the store was ` +
        `scoped belongs to no scope; hint: run wilanis migrate to plan what those rows become`,
    );
  await sql`
    alter table ${sql.ref(schema)}.${sql.ref(table)}
    add column ${sql.ref(column)} ${sql.raw(type)} not null
  `.execute(db);
}

/**
 * Every `unique` the store declares, created again with the scope columns in front of it and the unscoped one
 * dropped. `[url, method]` taken under one tenant is then free under every other, which is what "judged within
 * the scope" means -- said once here rather than spelled into every constraint the store writes.
 */
async function rescopeUniques(db: Kysely<never>, where: Where, at: At, columns: string[]): Promise<void> {
  const { schema, table } = where;
  const on = sql`${sql.ref(schema)}.${sql.ref(table)}`;
  for (const fields of at.unique) {
    const scoped = scopedUniqueName(at.name, columns, fields);
    const held = sql.join([...columns, ...fields.map(folded)].map(one => sql.ref(one)));
    await sql`alter table ${on} drop constraint if exists ${sql.ref(uniqueName(at.name, fields))}`.execute(db);
    await sql`alter table ${on} add constraint ${sql.ref(scoped)} unique (${held})`.execute(db);
  }
}

/**
 * The index a scoped read is answered from: the scope columns and the key together, so a `get` is one read.
 * It is dropped first rather than made only where it is missing, since a collection that gains a second scope
 * column has to be indexed by both, and one index by a fixed name is what lets the catalog say which columns
 * this engine keeps as a scope.
 */
async function indexScope(db: Kysely<never>, where: Where, at: At, columns: string[]): Promise<void> {
  const { schema, table } = where;
  const name = scopedIndexName(at.name);
  const over = sql.join([...columns, folded(at.key)].map(column => sql.ref(column)));
  await sql`drop index if exists ${sql.ref(schema)}.${sql.ref(name)}`.execute(db);
  await sql`create index ${sql.ref(name)} on ${sql.ref(schema)}.${sql.ref(table)} (${over})`.execute(db);
}

/**
 * The tables this process has already seen keep a scope, by connection and table, with the columns each has.
 * A scope column is never dropped -- only a migration would, and that reloads the tree -- so knowing a table
 * has one is knowledge that cannot go stale within a load, and a write to a warm table costs no catalog read.
 * It is keyed by the connection so two trees in one process, which a reload is, never read each other's.
 */
const kept = new Map<string, Set<string>>();

/** What a table is remembered under: the connection it is on and the table it is, which name it uniquely. */
const memoOf = (at: At, where: Where) => `${at.connection}/${where.schema}.${where.table}`;

/** The columns a table has, by name, or nothing at all where there is no such table yet. */
async function namesOf(db: Kysely<never>, where: Where): Promise<Set<string> | undefined> {
  const found = await columnsOf(db, where.schema, where.table);
  return found && new Set(found.map(column => column.column_name));
}

/** The scope's columns a table lacks, with the value that says what type each is kept in. */
const lacking = (wanted: [string, string | number][], has: Set<string>) =>
  wanted.filter(([column]) => !has.has(folded(column)));

/**
 * Work that changes a table's definition, run holding the table alone: in a transaction of its own, or in the
 * caller's where it runs inside one (`lasting` false), and behind an `access exclusive` lock either way. Two
 * first writes racing each other then take turns, and a failure half way through undoes the whole of it, so
 * a table is never left with the column and without the scoped uniques that go with it.
 */
async function holding<T>(db: Kysely<never>, where: Where, work: (db: Kysely<never>) => Promise<T>): Promise<T> {
  const locked = async (on: Kysely<never>) => {
    await sql`lock table ${sql.ref(where.schema)}.${sql.ref(where.table)} in access exclusive mode`.execute(on);
    return work(on);
  };
  if (!where.lasting) return locked(db);
  return db.transaction().execute(trx => locked(trx as never));
}

/**
 * The scope added under the lock, from the columns as they are once it is held rather than as they were
 * before: a caller that waited for it finds what the one ahead of it made, and adds only what is still missing.
 */
async function addUnderLock(db: Kysely<never>, where: Where, at: At, scope: Scope | undefined): Promise<boolean> {
  const has = (await namesOf(db, where)) ?? new Set<string>();
  const missing = lacking(Object.entries(scope ?? {}), has);
  if (missing.length) await addScope(db, where, at, { missing, columns: scopeColumns(scope) });
  return missing.length > 0;
}

/**
 * The table made ready to keep this scope: the columns it lacks added, every declared `unique` recreated
 * within the scope, and the key indexed behind it. It answers whether anything was made.
 *
 * It does nothing at all for a table already known to keep every column the scope names, which is every call
 * after the first -- so a scoped write costs one catalog read per table per load of the tree, and nothing
 * after that. Only a table that lacks a column is locked, and it is read again once the lock is held. The
 * statements that follow carry the predicate whether or not this made anything.
 */
export async function ensureScope(db: Kysely<never>, where: Where, at: At, scope: Scope | undefined): Promise<boolean> {
  const wanted = Object.entries(scope ?? {});
  if (!wanted.length) return false;
  const memo = memoOf(at, where);
  const known = kept.get(memo);
  if (known && wanted.every(([column]) => known.has(folded(column)))) return false;
  const has = await namesOf(db, where);
  if (!has) return false; // no table yet: `ensure` makes one, and the scope is added the first time it is written
  const made = lacking(wanted, has).length > 0 && (await holding(db, where, on => addUnderLock(on, where, at, scope)));
  if (where.lasting) kept.set(memo, new Set([...has, ...scopeColumns(scope)]));
  return made;
}

/**
 * The columns added, the uniques recreated within the scope and the index made: what a first scope costs.
 * Only `missing` is added as a column, but the unique and the index are over every column the scope names --
 * a constraint within half a scope would hold across the other half, which is not a scope at all.
 */
async function addScope(
  db: Kysely<never>,
  where: Where,
  at: At,
  by: { missing: [string, string | number][]; columns: string[] },
): Promise<void> {
  for (const [column, value] of by.missing) await addScopeColumn(db, where, folded(column), scopeTypeOf(column, value));
  await rescopeUniques(db, where, at, by.columns);
  await indexScope(db, where, at, by.columns);
}

/** Forget every table this process remembers keeping a scope: what a test that drops one has to say. */
export function forgetScopes(): void {
  kept.clear();
}
