/**
 * What a collection's name becomes in the file. SQLite compares identifiers without case, so `auditLog` and
 * `auditlog` are one table: the engine's `named` answers the fold, and X233 refuses two collections of one
 * connection that fold together, by this same function, so the rule and the engine cannot disagree.
 *
 * A name the engine writes is always quoted, so what SQLite refuses is narrower than for an unquoted name: a
 * table whose name begins with `sqlite_`, in any case, is reserved for SQLite's own and refused at `CREATE`.
 */

/** The name a collection is kept under, folded as SQLite compares identifiers. */
export function folded(name: string): string {
  return name.toLowerCase();
}

/** Is this a table name this engine can create: a letter or an underscore, then letters, digits or underscores, not `sqlite_...`? */
export function legal(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !folded(name).startsWith('sqlite_');
}
