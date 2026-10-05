/**
 * A record on its way into a row and a row on its way back into a record. Every field crosses through the
 * column it is kept in (`columns.ts`): a boolean as 0 or 1, a shape as JSON text. What comes back is judged
 * against the shape before it is answered, so a row written outside wilanis that no longer fits fails the node
 * rather than reaching a graph.
 */
import { conforms } from '@wilanis/core';
import type { At, Record_ } from '@wilanis/plugin-storage';
import { bound, fieldsOf, typeOf, unbound } from './columns.js';

/** The columns a select asks for: every field the shape has, and nothing the table may also hold. */
export const columnsOf = (at: At): string[] => fieldsOf(at.shape).map(field => field.name);

/** A key as its column holds it. */
export const keyIn = (at: At, key: unknown): unknown => bound(key, typeOf(at.shape, at.key));

/** What a row becomes on its way back out: the record the shape describes, or the reason it is not one. */
export function recordOf(row: Record<string, unknown> | undefined, at: At): Record_ | undefined {
  if (!row) return undefined;
  const out: Record_ = {};
  for (const field of fieldsOf(at.shape)) {
    const value = row[field.name];
    if (value === null || value === undefined) continue;
    out[field.name] = unbound(value, field.type);
  }
  const bad = conforms(out, at.shape, at.name);
  if (bad) throw new Error(`${at.name}: a row this collection holds is no longer of its shape: ${bad}`);
  return out;
}

/**
 * What a record becomes on its way in: a column per field of the shape. Every field is written, absent ones as
 * null -- a `put` writes the whole record, so a field the caller left out is one the stored record no longer has.
 */
export function rowOf(given: Record_, at: At): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fieldsOf(at.shape)) out[field.name] = bound(given[field.name], field.type);
  return out;
}

/** What a patch sets: only the fields it names, so every field it does not name stays exactly as it was. */
export function changedOf(changes: Record_, at: At): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fieldsOf(at.shape))
    if (field.name in changes) out[field.name] = bound(changes[field.name], field.type);
  return out;
}
