/**
 * The filter and the ordering as SQLite SQL. @storage parses a `where` and judges what it may say; this is the
 * other half, compiling that tree to expressions so that the same filter answers the same records here as in
 * memory -- which is what the shared suite holds every engine to.
 *
 * Where SQLite's own reading of an operator disagrees with the memory engine's, the engine says it right
 * rather than the suite bending (RFC 0022):
 *
 * - `contains` and `startsWith` are `instr()` and `substr()`, not `LIKE`: SQLite's `LIKE` folds ASCII case, so
 *   `'GET' LIKE 'get'` is true there and false in memory. Neither function reads a pattern, so nothing in the
 *   value needs escaping either.
 * - `ne` is `IS NOT` and `notIn` keeps a row whose column is empty, because the memory engine's `!==` and
 *   `!includes` are true of an absent value, where SQL's `!=` and `NOT IN` answer unknown and drop the row.
 * - `not` is `IS NOT TRUE`, not `NOT`, so a `not` over a test of an absent field keeps the record, as the memory
 *   engine's `!` does; SQL's `NOT` keeps the test's unknown and drops it.
 * - a column holding JSON is compared as JSON through `json()`, and never ordered: SQLite would order its text,
 *   which is not the order the memory engine's `compare` gives, so it is refused in the open instead.
 * - a boolean is bound as the 0 or 1 its column holds, since the driver binds no boolean at all.
 */
import type { Type } from '@wilanis/core';
import type { Order, Test, Where } from '@wilanis/plugin-storage';
import { type Expression, type ExpressionBuilder, type RawBuilder, sql } from 'kysely';
import { bound, isJson, typeOf } from './columns.js';

type Builder = ExpressionBuilder<never, never>;
type Sql = Expression<unknown>;

/** What `in` and `notIn` are given: a list, or nothing at all, which matches no record and every record. */
const listed = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** The two sides a test compares: the column as SQLite should read it, and a value as the column holds one. */
interface Sides {
  column: RawBuilder<unknown>;
  left: RawBuilder<unknown>;
  right: (value: unknown) => RawBuilder<unknown>;
}

/** The sides of a test over one field: a JSON column on both sides through `json()`, anything else as bound. */
function sidesOf(field: string, type: Type | undefined): Sides {
  const column = sql`${sql.ref(field)}`;
  if (type && isJson(type))
    return { column, left: sql`json(${column})`, right: value => sql`json(${JSON.stringify(value ?? null)})` };
  return { column, left: column, right: value => sql`${bound(value, type)}` };
}

/** A list of values as SQL spells one inside `in (...)`. */
const listOf = (sides: Sides, value: unknown) => sql.join(listed(value).map(one => sides.right(one)));

/** One test as an expression over its column. */
function expression(field: string, test: Test, type: Type | undefined): Sql {
  const sides = sidesOf(field, type);
  const { column, left, right } = sides;
  switch (test.op) {
    case 'eq':
      return sql<boolean>`${left} = ${right(test.value)}`;
    case 'ne':
      return sql<boolean>`${left} is not ${right(test.value)}`;
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      return ordering(column, test, type);
    case 'in':
      return sql<boolean>`${left} in (${listOf(sides, test.value)})`;
    case 'notIn':
      return sql<boolean>`(${column} is null or ${left} not in (${listOf(sides, test.value)}))`;
    case 'has':
      return test.value ? sql<boolean>`${column} is not null` : sql<boolean>`${column} is null`;
    case 'contains':
      return sql<boolean>`instr(${column}, ${String(test.value ?? '')}) > 0`;
    default:
      return sql<boolean>`substr(${column}, 1, length(${String(test.value ?? '')})) = ${String(test.value ?? '')}`;
  }
}

/** An ordering test, refused over a column this engine keeps as JSON and will not promise an order for. */
function ordering(column: RawBuilder<unknown>, test: Test, type: Type | undefined): Sql {
  if (type && isJson(type))
    throw new Error(
      `'${test.op}' orders, and this engine keeps a field of that type as JSON, which it will not order by`,
    );
  const operator = { lt: '<', lte: '<=', gt: '>', gte: '>=' }[test.op as 'lt' | 'lte' | 'gt' | 'gte'];
  return sql<boolean>`${column} ${sql.raw(operator)} ${bound(test.value, type)}`;
}

/**
 * A `not` over a filter, true wherever the filter is not true. SQL answers unknown for a test of an empty column,
 * and `NOT` keeps the unknown, so the row is dropped; `IS NOT TRUE` reads the unknown as false, as the memory
 * engine reads a test of an absent field, and is `NOT COALESCE(x, FALSE)` said in one operator.
 */
const negated = (inner: Sql): Sql => sql<boolean>`((${inner}) is not true)`;

/** A filter as one expression over the table's columns; no filter asks for every record. */
export function conditionOf(eb: Builder, where: Where | undefined, shape: Type): Sql | undefined {
  if (!where) return undefined;
  if (where.kind === 'all') return every(eb, where.of, shape, 'and');
  if (where.kind === 'any') return every(eb, where.of, shape, 'or');
  if (where.kind === 'not') {
    const inner = conditionOf(eb, where.of, shape);
    return inner ? negated(inner) : undefined;
  }
  const tests = where.tests.map(test => expression(where.field, test, typeOf(shape, where.field)));
  return tests.length ? eb.and(tests as never) : undefined;
}

/** A list of filters joined: an empty `all` asks for every record, an empty `any` for none. */
function every(eb: Builder, of: Where[], shape: Type, how: 'and' | 'or'): Sql | undefined {
  const parts = of.map(one => conditionOf(eb, one, shape)).filter(Boolean);
  if (!parts.length) return how === 'and' ? undefined : sql<boolean>`0`;
  return how === 'and' ? eb.and(parts as never) : eb.or(parts as never);
}

/**
 * The orderings a find asks for, as SQL, refused over a column this engine will not order by. An empty value
 * is ordered last ascending and first descending, which is what the postgres engine answers by default and
 * what the memory engine's `compare` does with an absent value; SQLite's own default is the other way round.
 */
export function orderingsOf(order: Order[] | undefined, shape: Type): RawBuilder<unknown>[] {
  return (order ?? []).map(one => {
    const type = typeOf(shape, one.by);
    if (type && isJson(type))
      throw new Error(`order: '${one.by}' is kept as JSON, and this engine will not order by one`);
    const desc = one.dir === 'desc';
    return sql`${sql.ref(one.by)} ${sql.raw(desc ? 'desc nulls first' : 'asc nulls last')}`;
  });
}
