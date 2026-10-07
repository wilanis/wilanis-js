/**
 * The scope as this engine keeps it (RFC 0015): a column beside the record, a predicate on every statement,
 * and a `unique` that holds within one scope rather than across every one of them -- the same promise the
 * memory, postgres and sqlite engines keep, judged by the same shared cases.
 *
 * A scope column is not a field of the shape, so `rows.ts` never selects one and a record read back never
 * carries one. Which columns a collection is scoped by is not on `At` either: the contract hands a scope to an
 * operation and declares none. So the columns this engine keeps are the ones a scope names, and the table gains
 * them the first time one arrives (`scope-table.ts`), as the other engines' do.
 *
 * The table is changed on the pool, never on a transaction's session, for the reason `ensure` runs there: MySQL
 * commits whatever transaction a session holds before an `ALTER`. A scope added for a transaction is therefore
 * kept whether the transaction commits or not, and a write that waits for it never commits half a run.
 *
 * That costs a transaction two things, both only at a table's first scoped operation, and both answered rather
 * than hung. A transaction that has already read or written the table holds it, so the `ALTER` cannot run: it
 * waits `WAIT_SECONDS` and the operation fails, naming why. And a transaction that has already read anything
 * holds a snapshot older than the table the `ALTER` rebuilt: the write lands, and MySQL refuses a later read of
 * that table in the same transaction with "Table definition has changed, please retry transaction". A run
 * retried after either finds the scope made.
 *
 * Row-level security has no MySQL counterpart, and the RFC would not use it if it had: the rule is enforced
 * once, here, where the statement is built.
 */
import type { At, Scope } from '@wilanis/plugin-storage';
import { type Expression, type ExpressionBuilder, type Kysely, sql } from 'kysely';
import { columnsOf } from './catalog.js';
import { folded } from './names.js';
import type { Pools } from './pools.js';
import { addScope } from './scope-table.js';

type Builder = ExpressionBuilder<never, never>;

/**
 * How long adding a scope waits before it fails: for another session adding the same table's scope, and then for
 * the table itself, which a transaction that has read or written it holds until it ends.
 */
const WAIT_SECONDS = 10;

/** What MySQL answers a statement that waited `lock_wait_timeout` for a lock (`ER_LOCK_WAIT_TIMEOUT`). */
const LOCK_WAIT_TIMEOUT = 1205;

/** The columns a scope names, folded as MySQL compares them, in the order the scope spells them. */
export const scopeColumns = (scope: Scope | undefined): string[] => Object.keys(scope ?? {}).map(folded);

/**
 * Every scope column as one condition: `<column> = ?` per column the scope names, joined. `undefined` is the
 * unscoped case and means every row -- a collection that declares none, and a view, which is the one declared
 * way across a scope -- so it is the condition that holds of every row, never one that matches nothing.
 * Saying it as `true` rather than as no predicate is what lets every statement carry the scope the same way.
 */
export function within(eb: Builder, scope: Scope | undefined): Expression<unknown> {
  const tests = Object.entries(scope ?? {}).map(([column, value]) =>
    eb(eb.ref(folded(column) as never), '=', value as never),
  );
  return tests.length ? (eb.and(tests as never) as never) : (sql<boolean>`true` as never);
}

/** The scope columns as a row is written with them: what `put` adds beside the record's own columns. */
export function scopeValues(scope: Scope | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(scope ?? {}).map(([column, value]) => [folded(column), value]));
}

/**
 * An `ALTER` that waited too long for its table, said as what holds the table. The scope is added on a session of
 * its own, so a transaction that already read or wrote the table keeps it from the `ALTER` its own operation is
 * waiting for: without the bound the two would wait on each other for MySQL's default year.
 */
function waited(error: unknown, at: At): unknown {
  if ((error as { errno?: unknown }).errno !== LOCK_WAIT_TIMEOUT) return error;
  return new Error(
    `scope: waited ${WAIT_SECONDS}s to add a scope to ${at.name}, which a transaction holds; a transaction that ` +
      `reads ${at.name} before its first scoped operation holds it until it ends, and MySQL adds the scope on ` +
      'another session, since it commits before DDL; hint: retry once the transaction has ended',
  );
}

/**
 * Work that changes a table's definition, on one session of the pool holding a lock named after the database
 * and the table. MySQL takes no table lock across an `ALTER` the way PostgreSQL's `LOCK TABLE` does, and its
 * DDL commits any transaction it would run in; a named lock is server-wide, so two first writes at once, of
 * this process or of another, take turns, and the second finds what the first made. The session waits for the
 * table no longer than `WAIT_SECONDS`, and is given back with the server's wait.
 */
function holding(db: Kysely<never>, at: At, work: (held: Kysely<never>) => Promise<void>): Promise<void> {
  const name = sql`left(concat('wl_scope_', sha2(concat(database(), '.', ${at.name}), 256)), 64)`;
  return db.connection().execute(async held => {
    const got = await sql<{ got: number | null }>`select get_lock(${name}, ${WAIT_SECONDS}) as got`.execute(held);
    if (Number(got.rows[0]?.got) !== 1)
      throw new Error(`scope: waited ${WAIT_SECONDS}s for another writer adding a scope to ${at.name}`);
    try {
      await sql.raw(`set session lock_wait_timeout = ${WAIT_SECONDS}`).execute(held);
      await work(held as Kysely<never>);
    } catch (error) {
      throw waited(error, at);
    } finally {
      await sql`set session lock_wait_timeout = default`.execute(held);
      await sql`select release_lock(${name})`.execute(held);
    }
  });
}

/** What a table is remembered under: the connection it is on and its name, folded. */
const memoOf = (at: At) => `${at.connection}/${folded(at.name)}`;

/**
 * The table made ready to keep this scope: the columns it lacks added, every declared `unique` made again
 * within the scope, and the scope indexed. It does nothing for a table this load already knows keeps every
 * column the scope names, which is every call after the first; nothing for a table not made yet, which
 * `ensure` makes; and the statements that follow carry the predicate whether or not this made anything.
 *
 * What this load knows is kept on its pools (`Pools.scoped`), so a reload reads the catalog again. A scope
 * column is never dropped within a load -- only a migration would, and that reloads the tree.
 */
export async function keepScope(pools: Pools, at: At, scope: Scope | undefined): Promise<void> {
  const wanted = scopeColumns(scope);
  if (!scope || !wanted.length) return;
  const known = pools.scoped.get(memoOf(at));
  if (known && wanted.every(column => known.has(column))) return;
  const db = pools.for(at);
  const has = new Set((await columnsOf(db, at.name)).map(one => one.name.toLowerCase()));
  if (!has.size) return;
  if (wanted.some(column => !has.has(column))) await holding(db, at, held => addScope(held, at, scope));
  pools.scoped.set(memoOf(at), new Set([...has, ...wanted]));
}
