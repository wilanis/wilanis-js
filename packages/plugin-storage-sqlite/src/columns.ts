/**
 * How a shape becomes a table, and how a value crosses into a column and back. This is the whole of what this
 * engine knows about types, and it lives here rather than anywhere in @storage, which never learns what a
 * column is.
 *
 * SQLite has fewer column types than a shape has field types, so two of them are kept in another type with a
 * `CHECK` that holds the difference: a boolean is an `INTEGER` that is 0 or 1, and a shape, a list or `unknown`
 * is `TEXT` that is valid JSON. The driver binds neither a boolean nor an object, so every value is turned into
 * what its column holds on the way in (`bound`) and back into what the shape says on the way out (`unbound`).
 */
import type { Type } from '@wilanis/core';
import { type FieldType, fieldTypeOf } from '@wilanis/plugin-storage';
import { columnFor } from './ddl.js';

export { quoted } from './ddl.js';

/** One field of a record shape, as a column is made from it. */
export interface Field {
  name: string;
  type: Type;
  required: boolean;
}

/** The fields of a record shape, in the order the shape declares them. */
export function fieldsOf(shape: Type): Field[] {
  if (shape.kind !== 'object') return [];
  return Object.entries(shape.fields).map(([name, field]) => ({
    name,
    type: field.type,
    required: field.required !== false,
  }));
}

/** The type of one field of the record shape, or nothing where the shape has no such field. */
export const typeOf = (shape: Type, field: string): Type | undefined =>
  shape.kind === 'object' ? shape.fields[field]?.type : undefined;

/**
 * The column type a field of this type is kept in, or nothing where this engine has no column for it. An enum
 * is a string with a list of values, so it is `TEXT` and the handler judges the value against the shape.
 */
export function columnOf(type: Type): string | undefined {
  return type.kind === 'blob' ? undefined : columnFor(fieldTypeOf(type));
}

/** Is a value of this type kept as JSON text, rather than as a column SQLite can compare directly? */
export const isJson = (type: Type): boolean => type.kind !== 'blob' && fieldTypeOf(type) === 'json';

/** A value as its column holds it: 0 or 1 for a boolean, JSON text for a shape, the value itself otherwise. */
export function bound(value: unknown, type: Type | undefined): unknown {
  if (value === undefined || value === null) return null;
  if (type && isJson(type)) return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

/** A column's value as the shape says it is: a boolean from 0 or 1, a value from JSON text, a number as one. */
export function unbound(value: unknown, type: Type): unknown {
  if (type.kind === 'boolean') return value === 1 || value === 1n || value === true;
  if (type.kind === 'number') return Number(value);
  if (isJson(type)) return typeof value === 'string' ? JSON.parse(value) : value;
  return value;
}

/** The field type a field is kept as, which `ddl.ts` writes the column for; a blob has none, and is refused. */
export function storedOf(name: string, type: Type): FieldType {
  if (type.kind === 'blob')
    throw new Error(`'${name}' is a blob, and this engine has no column for one: its bytes live in the blob registry`);
  return fieldTypeOf(type);
}
