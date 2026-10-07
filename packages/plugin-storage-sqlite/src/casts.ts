/**
 * Which type changes this engine attempts, how each value is carried, and how to tell a value that cannot be.
 * RFC 0017 leaves the pairs to the engine and the suite judges the behaviour; this is the whole of the answer
 * for SQLite, in one table. The pairs are the postgres engine's, so a store moves between the two engines and
 * a plan refuses the same `retype` on both.
 *
 * SQLite casts without complaint: `CAST('two' AS REAL)` is 0. So a cast here is never trusted to fail. Each pair
 * that can lose a value has a test, written once below, that says whether a value carries. `rows` counts the
 * values that do not, and the rebuild counts them again inside the plan's transaction and throws where any is
 * left, so a row written between the count and the apply fails the plan rather than turning into a 0.
 */
import type { FieldType } from '@wilanis/plugin-storage';

/** The pairs this engine casts between, as `from→to`; anything absent is refused outright. */
const ATTEMPTED = new Set([
  // every value of every type has a text reading, so widening to text always carries
  'number→string',
  'boolean→string',
  'json→string',
  // a text that reads as the type carries, and one that does not is counted before anything runs
  'string→number',
  'string→boolean',
  'string→json',
  // a number reads as JSON (it is one), and a boolean does too
  'number→json',
  'boolean→json',
]);

/** The words a text may hold to read as a boolean, as PostgreSQL's `boolean` input reads them. */
const TRUE = ['true', 't', 'yes', 'y', 'on', '1'];
const FALSE = ['false', 'f', 'no', 'n', 'off', '0'];

/** A list of words as SQL spells it. */
const listOf = (words: string[]) => words.map(one => `'${one}'`).join(', ');

/** Does this engine attempt a cast between these two types at all? */
export function attempts(was: FieldType, now: FieldType): boolean {
  return was !== now && ATTEMPTED.has(`${was}→${now}`);
}

/**
 * The test a value of `column` passes when the cast carries it, or nothing where every value carries. A pair
 * this engine does not attempt has no test, and the caller refuses it before it asks. A text reads as a number
 * when it is a JSON number, which is narrower than what SQLite would cast: a text it counts as lost is lost
 * for certain, and none it lets through turns into a 0.
 */
export function carries(was: FieldType, now: FieldType, column: string): string | undefined {
  if (now === 'string' || was !== 'string') return undefined;
  if (now === 'number')
    return `(CASE WHEN json_valid(${column}) THEN json_type(${column}) IN ('integer', 'real') ELSE 0 END)`;
  if (now === 'boolean') return `lower(trim(${column})) IN (${listOf([...TRUE, ...FALSE])})`;
  return `json_valid(${column})`;
}

/** A number as text: an integer without its `.0`, as JavaScript and PostgreSQL write one, any other as SQLite does. */
const numberText = (column: string) =>
  `(CASE WHEN ${column} = CAST(${column} AS INTEGER) THEN CAST(CAST(${column} AS INTEGER) AS TEXT) ELSE CAST(${column} AS TEXT) END)`;

/** A boolean as text, `true` or `false`, which is also its JSON. */
const booleanText = (column: string) => `(CASE ${column} WHEN 1 THEN 'true' WHEN 0 THEN 'false' END)`;

/**
 * The value of `column` cast to the other type, for the copy a rebuild makes. Every pair carries an empty value
 * as empty. Only a pair `attempts` answers true for is ever asked.
 */
export function castOf(was: FieldType, now: FieldType, column: string): string {
  if (was === 'number') return numberText(column);
  if (was === 'boolean') return booleanText(column);
  if (was === 'json') return column;
  if (now === 'number') return `CAST(${column} AS REAL)`;
  if (now === 'boolean')
    return `(CASE WHEN ${column} IS NULL THEN NULL WHEN lower(trim(${column})) IN (${listOf(TRUE)}) THEN 1 ELSE 0 END)`;
  return `json(${column})`;
}
