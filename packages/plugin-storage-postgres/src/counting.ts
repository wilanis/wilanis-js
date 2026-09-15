/**
 * How many rows stand in a step's way: one `SELECT count(*)` shaped by the step (RFC 0017). The count is what
 * turns a step into a class -- `drop collection notes (17 rows)` is destructive and `drop collection notes (0
 * rows)` costs nothing -- and it is the reason a plan can be read before it runs rather than failing at
 * `COMMIT`.
 *
 * One query per step that needs one, and none for a step no count can change. What each query counts is the
 * question the step asks: rows of the table, rows holding a value, rows repeating a `unique`, rows pointing at
 * nothing, rows no cast would carry.
 */
import type { Step } from '@wilanis/plugin-storage';
import { type Kysely, type RawBuilder, sql } from 'kysely';
import { type Counting, castTo } from './casts.js';
import { folded } from './columns.js';

/** One count, however it was shaped: the number, or zero where the query answered nothing. */
async function counted(db: Kysely<never>, query: RawBuilder<{ n: string | number }>): Promise<number> {
  const answer = (await query.execute(db)) as { rows: { n: string | number }[] };
  return Number(answer.rows[0]?.n ?? 0);
}

/** The table one step is about, qualified by the connection's schema. */
const tableOf = (schema: string, name: string) => sql`${sql.ref(schema)}.${sql.ref(folded(name))}`;

/** Every row of a collection: what a `drop` would take with it. */
const all = (schema: string, name: string) =>
  sql<{ n: string | number }>`select count(*) as n from ${tableOf(schema, name)}`;

/** The rows that hold a value in a column: what a `remove` would take, and what a `retype` would have to cast. */
function holding(schema: string, name: string, column: string) {
  return sql<{ n: string | number }>`
    select count(*) as n from ${tableOf(schema, name)} where ${sql.ref(folded(column))} is not null
  `;
}

/** The rows that leave a column empty: what a `require` has to answer for. */
function empty(schema: string, name: string, column: string) {
  return sql<{ n: string | number }>`
    select count(*) as n from ${tableOf(schema, name)} where ${sql.ref(folded(column))} is null
  `;
}

/**
 * The rows that repeat a `unique` over these fields: every row of every group of more than one, since each of
 * them is a row that would have to go before the constraint could hold. A group of four repeating rows counts
 * four, not three, because which of them stays is the decision the plan refuses to make.
 */
function repeating(schema: string, name: string, over: string[]) {
  const columns = sql.join(over.map(field => sql.ref(folded(field))));
  return sql<{ n: string | number }>`
    select coalesce(sum(c), 0) as n from (
      select count(*) as c from ${tableOf(schema, name)}
      group by ${columns} having count(*) > 1
    ) as repeated
  `;
}

/** One reference as a count is shaped by it: the field that holds a key, and the collection and key it names. */
interface Points {
  field: string;
  to: string;
  key: string;
}

/** The rows whose reference points at no record of the other collection: what a `refs` cannot be added over. */
function dangling(schema: string, name: string, at: Points) {
  const held = sql.ref(folded(at.field));
  const key = sql.ref(folded(at.key));
  return sql<{ n: string | number }>`
    select count(*) as n from ${tableOf(schema, name)} as holder
    left join ${tableOf(schema, at.to)} as target on target.${key} = holder.${held}
    where holder.${held} is not null and target.${key} is null
  `;
}

/**
 * The rows a cast would not carry from the type the column is to the type the tree declares. A cast this
 * engine attempts is tried per row and the failures counted, with `pg_input_is_valid` (PostgreSQL 16 and up),
 * which asks exactly "would this text parse as that type?" without raising. A pair this engine will not
 * attempt at all answers every row that holds a value, so the step refuses and the plan says how many values
 * are at stake; a cast that carries every value -- widening to text -- answers none.
 */
function uncastable(schema: string, name: string, step: Step, to: Counting) {
  const column = sql.ref(folded(step.at ?? ''));
  const held = sql<{ n: string | number }>`
    select count(*) as n from ${tableOf(schema, name)} where ${column} is not null
  `;
  if (to === 'refused') return held;
  return sql<{ n: string | number }>`
    select count(*) as n from ${tableOf(schema, name)}
    where ${column} is not null and not pg_input_is_valid(${column}::text, ${to})
  `;
}

/** What a `retype`'s count asks the database, as `casts.ts` decides it for the pair the step names. */
function landing(step: Step): Counting {
  if (!step.was || !step.becomes) return 'refused';
  return castTo(step.was, step.becomes);
}

/** The count of a step about one column: what it holds, what it leaves empty, or what no cast would carry. */
function ofColumn(schema: string, step: Step, column: string): RawBuilder<{ n: string | number }> | undefined {
  if (step.do === 'remove') return holding(schema, step.target, column);
  if (step.do === 'require') return empty(schema, step.target, column);
  if (step.do === 'add') return all(schema, step.target);
  if (step.do !== 'retype') return undefined;
  const to = landing(step);
  return to === 'carries' ? undefined : uncastable(schema, step.target, step, to);
}

/** The query one step's count is, or nothing where the step needs no count at all. */
function queryOf(schema: string, step: Step): RawBuilder<{ n: string | number }> | undefined {
  if (step.do === 'drop') return all(schema, step.target);
  if (step.do === 'unique' && step.over?.length) return repeating(schema, step.target, step.over);
  if (!step.at) return undefined;
  return ofColumn(schema, step, step.at);
}

/**
 * How many rows stand in this step's way, as one count. A step this engine has nothing to count for answers
 * zero, which is the honest answer: nothing stands in its way. A `ref` joins on the key of the collection it
 * points at, which the catalog knows, so the count is read from the database and from the step and nothing
 * else -- no caller has to hand the engine the tree.
 */
export async function countFor(db: Kysely<never>, schema: string, step: Step, key?: string): Promise<number> {
  if (step.do === 'ref' && step.at && step.to)
    return counted(db, dangling(schema, step.target, { field: step.at, to: step.to, key: key ?? 'id' }));
  const query = queryOf(schema, step);
  if (!query) return 0;
  return counted(db, query);
}
