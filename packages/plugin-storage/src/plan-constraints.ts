/**
 * Point 5 of RFC 0017's diff: what a collection guarantees. A `unique` list or a `refs` the tree declares and
 * the record does not is a constraint to add, and existing rows decide whether it can be; one the record holds
 * and the tree no longer declares is a guarantee to drop, which costs no data and is transformative.
 *
 * A constraint is compared under the names the fields carry now, so a rename of a field a constraint is over
 * is one `rename` step and not a drop and an add.
 */
import type { CollectionMarks, Declared, Step } from './plan.js';

/** One `unique` list as a key a set can hold: the fields together, in the order the store writes them. */
const keyOf = (over: string[]) => over.join(',');

/** A constraint's fields under the names they carry now, so a renamed field does not look like a new constraint. */
function renamedTo(marks: CollectionMarks, to: Declared): Map<string, string> {
  const now = new Map<string, string>();
  for (const [field, old] of Object.entries(marks.renamed ?? {})) if (field in to.fields) now.set(old, field);
  return now;
}

/** One recorded `unique` list read under the names its fields carry now. */
const under = (over: string[], now: Map<string, string>) => over.map(field => now.get(field) ?? field);

/** A `unique` the tree declares and the record does not: what existing rows repeat decides whether it applies. */
function uniqueSteps(name: string, was: Set<string>, to: Declared): Step[] {
  return to.unique
    .filter(over => !was.has(keyOf(over)))
    .map(over => ({
      do: 'unique' as const,
      target: name,
      at: over.join('+'),
      over,
      says: `unique   [${over.join(', ')}]`,
      loses: `nothing, but no two rows may repeat [${over.join(', ')}] from now on`,
    }));
}

/** A `unique` the record holds and the tree no longer declares: the guarantee goes, and a duplicate may be written. */
function ununiqueSteps(name: string, from: Declared, to: Declared, now: Map<string, string>): Step[] {
  const declared = new Set(to.unique.map(keyOf));
  return from.unique
    .map(over => under(over, now))
    .filter(over => !declared.has(keyOf(over)))
    .map(over => ({
      do: 'ununique' as const,
      target: name,
      at: over.join('+'),
      over,
      says: `ununique [${over.join(', ')}]`,
      loses: `the guarantee that no two rows repeat [${over.join(', ')}]`,
    }));
}

/** One `refs` entry as a key a set can hold: a reference is the pair of the field and what it points at. */
const refOf = (field: string, collection: string) => `${field}→${collection}`;

/** The record's references under the names their fields carry now, as the pairs the declared are compared against. */
function wasRefs(from: Declared, now: Map<string, string>): Set<string> {
  return new Set(Object.entries(from.refs).map(([field, ref]) => refOf(now.get(field) ?? field, ref.collection)));
}

/**
 * A `refs` the tree declares and the record does not: rows pointing at nothing decide whether it applies. The
 * comparison is on the pair (field, collection), so a reference whose target moved is the old one dropped and
 * the new one added, and never a field the record silently disagrees with the database about.
 */
function refSteps(name: string, from: Declared, to: Declared, now: Map<string, string>): Step[] {
  const was = wasRefs(from, now);
  return Object.entries(to.refs)
    .filter(([field, ref]) => !was.has(refOf(field, ref.collection)))
    .map(([field, ref]) => ({
      do: 'ref' as const,
      target: name,
      at: field,
      to: ref.collection,
      says: `ref      ${field} → ${ref.collection}`,
      loses: `nothing, but ${field} must name a record of ${ref.collection} from now on`,
    }));
}

/**
 * A `refs` the record holds and the tree no longer declares, on the same pair: the guarantee goes, and an orphan
 * may be written. A field still referenced but at another collection is dropped here and added by `refSteps`.
 */
function unrefSteps(name: string, from: Declared, to: Declared, now: Map<string, string>): Step[] {
  const declared = new Set(Object.entries(to.refs).map(([field, ref]) => refOf(field, ref.collection)));
  return Object.entries(from.refs)
    .map(([field, ref]) => [now.get(field) ?? field, ref] as const)
    .filter(([field, ref]) => !declared.has(refOf(field, ref.collection)))
    .map(([field, ref]) => ({
      do: 'unref' as const,
      target: name,
      at: field,
      to: ref.collection,
      says: `unref    ${field} → ${ref.collection}`,
      loses: `the guarantee that ${field} names a record of ${ref.collection}`,
    }));
}

/** Every constraint step of one collection: what is added first, then what is dropped, uniques before refs. */
export function constraintSteps(name: string, from: Declared, to: Declared, marks: CollectionMarks): Step[] {
  const now = renamedTo(marks, to);
  const was = new Set(from.unique.map(over => keyOf(under(over, now))));
  return [
    ...uniqueSteps(name, was, to),
    ...ununiqueSteps(name, from, to, now),
    ...refSteps(name, from, to, now),
    ...unrefSteps(name, from, to, now),
  ];
}
