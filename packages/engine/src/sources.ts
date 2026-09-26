/**
 * Reading kernel sources: which nodes a source names, and the value it yields once they have settled.
 * A source is a leaf (a literal, a read of a node or pseudo-node) or a composite of sources (a list, an
 * object, text with sources interpolated).
 */
import type { KNode, KSource } from './spec.js';

/** The roots the embedder supplies rather than a node computes. */
export const PSEUDO = new Set(['in', 'const', 'request']);

/** The sources nested inside a composite source; none for a leaf. */
function partsOf(source: KSource): KSource[] {
  if ('list' in source) return source.list;
  if ('object' in source) return Object.values(source.object);
  if ('concat' in source) return source.concat.filter((part): part is KSource => typeof part !== 'string');
  return [];
}

/** Every node id (or pseudo-node) a source reads. */
export function refsOf(source: KSource, out = new Set<string>()): Set<string> {
  if ('ref' in source) out.add(source.ref);
  for (const part of partsOf(source)) refsOf(part, out);
  return out;
}

/** Every source a node reads: its inputs, and for a map the list it iterates. */
export function sourcesOf(node: KNode): KSource[] {
  const sources = Object.values(node.in);
  return node.kind === 'map' ? [...sources, node.over] : sources;
}

/** Every node id (or pseudo-node) a node reads. */
export function nodeRefs(node: KNode): Set<string> {
  const out = new Set<string>();
  for (const source of sourcesOf(node)) refsOf(source, out);
  return out;
}

/** The value at a dotted path inside a value; undefined once the path leaves it. */
export function readPath(value: unknown, path: string[]): unknown {
  let current: unknown = value;
  for (const segment of path) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      current = current[Number(segment)];
      continue;
    }
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** How one read of a root at a path is answered: the values settled so far, or a reader over what reports show. */
export type Reader = (ref: string, path: string[]) => unknown;

/** A reader over settled values: the value at the path inside the root's value. */
const readerOf = (values: Map<string, unknown> | Reader): Reader =>
  values instanceof Map ? (ref, path) => readPath(values.get(ref), path) : values;

/** The value a source yields, given the values settled so far -- or what a reader answers for each read. */
export function readSource(source: KSource, values: Map<string, unknown> | Reader): unknown {
  const read = readerOf(values);
  if ('value' in source) return source.value;
  if ('ref' in source) return read(source.ref, source.path);
  if ('list' in source) return source.list.map(part => readSource(part, read)).filter(item => item !== undefined);
  if ('concat' in source) return source.concat.map(part => interpolated(part, read)).join('');
  return readAll(source.object, read);
}

/** One piece of interpolated text: literal text as it is, a source as text, a missing value as nothing. */
function interpolated(part: string | KSource, read: Reader): string {
  return typeof part === 'string' ? part : String(readSource(part, read) ?? '');
}

/** Every named source read; a key whose value is undefined is left out. */
export function readAll(
  sources: Record<string, KSource>,
  values: Map<string, unknown> | Reader,
): Record<string, unknown> {
  const read = readerOf(values);
  const out: Record<string, unknown> = {};
  for (const [key, source] of Object.entries(sources)) {
    const value = readSource(source, read);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** A dotted list of every root path a source reads, for `needs`. */
export function rootPaths(source: KSource, out: string[] = []): string[] {
  if ('ref' in source) out.push([source.ref, ...source.path].join('.'));
  for (const part of partsOf(source)) rootPaths(part, out);
  return out;
}
