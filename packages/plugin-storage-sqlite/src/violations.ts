/**
 * The constraint a refused write broke, spelled the way the store declares it, so a violation is answered as
 * the `violated` or `referencedBy` the port promises rather than thrown. A constraint the store declares is the
 * opposite of unforeseen.
 *
 * SQLite says less than PostgreSQL about what it refused. A unique violation names the columns
 * (`UNIQUE constraint failed: entries.url, entries.method`), which are read back into the declaration that
 * holds them together. A foreign-key violation names nothing at all, so the reference is found by asking: for
 * a write, which declared reference names a record that is not there; for a remove, which collection still
 * holds the key. Both are asked on the handle the write ran on, so a transaction sees its own rows.
 */
import type { At, Record_, Scope } from '@wilanis/plugin-storage';
import type { Kysely } from 'kysely';
import { holds, keyOf } from './catalog.js';
import { bound, typeOf } from './columns.js';
import { folded } from './names.js';
import { scopeColumns } from './scoping.js';

/** The code a driver error carries, or nothing where it is not one. */
const codeOf = (error: unknown): string | undefined => (error as { code?: unknown }).code as string | undefined;

/**
 * Whether an error is a foreign key refusing. SQLite reports a write naming a missing target as
 * `SQLITE_CONSTRAINT_FOREIGNKEY`, and a remove an `ON DELETE RESTRICT` refused as `SQLITE_CONSTRAINT_TRIGGER`,
 * since the restriction is carried out as one; the message is the same for both.
 */
function isForeignKey(error: unknown): boolean {
  const code = codeOf(error) ?? '';
  const message = String((error as { message?: unknown }).message ?? '');
  return (
    code === 'SQLITE_CONSTRAINT_FOREIGNKEY' || (code.startsWith('SQLITE_CONSTRAINT') && message.includes('FOREIGN KEY'))
  );
}

/**
 * The columns a unique violation names, without the table each is prefixed with, folded as SQLite compares them.
 * The one place the message is read: whatever else is asked of a refused unique is asked of this list.
 */
function columnsNamed(error: unknown): string[] {
  const message = String((error as { message?: unknown }).message ?? '');
  const listed = message.slice(message.indexOf(':') + 1).trim();
  return listed.split(',').map(one => folded(one.trim().slice(one.trim().indexOf('.') + 1)));
}

/**
 * The declared unique a violation names, as the store spells it; the key where it names no declared one. A
 * scoped table holds each `unique` with the scope columns in front of the declared fields (`scope-table.ts`), so
 * a declaration is read in both spellings, bare and with the scope in front, as the postgres engine reads its
 * two constraint names -- never by stripping columns from the message by name. The answer names what the store
 * declared and nothing the engine put beside it.
 */
function uniqueOf(error: unknown, at: At, scope: Scope | undefined): string {
  const named = columnsNamed(error);
  const scoped = scopeColumns(scope);
  const names = (columns: string[]) => columns.length === named.length && columns.every(one => named.includes(one));
  const fields = at.unique.find(one => names(one.map(folded)) || names([...scoped, ...one.map(folded)]));
  return `unique [${(fields ?? [at.key]).join(', ')}]`;
}

/** The declared reference of a record that names a record its target does not hold. */
async function missingTarget(db: Kysely<never>, at: At, record: Record_): Promise<string | undefined> {
  for (const ref of at.refs) {
    const value = record[ref.field];
    if (value === undefined || value === null) continue;
    const column = await keyOf(db, ref.to);
    if (!column) continue;
    if (!(await holds(db, { table: ref.to, column }, bound(value, typeOf(at.shape, ref.field)))))
      return `refs ${ref.from}.${ref.field} -> ${ref.to}`;
  }
  return undefined;
}

/** What a write named: the record it gave -- whole for a put, the changes for a patch -- and the scope it ran under. */
export interface Wrote {
  record: Record_;
  scope?: Scope;
}

/**
 * What a refused `put` or `patch` answers as `violated`, or nothing where the error is not a constraint. The scope
 * the write ran under is what a scoped unique names beside the declared fields, and the answer does not.
 */
export async function writeViolation(error: unknown, db: Kysely<never>, at: At, wrote: Wrote) {
  const code = codeOf(error);
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY')
    return uniqueOf(error, at, wrote.scope);
  if (!isForeignKey(error)) return undefined;
  return (await missingTarget(db, at, wrote.record)) ?? `refs ${at.name}`;
}

/** What a refused `remove` answers as `referencedBy`, or nothing where the error is not a reference. */
export async function removeViolation(error: unknown, db: Kysely<never>, at: At, key: unknown) {
  if (!isForeignKey(error)) return undefined;
  for (const ref of at.referenced)
    if (await holds(db, { table: ref.from, column: ref.field }, bound(key, typeOf(at.shape, at.key))))
      return `refs ${ref.from}.${ref.field} -> ${ref.to}`;
  return `refs -> ${at.name}`;
}
