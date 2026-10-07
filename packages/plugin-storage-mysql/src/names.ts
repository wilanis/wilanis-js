/**
 * The names this engine writes into a database: the tables, the indexes and the foreign keys it makes, and how
 * an identifier is quoted. A table is the collection's name as written, always quoted.
 *
 * A unique index and a foreign key are named by a hash of what they hold together, so that a violation MySQL
 * reports can be read back into the declaration that made it (`violations.ts`). MySQL caps an identifier at 64
 * characters and keeps foreign-key names unique across the whole database, so the name carries the collection
 * as well as the fields, and is short whatever they spell.
 */
import { createHash } from 'node:crypto';

/** A short hash of what a constraint holds together. */
const hashOf = (parts: unknown): string =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);

/** The name a declared `unique` is created under: `wl_u_` and a hash of the collection and its fields. */
export const uniqueName = (collection: string, fields: string[]): string => `wl_u_${hashOf([collection, fields])}`;

/**
 * The name the same `unique` is created under once the collection keeps a scope (RFC 0015): `wl_us_` and a hash
 * of the collection, the scope columns and the fields. It is a name of its own rather than the unscoped one
 * made again, so the engine drops exactly the index a scope replaces, and the one a wider scope replaces.
 */
export const scopedUniqueName = (collection: string, scope: string[], fields: string[]): string =>
  `wl_us_${hashOf([collection, scope, fields])}`;

/**
 * The name of the index over a collection's scope columns. It names the collection and not the columns: a fixed
 * name is what lets the engine read back from the catalog which columns a table keeps as a scope, since no
 * field of the shape says so.
 */
export const scopedIndexName = (collection: string): string => `wl_s_${hashOf([collection])}`;

/** The name a declared `refs` is created under: `wl_r_` and a hash of the collection and the field. */
export const refName = (collection: string, field: string): string => `wl_r_${hashOf([collection, field])}`;

/**
 * The name a collection is kept under, folded. Whether MySQL compares table names with or without case is the
 * host's `lower_case_table_names`, so the engine assumes the strict case: two names that fold together are one
 * table somewhere.
 */
export const folded = (name: string): string => name.toLowerCase();

/** An identifier as MySQL reads it whatever it spells: in backticks, with any backtick inside doubled. */
export const quoted = (name: string): string => `\`${name.replace(/`/g, '``')}\``;
