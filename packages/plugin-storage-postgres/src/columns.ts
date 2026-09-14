/**
 * How a shape becomes a table. This is the whole of what this engine knows about types, and it lives here
 * rather than anywhere in @storage, which never learns what a column is.
 *
 * A collection is a table in the connection's schema, named as the collection is named; a field is a column,
 * named as the field is named. What the shape says is required is `NOT NULL`, and the collection's key is the
 * primary key. Nothing is inferred from a value: the shape is the whole story, so a table made from a shape
 * and a table made from the same shape a year later are the same table.
 */
import type { Type } from '@wilanis/core';

/**
 * The column type a field of this type is kept in, or nothing where this engine has no column for it. An enum
 * is a string with a list of values, so it is `text` and the handler judges the value against the shape --
 * the database is not asked to hold a rule the shape already states.
 */
export function columnOf(type: Type): string | undefined {
  if (type.kind === 'string') return 'text';
  if (type.kind === 'number') return 'double precision';
  if (type.kind === 'boolean') return 'boolean';
  if (type.kind === 'blob') return undefined;
  return 'jsonb';
}

/** Is a value of this type kept as JSON, rather than as a column the database can compare directly? */
export function isJson(type: Type): boolean {
  return columnOf(type) === 'jsonb';
}

/** The fields of a record shape, in the order the shape declares them. */
export function fieldsOf(shape: Type): { name: string; type: Type; required: boolean }[] {
  if (shape.kind !== 'object') return [];
  return Object.entries(shape.fields).map(([name, field]) => ({
    name,
    type: field.type,
    required: field.required !== false,
  }));
}

/**
 * A name PostgreSQL will take unquoted and mean the same by: what `ensure` creates and every statement names.
 * Postgres folds an unquoted identifier to lower case, so two collections differing only in case would be one
 * table; X223 refuses that before anything runs, and this is the fold it judges by.
 */
export function folded(name: string): string {
  return name.toLowerCase();
}

/** Is this a legal table or column name for this engine, unquoted and unfolded into something else? */
export function legal(name: string): boolean {
  return /^[a-z_][a-z0-9_]*$/.test(folded(name)) && folded(name).length <= 63;
}
