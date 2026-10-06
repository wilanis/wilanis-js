/**
 * How a shape becomes a table, and how a value crosses into a column and back. This is the whole of what this
 * engine knows about types, and it lives here rather than anywhere in @storage, which never learns what a
 * column is.
 *
 * A string is `TEXT`, except where an index holds it: the key, a field of a `unique`, a field that `refs`
 * another collection. InnoDB indexes no `TEXT` without cutting it to a prefix, and a prefix would make "unique"
 * mean "unique in the first n characters", which is not what the store says. So such a string is a `VARCHAR`,
 * as wide as the index lets it be: InnoDB holds at most 3072 bytes in one index, `utf8mb4` takes four bytes a
 * character, so a string alone in an index is `VARCHAR(768)`, and strings that share one index share the 3072
 * bytes with each other and with the 8 a number takes and the 1 a boolean takes (`widthsOf`). A longer string
 * fails the node at the write, since the session is strict (`pools.ts`).
 *
 * Every string column is `COLLATE utf8mb4_bin`: the server's default collation compares without case, and
 * `"GET"` and `"get"` would then collide under a `unique` and match one `eq`. A boolean is `TINYINT(1)` held to
 * 0 or 1 by a `CHECK`. A shape, a list or `unknown` is `JSON`, with no `CHECK (JSON_VALID(x))`: MySQL refuses a
 * document that is not JSON at the write already, so the check would refuse nothing the type does not.
 */
import type { Type } from '@wilanis/core';
import type { At } from '@wilanis/plugin-storage';
import { quoted } from './names.js';

/** The bytes InnoDB holds in one index, and the bytes one `utf8mb4` character may take. */
const INDEX_BYTES = 3072;
const CHAR_BYTES = 4;
/** The widest string one index holds alone. */
export const WIDEST = INDEX_BYTES / CHAR_BYTES;

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

/** Is a value of this type kept as JSON, rather than as a column MySQL compares directly? */
export const isJson = (type: Type): boolean =>
  type.kind !== 'string' && type.kind !== 'number' && type.kind !== 'boolean' && type.kind !== 'blob';

/** The bytes a field that is not a string takes in an index: 8 for a number, 1 for a boolean. */
const fixedBytes = (type: Type | undefined): number => {
  if (type?.kind === 'number') return 8;
  return type?.kind === 'boolean' ? 1 : 0;
};

/** Every index the collection declares, as the fields each holds: the key, each `unique`, each `refs`. */
const indexesOf = (at: At): string[][] => [[at.key], ...at.unique, ...at.refs.map(ref => [ref.field])];

/**
 * The width of every string field an index holds, by field: the widest that lets every index it is in fit in
 * InnoDB's 3072 bytes. A string field that no index holds is not here, and is `TEXT`.
 */
export function widthsOf(at: At): Map<string, number> {
  const widths = new Map<string, number>();
  for (const fields of indexesOf(at)) {
    const strings = fields.filter(field => typeOf(at.shape, field)?.kind === 'string');
    if (!strings.length) continue;
    const fixed = fields.reduce((sum, field) => sum + fixedBytes(typeOf(at.shape, field)), 0);
    const width = Math.min(WIDEST, Math.floor((INDEX_BYTES - fixed) / (CHAR_BYTES * strings.length)));
    for (const field of strings) widths.set(field, Math.min(widths.get(field) ?? WIDEST, width));
  }
  return widths;
}

/**
 * The column type a field of this type is kept in, as `information_schema` spells it, or nothing where this
 * engine has no column for it. `width` is the field's from `widthsOf`, absent where no index holds it.
 */
export function columnTypeOf(type: Type, width?: number): string | undefined {
  if (type.kind === 'string') return width ? `varchar(${width})` : 'text';
  if (type.kind === 'number') return 'double';
  if (type.kind === 'boolean') return 'tinyint(1)';
  if (type.kind === 'blob') return undefined;
  return 'json';
}

/** The column a field is declared with: its type, the collation of a string, the `CHECK` of a boolean. */
export function declaredOf(field: Field, width?: number): { column: string; check?: string } {
  const type = columnTypeOf(field.type, width);
  if (!type)
    throw new Error(
      `'${field.name}' is a blob, and this engine has no column for one: its bytes live in the blob registry`,
    );
  if (field.type.kind === 'string') return { column: `${type.toUpperCase()} COLLATE utf8mb4_bin` };
  if (field.type.kind === 'boolean') return { column: type.toUpperCase(), check: `${quoted(field.name)} IN (0, 1)` };
  return { column: type.toUpperCase() };
}

/** A value as its column holds it: 0 or 1 for a boolean, JSON text for a shape, the value itself otherwise. */
export function bound(value: unknown, type: Type | undefined): unknown {
  if (value === undefined || value === null) return null;
  if (type && isJson(type)) return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

/** A column's value as the shape says it is: a boolean from 0 or 1, a value from JSON text, a number as one. */
export function unbound(value: unknown, type: Type): unknown {
  if (type.kind === 'boolean') return value === 1 || value === true || value === '1';
  if (type.kind === 'number') return Number(value);
  if (isJson(type)) return typeof value === 'string' ? JSON.parse(value) : value;
  return value;
}
