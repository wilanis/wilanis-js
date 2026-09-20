/**
 * Lowering values to kernel sources. A literal bakes; a whole {{template}} reads a node, the input, a resolver
 * (a read below request) or a constant; text with templates concatenates; lists and objects lower each member.
 * Also the scope a site over a scoped collection carries, which no document writes, and the secret paths of a
 * type, which a call's report redacts.
 */
import {
  type Loaded,
  type Scope,
  type StoreDoc,
  splitPath,
  splitRef,
  TEMPLATE,
  type Type,
  type Values,
  WHOLE_TEMPLATE,
} from '@wilanis/core';
import { type KSource, readPath } from '@wilanis/engine';
import { type CallSite, collectionOf } from './documents.js';

/** The roots a value may read where it is written, and how each lowers. */
export interface Roots {
  /** resolver name -> the segments it reads below request */
  resolvers: Record<string, string[]>;
  /** constant name -> baked value */
  consts?: Record<string, unknown>;
  /** may read request.* (a resolver's own in) */
  request?: boolean;
  /** may read other nodes by id (a graph node's in) */
  nodes?: boolean;
  /**
   * Roots the compiler answers under another name: what a guard renames (RFC 0007). A guarded taken site puts
   * the judged value at `in:ok` and leaves the caller's own at `in`, so every authored `{{in}}` must read
   * `in:ok` instead. It is a rename of the root alone -- the path below it is untouched -- and it is applied
   * after the named roots, so a resolver or a constant of the same name still means what it meant.
   */
  aliases?: Record<string, string>;
}

/** One template read as a source: a resolver reads below request, a constant bakes, the rest read their root. */
function lowerRef(template: string, roots: Roots): KSource {
  const [named, ...path] = splitPath(template);
  if (roots.resolvers[named]) return { ref: 'request', path: [...roots.resolvers[named], ...path] };
  const root = roots.aliases?.[named] ?? named;
  if (named === 'in') return { ref: root, path };
  if (named === 'const' && roots.consts) return { value: readPath(roots.consts[path[0]], path.slice(1)) };
  if (named === 'request' && roots.request) return { ref: root, path };
  if (roots.nodes) return { ref: root, path };
  throw new Error(`unresolvable template {{${template}}}`);
}

/** Text with templates in it: the literal pieces and the reads, in order. */
function lowerText(text: string, roots: Roots): KSource {
  const parts: (string | KSource)[] = [];
  let last = 0;
  for (const match of text.matchAll(TEMPLATE)) {
    const index = match.index ?? 0;
    if (index > last) parts.push(text.slice(last, index));
    parts.push(lowerRef(match[1], roots));
    last = index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return { concat: parts };
}

function lowerString(text: string, roots: Roots): KSource {
  const whole = WHOLE_TEMPLATE.exec(text);
  if (whole) return lowerRef(whole[1], roots);
  return text.includes('{{') ? lowerText(text, roots) : { value: text };
}

/** One value as a source. */
export function lowerValue(value: unknown, roots: Roots): KSource {
  if (typeof value === 'string') return lowerString(value, roots);
  if (Array.isArray(value)) return { list: value.map(item => lowerValue(item, roots)) };
  if (value && typeof value === 'object') return { object: lowerValues(value as Values, roots) };
  return { value };
}

/** Every named value as a source. */
export function lowerValues(values: Values | undefined, roots: Roots): Record<string, KSource> {
  return Object.fromEntries(Object.entries(values ?? {}).map(([name, value]) => [name, lowerValue(value, roots)]));
}

/** Inputs passed on from the caller's by name. */
export function inputsByName(names: string[]): Record<string, KSource> {
  return Object.fromEntries(names.map(name => [name, { ref: 'in', path: [name] }]));
}

/** A map's bind, each dotted path split; nothing when the element arrives whole as `item`. */
export function bindPaths(bind: Record<string, string> | undefined): Record<string, string[]> | undefined {
  if (!bind) return undefined;
  return Object.fromEntries(Object.entries(bind).map(([name, path]) => [name, path ? path.split('.') : []]));
}

/** The input a scoped site carries its scope under, which no document may write (RFC 0015). */
export const SCOPE = 'scope';

/**
 * The scope a native call site carries, or nothing where it is over no scoped collection: one key per column
 * the collection declares `scoped`, each the read the store binds for it, lowered exactly as `lowerRef` lowers
 * `{{tenant}}` on a graph. No node is added and nothing runs -- a scope is a source reference like any resolver
 * read -- and no document writes it, so there is nowhere to forget one (RFC 0015).
 *
 * Which operations carry one is the port's own word, read off the `scope` input it declares: `newKey` declares
 * none, because a key is global to the table whatever the scope. So nothing here learns which operations a
 * store has, only that this one takes a scope and is over a collection that has one.
 */
export function lowerScope(scope: Scope, site: CallSite): KSource | undefined {
  if (!takesScope(scope, site.key)) return undefined;
  const over = collectionOf(scope, site);
  const store = over && scope.registry.get('store', over.store);
  const scoped = over && store?.doc.collections[over.collection]?.scoped;
  if (!store || !scoped) return undefined;
  const roots: Roots = { resolvers: storeRoots(scope, store) };
  return { object: lowerValues(scoped, roots) };
}

/** Whether the operation a site names carries a scope at all: the port says so by declaring the input. */
export function takesScope(scope: Scope, key: string): boolean {
  const hit = scope.op(key);
  if (typeof hit === 'string' || !hit.port.native) return false;
  return Boolean(hit.op.accepts?.[SCOPE]);
}

/** A store's `reads`: local name -> the segments read below request, as a graph's `reads` lower. */
function storeRoots(scope: Scope, store: Loaded<StoreDoc>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, ref] of Object.entries(store.doc.reads ?? {})) {
    const { path, op } = splitRef(ref);
    const read = path ? scope.get('resolvers', path)?.doc.resolvers[op] : undefined;
    if (read) out[name] = splitPath(read.read).slice(1);
  }
  return out;
}

const SECRET_DEPTH = 6;

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
