/**
 * Which lists a type leaves unbounded: the fields, at any depth, whose type is a list with no `maxItems`. It is
 * what T008 asks of a public trigger's edge shapes, and it walks the resolved type, so a field is found however
 * it is reached -- through a named shape, an inline object, or the element of a list of objects.
 */
import type { Type } from '@wilanis/core';

/** One unbounded list: the dotted path to its field from the walked type, and the shape that declares it. */
export interface Unbounded {
  field: string;
  shape: string | undefined;
}

/**
 * Every field under a type whose value is a list without a bound. A list's elements are walked for the objects
 * they hold, not judged as lists themselves: `maxItems` is written on a field, so only a field's own list can
 * carry one. `unknown` and what an open object admits beyond its fields are not lists and are not judged.
 */
export function unboundedLists(type: Type): Unbounded[] {
  const found: Unbounded[] = [];
  walk(type, { path: [], shape: undefined, seen: new Set(), found });
  return found;
}

interface Walk {
  path: string[];
  shape: string | undefined;
  seen: Set<Type>;
  found: Unbounded[];
}

function walk(type: Type, at: Walk): void {
  if (type.kind === 'list') {
    walk(type.of, at);
    return;
  }
  if (type.kind !== 'object' || at.seen.has(type)) return;
  const seen = new Set(at.seen).add(type);
  const shape = type.name ?? at.shape;
  for (const [name, field] of Object.entries(type.fields)) {
    const path = [...at.path, name];
    if (field.type.kind === 'list' && field.type.max === undefined) at.found.push({ field: path.join('.'), shape });
    walk(field.type, { path, shape, seen, found: at.found });
  }
}

/** The file name a hint names a shape by, or the trigger's own words when the list sits in no named shape. */
export function shapeName(shape: string | undefined): string {
  return shape ? (shape.split('/').pop() ?? shape) : 'the inline object';
}
