/**
 * Whether the record and the catalog still say the same thing about a collection, and what to say where they
 * do not (RFC 0017, *Drift, and `--adopt`*). A plan is computed from the record, so a record the database has
 * moved out from under is a plan that would be wrong in ways the diff cannot see: the connection is refused
 * and the difference printed in the record's own words.
 *
 * The comparison folds every name, because a field a tree calls `entryId` is a column an engine may keep as
 * `entryid` and read back as such -- a collection name is an identifier (D001), so two that differ only in
 * case are the same name and never a difference. What is compared beyond the names is the declaration itself:
 * the key, each field's type and whether a row may leave it empty, the uniques and the references.
 */
import type { Declared } from './plan.js';

/** A name as a comparison reads it: an engine may keep an identifier folded, and a folded name is the same name. */
const fold = (name: string) => name.toLowerCase();

/** Every name of a list folded and sorted, so two declarations of one thing compare as one whatever order they hold it in. */
const sorted = (names: string[]) => [...names].map(fold).sort();

/** One `unique` as a line, so a list of them compares as a set and reads as the constraint the store wrote. */
const uniqueLine = (fields: string[]) => `[${sorted(fields).join(', ')}]`;

/** What the two sides of a comparison are called, so a difference names the record first and the database second. */
interface Sides {
  collection: string;
  record: Declared;
  found: Declared;
}

/** The key each side identifies a record by, where the two disagree about which field that is. */
function keyDiff({ collection, record, found }: Sides): string[] {
  if (fold(record.key) === fold(found.key)) return [];
  return [`${collection} is keyed by ${found.key} in the database; the record says ${record.key}`];
}

/** One field as each side holds it, said the way the record says it: the type, and whether a row may leave it empty. */
function fieldSaid(field: { type: string; required: boolean }): string {
  return `${field.type}, ${field.required ? 'required' : 'optional'}`;
}

/** Every field the two sides disagree about: one side has it and the other has not, or both have it differently. */
function fieldDiffs({ collection, record, found }: Sides): string[] {
  const held = new Map(Object.entries(found.fields).map(([name, field]) => [fold(name), field]));
  const out: string[] = [];
  for (const [name, field] of Object.entries(record.fields)) {
    const other = held.get(fold(name));
    if (!other) out.push(`${collection}.${name} is not a column of the database; the record says ${fieldSaid(field)}`);
    else if (other.type !== field.type || other.required !== field.required)
      out.push(`${collection}.${name} is ${fieldSaid(other)} in the database; the record says ${fieldSaid(field)}`);
  }
  const declared = new Set(Object.keys(record.fields).map(fold));
  for (const name of Object.keys(found.fields))
    if (!declared.has(fold(name)))
      out.push(`${collection}.${name} is a column of the database the record has never heard of`);
  return out;
}

/** Every `unique` one side holds and the other does not, in the words the store declares one. */
function uniqueDiffs({ collection, record, found }: Sides): string[] {
  const kept = new Set(found.unique.map(uniqueLine));
  const declared = new Set(record.unique.map(uniqueLine));
  const missing = record.unique
    .map(uniqueLine)
    .filter(one => !kept.has(one))
    .map(one => `${collection} has no unique ${one} in the database; the record says it has`);
  const extra = found.unique
    .map(uniqueLine)
    .filter(one => !declared.has(one))
    .map(one => `${collection} has a unique ${one} in the database the record has never heard of`);
  return [...missing, ...extra];
}

/** Every reference the two sides disagree about: one holds it, the other has not, or the two point elsewhere. */
function refDiffs({ collection, record, found }: Sides): string[] {
  const held = new Map(Object.entries(found.refs).map(([field, ref]) => [fold(field), fold(ref.collection)]));
  const out: string[] = [];
  for (const [field, ref] of Object.entries(record.refs)) {
    const to = held.get(fold(field));
    if (!to)
      out.push(`${collection}.${field} references no ${ref.collection} in the database; the record says it does`);
    else if (to !== fold(ref.collection))
      out.push(`${collection}.${field} references ${to} in the database; the record says ${ref.collection}`);
  }
  const declared = new Set(Object.keys(record.refs).map(fold));
  for (const field of Object.keys(found.refs))
    if (!declared.has(fold(field)))
      out.push(
        `${collection}.${field} references ${found.refs[field]?.collection} in the database, and the record has never heard of it`,
      );
  return out;
}

/**
 * Where the record and the catalog disagree about one collection, one difference per line, or nothing at all
 * where they say the same thing. A collection the record holds and the catalog has no table for is drift too:
 * the table was dropped outside the tree, and every step of the plan would be written against nothing.
 */
export function driftOf(collection: string, record: Declared, found: Declared | undefined): string[] {
  if (!found) return [`${collection} is recorded, and the database holds no such collection`];
  const sides: Sides = { collection, record, found };
  return [...keyDiff(sides), ...fieldDiffs(sides), ...uniqueDiffs(sides), ...refDiffs(sides)];
}
