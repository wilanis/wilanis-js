/**
 * The filter and the ordering as SQL. @storage parses a `where` and judges what it may say; this is the other
 * half, compiling that tree to expressions -- the one thing every engine does differently. The memory engine
 * compiles the same tree to a predicate, and the shared suite judges both by the records they answer.
 *
 * Two decisions this step was left to make (RFC 0002, "settled on review"):
 *
 * - `contains` and `startsWith` are `LIKE` over an escaped pattern, not `ILIKE` and not a regex. The memory
 *   engine matches text case-sensitively with `String.includes`, so `LIKE` is the operator that answers the
 *   same rows; `%` and `_` in the value are escaped so a filter cannot smuggle a pattern in.
 * - a `jsonb` column is never ordered by and never compared with an ordering operator. Postgres orders jsonb
 *   by its own internal rules, which are not the rules the memory engine's `compare` uses, and an engine that
 *   answered a different order for the same filter would make the suite a lie. The grammar already refuses an
 *   ordering on a shape or a list (`unfit` in @storage), so what is left here is `unknown`, and it is refused
 *   in the open rather than quietly ordered some other way.
 */
import type { Type } from '@wilanis/core';
import type { Order, Test, Where } from '@wilanis/plugin-storage';
import { type Expression, type ExpressionBuilder, sql } from 'kysely';
import { isJson } from './columns.js';

type Builder = ExpressionBuilder<never, never>;
type Sql = Expression<unknown>;

/** The type of one field of the record shape, so a test knows whether it is comparing JSON or a column. */
const typeOf = (shape: Type, field: string): Type | undefined =>
  shape.kind === 'object' ? shape.fields[field]?.type : undefined;

/** A `LIKE` pattern that means the text itself: what the value spells, with the wildcards made literal. */
const escaped = (value: unknown): string => String(value ?? '').replace(/([\\%_])/g, '\\$1');

/**
 * One test as an expression over its column. A `jsonb` column is compared as JSON so that `eq` against a shape
 * or a list means what the memory engine means by it; everything else is compared as the column it is.
 */
function expression(eb: Builder, field: string, test: Test, type: Type | undefined): Sql {
  const column = eb.ref(field as never);
  const json = type ? isJson(type) : false;
  const value = json ? sql`${JSON.stringify(test.value ?? null)}::jsonb` : sql`${test.value}`;
  switch (test.op) {
    case 'eq':
      return eb(column, '=', value as never);
    case 'ne':
      return eb(column, '!=', value as never);
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      return ordering(eb, column as never, test, type);
    case 'in':
      return eb(column, 'in', listed(test.value) as never);
    case 'notIn':
      return eb(column, 'not in', listed(test.value) as never);
    case 'has':
      return test.value ? eb(column, 'is not', null) : eb(column, 'is', null);
    case 'contains':
      return sql<boolean>`${column} like ${`%${escaped(test.value)}%`} escape '\\'`;
    default:
      return sql<boolean>`${column} like ${`${escaped(test.value)}%`} escape '\\'`;
  }
}

/** An ordering test, refused over a column this engine will not promise an order for. */
function ordering(eb: Builder, column: Sql, test: Test, type: Type | undefined): Sql {
  if (type && isJson(type))
    throw new Error(
      `'${test.op}' orders, and this engine keeps a field of that type as jsonb, which it will not order by`,
    );
  const operator = { lt: '<', lte: '<=', gt: '>', gte: '>=' }[test.op as 'lt' | 'lte' | 'gt' | 'gte'];
  return eb(column as never, operator as never, sql`${test.value}` as never);
}

/** What `in` and `notIn` are given: a list, or nothing at all, which matches no record and every record. */
const listed = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** A filter as one expression over the table's columns; no filter asks for every record. */
export function conditionOf(eb: Builder, where: Where | undefined, shape: Type): Sql | undefined {
  if (!where) return undefined;
  if (where.kind === 'all') return every(eb, where.of, shape, 'and');
  if (where.kind === 'any') return every(eb, where.of, shape, 'or');
  if (where.kind === 'not') {
    const inner = conditionOf(eb, where.of, shape);
    return inner ? eb.not(inner as never) : undefined;
  }
  const tests = where.tests.map(test => expression(eb, where.field, test, typeOf(shape, where.field)));
  return tests.length ? eb.and(tests as never) : undefined;
}

/** A list of filters joined: an empty `all` asks for every record, an empty `any` for none. */
function every(eb: Builder, of: Where[], shape: Type, how: 'and' | 'or'): Sql | undefined {
  const parts = of.map(one => conditionOf(eb, one, shape)).filter(Boolean);
  if (!parts.length) return how === 'and' ? undefined : sql<boolean>`false`;
  return how === 'and' ? eb.and(parts as never) : eb.or(parts as never);
}

/**
 * The orderings a find asks for, refused over a column this engine will not order by. Nulls are ordered last
 * ascending and first descending, which is Postgres's own default and what the memory engine's `compare` does
 * with an absent value.
 */
export function orderingsOf(order: Order[] | undefined, shape: Type): { by: string; dir: 'asc' | 'desc' }[] {
  return (order ?? []).map(one => {
    const type = typeOf(shape, one.by);
    if (type && isJson(type))
      throw new Error(`order: '${one.by}' is kept as jsonb, and this engine will not order by one`);
    return { by: one.by, dir: one.dir === 'desc' ? 'desc' : 'asc' };
  });
}
