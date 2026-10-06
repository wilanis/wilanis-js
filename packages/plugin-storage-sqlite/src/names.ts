/**
 * What a collection's name becomes in the file, and what the indexes the engine makes over it are called.
 * SQLite compares identifiers without case, so `auditLog` and `auditlog` are one table: the engine's `named`
 * answers the fold, and X233 refuses two collections of one connection that fold together, by this same
 * function, so the rule and the engine cannot disagree.
 *
 * A name the engine writes is always quoted, so what SQLite refuses is narrower than for an unquoted name: a
 * table whose name begins with `sqlite_`, in any case, is reserved for SQLite's own and refused at `CREATE`.
 */
import { createHash } from 'node:crypto';

/** The name a collection is kept under, folded as SQLite compares identifiers. */
export function folded(name: string): string {
  return name.toLowerCase();
}

/** Is this a table name this engine can create: a letter or an underscore, then letters, digits or underscores, not `sqlite_...`? */
export function legal(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !folded(name).startsWith('sqlite_');
}

/** A short hash of what an index is over, so every declaration's index has a name of its own in the file. */
const hashOf = (over: unknown) => createHash('sha256').update(JSON.stringify(over)).digest('hex').slice(0, 16);

/**
 * The name a unique index is created under: `wl_u_` and a short hash of the collection and the fields it
 * holds together. Joining the names with `_` would spell `["a_b"]` and `["a", "b"]` alike, and index names are
 * the file's, not the table's; the hash of the list keeps every declaration's name its own. Nothing reads the
 * name back to judge whether a unique is held -- that is read off what the index covers (`uniquesOf`).
 */
export const uniqueName = (collection: string, fields: string[]) => `wl_u_${hashOf([collection, fields])}`;

/**
 * The name the same unique is created under once the collection keeps a scope (RFC 0015): `wl_us_` and a hash
 * of the collection, the scope columns and the fields. It is a name of its own rather than the unscoped one
 * made again, so the engine can drop exactly the index a scope replaced, and the one a wider scope replaces.
 */
export const scopedUniqueName = (collection: string, scope: string[], fields: string[]) =>
  `wl_us_${hashOf([collection, scope, fields])}`;

/**
 * The name of the index over a collection's scope columns and its key, so a scoped `get` is one index read. It
 * names the collection and not the columns: a fixed name is what lets the engine read back from the catalog
 * which of a table's columns it keeps as a scope, since no field of the shape says so.
 */
export const scopedIndexName = (collection: string) => `wl_i_${folded(collection)}_scope`;
