/**
 * Where a type marks a field secret: the paths a report redacts, which the compiler lowers onto every call and
 * whatever logs or records a run's answer reads off the trigger's `out`. A path names fields only; a list adds no
 * segment, since whoever redacts walks each element of a list it meets.
 */
import type { Type } from './types.js';

/** How deep the walk goes into a type, a list counting as one level: a bound on a type that nests itself. */
export const SECRET_DEPTH = 6;

/** Every path to a secret field inside a type, to a bounded depth. */
export function secretPaths(
  type: Type | undefined,
  prefix: string[] = [],
  out: string[][] = [],
  depth = 0,
): string[][] {
  if (!type || depth > SECRET_DEPTH) return out;
  if (type.kind === 'list') secretPaths(type.of, prefix, out, depth + 1);
  if (type.kind !== 'object') return out;
  for (const [name, field] of Object.entries(type.fields)) {
    if (field.secret) out.push([...prefix, name]);
    else secretPaths(field.type, [...prefix, name], out, depth + 1);
  }
  return out;
}
