/**
 * The scope as this engine keeps it (RFC 0015): a column beside the record, a predicate on every statement,
 * and a `unique` that holds within one scope rather than across every one of them -- the same promise the
 * memory and postgres engines keep, judged by the same shared cases.
 *
 * A scope column is not a field of the shape, so `columns.ts` never sees one and a record read back never
 * carries one. Which columns a collection is scoped by is not on `At` either: the contract hands a scope to
 * an operation and declares none. So the columns this engine keeps are the ones a scope names, and the table
 * gains them the first time one arrives (`scope-table.ts`), as the postgres engine's does.
 *
 * Row-level security has no SQLite counterpart, and the RFC would not use it if it had: the rule is enforced
 * once, here, where the statement is built.
 */
import type { At, Scope } from '@wilanis/plugin-storage';
import { type Expression, type ExpressionBuilder, type Kysely, sql } from 'kysely';
import { locked } from './handles.js';
import { folded } from './names.js';
import { addScope, lacking, namesOf } from './scope-table.js';

type Builder = ExpressionBuilder<never, never>;

/** The columns a scope names, folded as SQLite compares them, in the order the scope spells them. */
export const scopeColumns = (scope: Scope | undefined): string[] => Object.keys(scope ?? {}).map(folded);

/**
 * Every scope column as one condition: `<column> = ?` per column the scope names, joined. `undefined` is the
 * unscoped case and means every row -- a collection that declares none, and a view, which is the one declared
 * way across a scope -- so it is the condition that holds of every row, never one that matches nothing.
 * Saying it as `1` rather than as no predicate is what lets every statement carry the scope the same way.
 *
 * `of` qualifies each column with a table, which the `do update` of a replacing `put` reads as the row that
 * is already there rather than the one being written.
 */
export function within(eb: Builder, scope: Scope | undefined, of?: string): Expression<unknown> {
  const tests = Object.entries(scope ?? {}).map(([column, value]) =>
    eb(eb.ref((of ? `${of}.${column}` : column) as never), '=', value as never),
  );
  return tests.length ? (eb.and(tests as never) as never) : (sql<number>`1` as never);
}

/** The scope columns as a row is written with them: what `put` adds beside the record's own columns. */
export const scopeValues = (scope: Scope | undefined): Record<string, unknown> => ({ ...scope });

/** The words SQLite starts a refused unique with, before the columns it names. */
const UNIQUE = 'UNIQUE constraint failed:';

/**
 * A refused write's error with the scope columns taken out of the unique it names. A scoped unique is the
 * declared one with the scope in front (`tenant, url, method`), and the store declared `[url, method]`: the
 * error is handed on naming what the store declared, so the violation is answered in the store's words.
 * Anything that is not a unique refused under a scope is handed on as it came.
 */
export function withoutScope(error: unknown, scope: Scope | undefined): unknown {
  const columns = new Set(scopeColumns(scope));
  const message = String((error as { message?: unknown })?.message ?? '');
  if (!columns.size || !message.startsWith(UNIQUE)) return error;
  const named = message.slice(UNIQUE.length).split(',');
  const kept = named.filter(one => !columns.has(folded(one.trim().slice(one.trim().indexOf('.') + 1))));
  return { code: (error as { code?: unknown }).code, message: `${UNIQUE}${kept.join(',')}` };
}

/**
 * Where a scope is being kept. `db` is the handle the statements run on; `owner` is what this process's
 * memory of scoped tables is kept by, the handles of one load of the tree, so a reload never reads another's;
 * `lasting` says whether what is made here outlives the call, which is false inside a transaction -- a column
 * added there is undone by a rollback, so remembering it would leave this process sure of a column the file
 * no longer has.
 */
export interface Keeping {
  db: Kysely<never>;
  owner: object;
  lasting: boolean;
}

/**
 * The tables this load has already seen keep a scope, with the columns each has. A scope column is never
 * dropped within a load -- only a migration would, and that reloads the tree -- so a write to a warm table
 * costs no catalog read.
 */
const kept = new WeakMap<object, Map<string, Set<string>>>();

/** What a table is remembered under: the connection it is on and its name, folded. */
const memoOf = (at: At) => `${at.connection}/${folded(at.name)}`;

/**
 * Work that changes a table's definition, holding the handle alone: in a short transaction of its own that
 * takes the write lock, or, inside the caller's transaction, on its connection held for the whole of the work.
 * Either way no other statement on the handle lands between reading the columns and adding them, so two
 * first writes at once -- a map over rows -- take turns, and the second finds what the first made.
 */
function holding(on: Keeping, work: (held: Kysely<never>) => Promise<void>): Promise<void> {
  if (on.lasting) return locked(on.db, work);
  return on.db.connection().execute(held => work(held as Kysely<never>));
}

/** The scope added from the columns as they are once the handle is held, so only what is still missing is made. */
async function addUnderHold(held: Kysely<never>, at: At, scope: Scope): Promise<void> {
  const missing = lacking(scope, await namesOf(held, at.name));
  if (missing.length) await addScope(held, at, scope, missing);
}

/**
 * The table made ready to keep this scope: the columns it lacks added, every declared `unique` made again
 * within the scope, and the key indexed behind it. It does nothing for a table already known to keep every
 * column the scope names, which is every call after the first; nothing for a table not made yet, which
 * `ensure` makes; and the statements that follow carry the predicate whether or not this made anything.
 */
export async function keepScope(on: Keeping, at: At, scope: Scope | undefined): Promise<void> {
  const wanted = scopeColumns(scope);
  if (!scope || !wanted.length) return;
  const memo = kept.get(on.owner) ?? new Map<string, Set<string>>();
  kept.set(on.owner, memo);
  const known = memo.get(memoOf(at));
  if (known && wanted.every(column => known.has(column))) return;
  const has = await namesOf(on.db, at.name);
  if (!has.size) return;
  if (lacking(scope, has).length) await holding(on, held => addUnderHold(held, at, scope));
  if (on.lasting) memo.set(memoOf(at), new Set([...has, ...wanted]));
}
