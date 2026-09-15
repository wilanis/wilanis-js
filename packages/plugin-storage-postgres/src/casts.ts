/**
 * Which type changes this engine will attempt, and how. RFC 0017 leaves the pairs to the implementation and
 * says the suite judges the behaviour; this is the whole of the answer, in one table, so what a `retype` does
 * is readable rather than scattered through the statement that runs it.
 *
 * The rule the table follows: a cast is attempted where every value of the one type has a reading as the
 * other, or where the values that do not are countable before anything runs. Anything else is refused
 * outright, because a plan that says `4 rows` and then loses forty is worse than a plan that refuses.
 */
import type { FieldType } from '@wilanis/plugin-storage';

/** The column type this engine keeps each field type in, which is `columnOf` read by the neutral name. */
const COLUMN: Record<FieldType, string> = {
  string: 'text',
  number: 'double precision',
  boolean: 'boolean',
  json: 'jsonb',
};

/** The pairs this engine casts between, as `from → to`; anything absent is refused outright. */
const ATTEMPTED = new Set([
  // every value of every type has a text reading, so widening to text always carries
  'number→string',
  'boolean→string',
  'json→string',
  // a text that parses as the type carries, and one that does not is counted before anything runs
  'string→number',
  'string→boolean',
  'string→json',
  // a number reads as json (it is one), and a boolean does too
  'number→json',
  'boolean→json',
]);

/** Does this engine attempt a cast between these two types at all? */
export function attempts(was: FieldType, now: FieldType): boolean {
  return was !== now && ATTEMPTED.has(`${was}→${now}`);
}

/**
 * What counting a cast has to ask the database. `'carries'` is a cast every value survives -- widening to text
 * is one -- so there is nothing to count and nothing to ask. `'refused'` is a pair this engine will not
 * attempt at all, so every value is at stake. Anything else is the type to try each value against.
 */
export type Counting = 'carries' | 'refused' | (string & {});

/**
 * The type a cast's count is taken against, or `'carries'` where the cast survives every value and `'refused'`
 * where this engine attempts the pair at all. The two are different answers and never the same one: a
 * widening carries nothing away, and a refused pair carries everything.
 */
export function castTo(was: FieldType, now: FieldType): Counting {
  if (!attempts(was, now)) return 'refused';
  if (now === 'string') return 'carries';
  return COLUMN[now];
}

/** The column type a field of this type is kept in, for the statement a `retype` runs. */
export const columnFor = (type: FieldType): string => COLUMN[type];
