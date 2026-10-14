/**
 * Types against values: following a dotted path through a type (`typeAt`), the type a literal has, whether a
 * value conforms to a type at run time, and the JSON Schema a trigger validates the wire against.
 */
import {
  BLOB_HANDLE,
  BOOLEAN,
  EMPTY_LIST,
  isBlobHandle,
  isEmptyList,
  isTypeRef,
  type ListType,
  NUMBER,
  type ObjectType,
  type ObjField,
  type Read,
  STRING,
  show,
  type Type,
  UNKNOWN,
} from './types.js';

const INDEX = /^[0-9]+$/;

/** Follow a dotted path through a type. Indices and open keys are optional reads; unknown cannot be read into. */
export function typeAt(type: Type, path: string[]): Read | string {
  let current: Read = { type, optional: false };
  for (const segment of path) {
    const next = readInto(current, segment);
    if (typeof next === 'string') return next;
    current = next;
  }
  return current;
}

/** One step of a read: the segment inside what was read so far. */
function readInto(current: Read, segment: string): Read | string {
  const type = current.type.kind === 'blob' ? BLOB_HANDLE : current.type;
  if (type.kind === 'unknown' || type.kind === 'var')
    return `cannot read '${segment}' inside ${show(type)} -- forward it whole`;
  if (type.kind === 'list') {
    return INDEX.test(segment) ? { type: type.of, optional: true } : `'${segment}' is not an index into ${show(type)}`;
  }
  if (type.kind !== 'object') return `cannot read '${segment}' of ${show(type)}`;
  const field = type.fields[segment];
  if (field) return { type: field.type, optional: current.optional || !field.required };
  if (type.open) return { type: type.open, optional: true };
  return `no field '${segment}' in ${show(type)}`;
}

/** The type a literal has, as narrowly as it can be told. */
export function typeOfValue(value: unknown): Type {
  if (value === null || value === undefined) return UNKNOWN;
  if (typeof value === 'string') return { kind: 'string', enum: [value] };
  if (typeof value === 'number') return NUMBER;
  if (typeof value === 'boolean') return BOOLEAN;
  if (Array.isArray(value)) return value.length ? { kind: 'list', of: widen(value.map(typeOfValue)) } : EMPTY_LIST;
  const fields: Record<string, ObjField> = {};
  for (const [name, item] of Object.entries(value as object))
    fields[name] = { type: typeOfValue(item), required: true };
  return { kind: 'object', fields, open: false };
}

/**
 * The one type a list of literals has: strings widen to string; a mixed list is unknown. An empty list among
 * lists says nothing of their items, so the first member that is not one sets the type.
 */
function widen(types: Type[]): Type {
  const first = types.find(type => !isEmptyList(type)) ?? types[0];
  if (!types.every(type => type.kind === first.kind)) return UNKNOWN;
  return first.kind === 'string' ? STRING : first;
}

/** Runtime check of a value against a type; returns the first problem or null. */
export function conforms(value: unknown, type: Type, at = '$'): string | null {
  const problem = problemOf(value, type);
  return problem === null ? null : at + problem;
}

/**
 * The first problem of a value against a type, written from the value itself: `: expected string`, `[3]: expected
 * string`, `.name: required`. Each caller prefixes where the value sits only once a problem is found, so a value that
 * conforms costs no text at all, however many elements and fields it has.
 */
function problemOf(value: unknown, type: Type): string | null {
  switch (type.kind) {
    case 'unknown':
    case 'var':
      return null;
    case 'type':
      return isTypeRef(value) ? null : ': expected a type reference';
    case 'string':
      return problemOfString(value, type.enum);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : ': expected number';
    case 'boolean':
      return typeof value === 'boolean' ? null : ': expected boolean';
    case 'blob':
      return isBlobHandle(value) ? null : ': expected a blob (the handle of a stored file: id, contentType, size)';
    case 'list':
      return problemOfList(value, type);
    case 'object':
      return problemOfObject(value, type);
  }
}

function problemOfString(value: unknown, allowed: string[] | undefined): string | null {
  if (typeof value !== 'string') return ': expected string';
  if (allowed && !allowed.includes(value))
    return `: ${JSON.stringify(value)} not in ${show({ kind: 'string', enum: allowed })}`;
  return null;
}

/** A list: an array no longer than its bound, each item conforming to what it is a list of. */
function problemOfList(value: unknown, type: ListType): string | null {
  if (!Array.isArray(value)) return ': expected list';
  if (type.max !== undefined && value.length > type.max) return `: at most ${type.max} items`;
  for (let index = 0; index < value.length; index++) {
    const bad = problemOf(value[index], type.of);
    if (bad) return `[${index}]${bad}`;
  }
  return null;
}

function problemOfObject(value: unknown, type: ObjectType): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ': expected object';
  const object = value as Record<string, unknown>;
  for (const [name, field] of Object.entries(type.fields)) {
    const bad = problemOfField(object[name], field);
    if (bad) return `.${name}${bad}`;
  }
  return problemOfExtras(object, type);
}

/** One declared field: absent is fine unless required; present must conform. */
function problemOfField(value: unknown, field: ObjField): string | null {
  if (value === undefined) return field.required ? ': required' : null;
  return problemOf(value, field.type);
}

/** Keys the type does not declare: refused when it is closed, judged against what it is open to otherwise. */
function problemOfExtras(object: Record<string, unknown>, type: ObjectType): string | null {
  for (const name of Object.keys(object)) {
    if (type.fields[name]) continue;
    if (!type.open) return `.${name}: not a declared field`;
    const bad = problemOf(object[name], type.open);
    if (bad) return `.${name}${bad}`;
  }
  return null;
}

/**
 * The value with the keys a closed object type does not declare dropped, at every depth; open objects and unknown
 * pass through. What a trigger's `out` is pruned to, and what a `make` narrowing a value it reads whole keeps.
 */
export function prune(value: unknown, type: Type): unknown {
  if (type.kind === 'list' && Array.isArray(value)) return value.map(each => prune(each, type.of));
  if (type.kind !== 'object' || !value || typeof value !== 'object' || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [name, each] of Object.entries(value as Record<string, unknown>)) {
    const field = type.fields[name];
    if (field) out[name] = prune(each, field.type);
    else if (type.open) out[name] = each;
  }
  return out;
}

/** JSON Schema (2020-12) for a type: what a trigger validates the wire against. */
export function toJsonSchema(type: Type): Record<string, unknown> {
  switch (type.kind) {
    case 'unknown':
    case 'var':
      return {};
    case 'type':
      return { type: 'string' };
    case 'string':
      return type.enum ? { type: 'string', enum: type.enum } : { type: 'string' };
    case 'number':
      return { type: 'number' };
    case 'boolean':
      return { type: 'boolean' };
    case 'blob':
      return toJsonSchema(BLOB_HANDLE);
    case 'list':
      return { type: 'array', items: toJsonSchema(type.of), ...(type.max === undefined ? {} : { maxItems: type.max }) };
    case 'object':
      return objectSchema(type);
  }
}

function objectSchema(type: ObjectType): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, field] of Object.entries(type.fields)) {
    properties[name] = toJsonSchema(field.type);
    if (field.required) required.push(name);
  }
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: type.open ? toJsonSchema(type.open) : false,
  };
}
