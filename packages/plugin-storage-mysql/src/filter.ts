/**
 * The filter and the ordering as MySQL SQL. @storage parses a `where` and judges what it may say; this is the
 * other half, compiling that tree to expressions so that the same filter answers the same records here as in
 * memory -- which is what the shared suite holds every engine to.
 *
 * Where MySQL's own reading of an operator disagrees with the memory engine's, the engine says it right rather
 * than the suite bending (RFC 0022):
 *
 * - a string column is `utf8mb4_bin` (`columns.ts`), so `eq`, `contains` and `startsWith` match case; the last
 *   two are `INSTR()` and `LOCATE()`, which read no pattern, so nothing in the value needs escaping.
 * - `ne` is `NOT (x <=> v)` and `notIn` keeps a row whose column is empty, because the memory engine's `!==`
 *   and `!includes` are true of an absent value, where SQL's `!=` and `NOT IN` answer unknown and drop the row.
 * - `not` is `IS NOT TRUE`, not `NOT`, so a `not` over a test of an absent field keeps the record, as the memory
 *   engine's `!` does; SQL's `NOT` keeps the test's unknown and drops it.
 * - `in` over no value matches nothing and `notIn` over none matches everything; MySQL refuses `IN ()`.
 * - a `JSON` column is compared as JSON, cast from the value's text, and `in` over one is a list of equalities,
 *   since MySQL does not compare JSON inside `IN`. It is never ordered: MySQL's order of JSON values is not the
 *   memory engine's `compare`, so ordering by one is refused in the open instead.
 * - an empty value is ordered last ascending and first descending, as postgres and memory order it; MySQL's
 *   own default is the other way round.
 */
import type { Type } from '@wilanis/core';
import type { Order, Test, Where } from '@wilanis/plugin-storage';
import { type Expression, type ExpressionBuilder, type RawBuilder, sql } from 'kysely';
import { bound, isJson, typeOf } from './columns.js';

type Builder = ExpressionBuilder<never, never>;
type Sql = Expression<unknown>;

/** What `in` and `notIn` are given: a list, or nothing at all. */
const listed = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** The value side of a comparison: cast to JSON for a JSON column, as the column holds it otherwise. */
function sideOf(value: unknown, type: Type | undefined): RawBuilder<unknown> {
  if (type && isJson(type)) return sql`cast(${JSON.stringify(value ?? null)} as json)`;
  return sql`${bound(value, type)}`;
}

/** Whether the column holds any of the values: `IN` for a column MySQL compares there, equalities for JSON. */
function anyOf(column: RawBuilder<unknown>, values: unknown[], type: Type | undefined): RawBuilder<unknown> {
  if (!values.length) return sql`false`;
  if (type && isJson(type))
    return sql`(${sql.join(
      values.map(one => sql`${column} = ${sideOf(one, type)}`),
      sql` or `,
    )})`;
  return sql`${column} in (${sql.join(values.map(one => sideOf(one, type)))})`;
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

/** One test as an expression over its column. */
function expression(field: string, test: Test, type: Type | undefined): Sql {
  const column = sql`${sql.ref(field)}`;
  const text = String(test.value ?? '');
  switch (test.op) {
    case 'eq':
      return sql<boolean>`${column} = ${sideOf(test.value, type)}`;
    case 'ne':
      return sql<boolean>`not (${column} <=> ${sideOf(test.value, type)})`;
    case 'in':
      return anyOf(column, listed(test.value), type);
    case 'notIn':
      return sql<boolean>`(${column} is null or not ${anyOf(column, listed(test.value), type)})`;
    case 'has':
      return test.value ? sql<boolean>`${column} is not null` : sql<boolean>`${column} is null`;
    case 'contains':
      return sql<boolean>`instr(${column}, ${text}) > 0`;
    case 'startsWith':
      return sql<boolean>`locate(${text}, ${column}) = 1`;
    default:
      return ordering(column, test, type);
  }
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
  if (!parts.length) return how === 'and' ? undefined : sql<boolean>`false`;
  return how === 'and' ? eb.and(parts as never) : eb.or(parts as never);
}

/** The orderings a find asks for, as SQL, an empty value last ascending and first descending. */
export function orderingsOf(order: Order[] | undefined, shape: Type): RawBuilder<unknown>[] {
  return (order ?? []).map(one => {
    const type = typeOf(shape, one.by);
    if (type && isJson(type))
      throw new Error(`order: '${one.by}' is kept as JSON, and this engine will not order by one`);
    const column = sql.ref(one.by);
    return one.dir === 'desc' ? sql`${column} is null desc, ${column} desc` : sql`${column} is null, ${column} asc`;
  });
}
