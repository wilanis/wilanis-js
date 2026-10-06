/**
 * The constraint a refused write broke, spelled the way the store declares it, so a violation is answered as
 * the `violated` or `referencedBy` the port promises rather than thrown. A constraint the store declares is the
 * opposite of unforeseen.
 *
 * MySQL names what it refused, and `ensure` names every constraint it makes after the declaration
 * (`names.ts`), so the round trip is a lookup. A duplicate names the index (`for key 'entries.wl_u_...'`, or
 * `PRIMARY` for the key); a foreign key names its constraint (`CONSTRAINT \`wl_r_...\``), whether the write named
 * a missing target or the remove would orphan a record. InnoDB undoes the one statement and keeps the
 * transaction, so a graph routing on the answer can go on writing in it.
 */
import type { At } from '@wilanis/plugin-storage';
import { refName, uniqueName } from './names.js';

/** A row another table's key is not there for (`ER_NO_REFERENCED_ROW_2`), and a row still referenced (`ER_ROW_IS_REFERENCED_2`). */
const MISSING_TARGET = 1452;
const STILL_REFERENCED = 1451;
/** A value a unique index already holds (`ER_DUP_ENTRY`). */
export const DUPLICATE = 1062;

/** The error number a driver error carries, or nothing where it is not one. */
const errnoOf = (error: unknown): number | undefined => (error as { errno?: number }).errno;
const messageOf = (error: unknown): string => String((error as { message?: unknown }).message ?? '');

/** The index a duplicate names, without the table MySQL 8 puts in front of it. */
export function indexNamed(error: unknown): string | undefined {
  if (errnoOf(error) !== DUPLICATE) return undefined;
  const named = /for key '([^']*)'/.exec(messageOf(error))?.[1];
  return named?.slice(named.lastIndexOf('.') + 1);
}

/** The foreign-key constraint an error names. */
const constraintNamed = (error: unknown): string | undefined => /CONSTRAINT `([^`]*)`/.exec(messageOf(error))?.[1];

/** The declared unique a duplicate names, as the store spells it; the key where it names the primary key. */
function uniqueOf(error: unknown, at: At): string {
  const index = indexNamed(error);
  const fields = at.unique.find(one => uniqueName(at.name, one) === index);
  return `unique [${(fields ?? [at.key]).join(', ')}]`;
}

/** What a refused `put` or `patch` answers as `violated`, or nothing where the error is not a constraint. */
export function writeViolation(error: unknown, at: At): string | undefined {
  const errno = errnoOf(error);
  if (errno === DUPLICATE) return uniqueOf(error, at);
  if (errno !== MISSING_TARGET) return undefined;
  const constraint = constraintNamed(error);
  const ref = at.refs.find(one => refName(one.from, one.field) === constraint);
  return ref ? `refs ${ref.from}.${ref.field} -> ${ref.to}` : `refs ${constraint ?? at.name}`;
}

/** What a refused `remove` answers as `referencedBy`, or nothing where the error is not a reference. */
export function removeViolation(error: unknown, at: At): string | undefined {
  if (errnoOf(error) !== STILL_REFERENCED) return undefined;
  const constraint = constraintNamed(error);
  const ref = at.referenced.find(one => refName(one.from, one.field) === constraint);
  return ref ? `refs ${ref.from}.${ref.field} -> ${ref.to}` : `refs -> ${at.name}`;
}
