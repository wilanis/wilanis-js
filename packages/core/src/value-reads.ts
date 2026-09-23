/**
 * Typing a value a document writes: a literal by what it is, a `{{template}}` by what its root reads in the
 * caller's context, a list by its members and an object field by field. It knows nothing of the tree: what a
 * root reads is the caller's to answer, which is why `Scope` delegates here rather than holding it.
 */
import { splitPath, TEMPLATE, WHOLE_TEMPLATE } from './templates.js';
import { type Read, STRING, type Type, UNKNOWN } from './types.js';
import { typeOfValue } from './values.js';

/**
 * Types the root of a template read in the caller's context. A string answer is the reason it cannot be read;
 * undefined means the reason was already reported.
 */
export type ResolveRoot = (root: string, path: string[]) => Read | string | undefined;

const SCALARS = new Set(['string', 'number', 'boolean', 'unknown']);

/**
 * The type of a value: a literal by what it is, a template by `resolve` (root and path in the caller's context).
 * A string answer is the reason it cannot be typed; undefined means the reason was already reported.
 */
export function valueRead(value: unknown, resolve: ResolveRoot): Read | string | undefined {
  if (typeof value === 'string') return stringRead(value, resolve);
  if (Array.isArray(value)) return listRead(value, resolve);
  if (value && typeof value === 'object') return objectRead(value as Record<string, unknown>, resolve);
  return { type: typeOfValue(value), optional: false };
}

/** A whole template takes the type of what it reads; text with templates is a string, optional when any read is. */
function stringRead(value: string, resolve: ResolveRoot): Read | string | undefined {
  const whole = WHOLE_TEMPLATE.exec(value);
  if (whole) {
    const [root, ...path] = splitPath(whole[1]);
    return resolve(root, path);
  }
  let optional = false;
  for (const match of value.matchAll(TEMPLATE)) {
    const [root, ...path] = splitPath(match[1]);
    const read = resolve(root, path);
    if (typeof read !== 'object') return read;
    if (!SCALARS.has(read.type.kind)) return `{{${match[1]}}} is ${read.type.kind}; only scalars interpolate into text`;
    optional ||= read.optional;
  }
  return { type: value.includes('{{') ? STRING : typeOfValue(value), optional };
}

/** A list types as a list of its first member; every member must type. */
function listRead(value: unknown[], resolve: ResolveRoot): Read | string | undefined {
  if (!value.length) return { type: { kind: 'list', of: UNKNOWN }, optional: false };
  const first = valueRead(value[0], resolve);
  if (typeof first !== 'object') return first;
  for (const item of value.slice(1)) {
    const read = valueRead(item, resolve);
    if (typeof read !== 'object') return read;
  }
  return { type: { kind: 'list', of: first.type }, optional: false };
}

/** An object types field by field; a member that may be missing is an optional field. */
function objectRead(value: Record<string, unknown>, resolve: ResolveRoot): Read | string | undefined {
  const fields: Record<string, { type: Type; required: boolean }> = {};
  for (const [name, item] of Object.entries(value)) {
    const read = valueRead(item, resolve);
    if (read === undefined) return undefined;
    if (typeof read === 'string') return `${name}: ${read}`;
    fields[name] = { type: read.type, required: !read.optional };
  }
  return { type: { kind: 'object', fields, open: false }, optional: false };
}

/** Every template root and path a value reads, anywhere inside it. */
export function templateReads(value: unknown, out: string[][] = []): string[][] {
  if (typeof value === 'string') for (const match of value.matchAll(TEMPLATE)) out.push(splitPath(match[1]));
  else if (Array.isArray(value)) for (const item of value) templateReads(item, out);
  else if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) templateReads(item, out);
  }
  return out;
}
