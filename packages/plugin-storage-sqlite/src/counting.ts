/**
 * How many rows stand in a step's way: one `SELECT count(*)` shaped by the step (RFC 0017), as the postgres
 * engine counts. The count is what turns a step into a class -- `drop collection notes (17 rows)` is
 * destructive, and the same at 0 rows costs nothing -- and it is why a plan can be read before it runs.
 *
 * Two counts are SQLite's own. A `unique` counts rows as a unique index judges them: a row with an empty field
 * repeats nothing, since SQLite never holds one `NULL` against another, and on a scoped table rows repeat only
 * within one scope. And a `retype` counts the values `casts.ts` says no cast carries, since SQLite's own cast
 * never fails.
 */
import type { Step } from '@wilanis/plugin-storage';
import { type Kysely, type RawBuilder, sql } from 'kysely';
import { attempts, carries } from './casts.js';
import { columnsOf, keyOf } from './catalog.js';
import { quoted } from './columns.js';
import { scopeOf } from './scope-table.js';

/** One count, however it was shaped: the number, or zero where the query answered nothing. */
async function counted(db: Kysely<never>, query: RawBuilder<{ n: number }>): Promise<number> {
  const answer = await query.execute(db);
  return Number(answer.rows[0]?.n ?? 0);
}

/** A name as SQL spells it, for the parts of a count a builder cannot bind. */
const id = (name: string) => sql.raw(quoted(name));

/** Every row of a collection: what a `drop` would take with it, and what a required `add` has to fill. */
const all = (table: string) => sql<{ n: number }>`select count(*) as n from ${id(table)}`;

/** The rows that hold a value in a column, or that leave it empty: what a `remove` takes, what a `require` fills. */
const where = (table: string, column: string, empty: boolean) =>
  sql<{ n: number }>`select count(*) as n from ${id(table)} where ${id(column)} is ${sql.raw(empty ? '' : 'not ')}null`;

/**
 * The rows that repeat a `unique`: every row of every group of more than one, since each is a row that would
 * have to go before the constraint holds. The scope columns lead the group, and a row with an empty field is in
 * no group at all.
 */
function repeating(table: string, over: string[], scope: string[]) {
  const filled = sql.join(
    over.map(field => sql`${id(field)} is not null`),
    sql` and `,
  );
  const group = sql.join([...scope, ...over].map(id));
  return sql<{ n: number }>`
    select coalesce(sum(c), 0) as n from (
      select count(*) as c from ${id(table)} where ${filled} group by ${group} having count(*) > 1
    )
  `;
}

/** The rows whose reference points at no record of the other collection: what a `refs` cannot be added over. */
function dangling(table: string, at: { field: string; to: string; key: string }) {
  const held = sql`holder.${id(at.field)}`;
  const key = sql`target.${id(at.key)}`;
  return sql<{ n: number }>`
    select count(*) as n from ${id(table)} as holder left join ${id(at.to)} as target on ${key} = ${held}
    where ${held} is not null and ${key} is null
  `;
}

/**
 * The values a `retype` would lose: the rows whose value fails the test `casts.ts` writes for the pair, every
 * row holding a value where the engine does not attempt the pair, and none where every value carries.
 */
function uncastable(step: Step): RawBuilder<{ n: number }> | undefined {
  const column = step.at ?? '';
  if (!step.was || !step.becomes || !attempts(step.was, step.becomes)) return where(step.target, column, false);
  const test = carries(step.was, step.becomes, quoted(column));
  if (!test) return undefined;
  return sql<{ n: number }>`
    select count(*) as n from ${id(step.target)} where ${id(column)} is not null and not ${sql.raw(test)}
  `;
}

/** The count of a step about one column: what it holds, what it leaves empty, or what no cast would carry. */
function ofColumn(step: Step, column: string): RawBuilder<{ n: number }> | undefined {
  if (step.do === 'remove') return where(step.target, column, false);
  if (step.do === 'require') return where(step.target, column, true);
  if (step.do === 'add') return all(step.target);
  if (step.do === 'retype') return uncastable(step);
  return undefined;
}

/**
 * Whether a constraint is over a column the table does not have yet: one an `add` of the same plan makes, before
 * it. Every row leaves such a column empty, and an empty value repeats nothing and points at nothing, so no row
 * stands in the way -- and a count over the column would ask SQLite about a column it has never heard of.
 */
async function addedByThePlan(db: Kysely<never>, step: Step): Promise<boolean> {
  if (step.do !== 'unique' && step.do !== 'ref') return false;
  const over = step.do === 'unique' ? (step.over ?? []) : [step.at ?? ''];
  const has = new Set((await columnsOf(db, step.target)).map(one => one.name.toLowerCase()));
  return over.some(field => !has.has(field.toLowerCase()));
}

/**
 * How many rows stand in this step's way, as one count; zero for a step nothing can stand in the way of. A
 * `unique` reads the table's scope and a `ref` the key of the collection it points at off the catalog, so no
 * caller has to hand the engine the tree.
 */
export async function countFor(db: Kysely<never>, step: Step): Promise<number> {
  if (step.do === 'drop') return counted(db, all(step.target));
  if (await addedByThePlan(db, step)) return 0;
  if (step.do === 'unique' && step.over?.length) {
    const key = (await keyOf(db, step.target)) ?? '';
    return counted(db, repeating(step.target, step.over, await scopeOf(db, step.target, key)));
  }
  if (step.do === 'ref' && step.at && step.to) {
    const key = (await keyOf(db, step.to)) ?? 'id';
    return counted(db, dangling(step.target, { field: step.at, to: step.to, key }));
  }
  const query = step.at ? ofColumn(step, step.at) : undefined;
  return query ? counted(db, query) : 0;
}
