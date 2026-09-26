/**
 * What every graph `wilanis new graph` writes is built from: a run node and a switch, the words its ids are joined
 * from, and what the scaffold reads of the tree to name them -- the shape a store keeps a collection of, an
 * operation a port declares, the fields a shape has. A document the tree does not have, or that is not JSON,
 * answers nothing, and the scaffold writes TODO in its place.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeResolver, stem } from '@wilanis/core';

/** The flags `wilanis new graph` was given, by name. */
export type Opts = Record<string, string | undefined>;

/** A run node, which is most of what a graph is made of. */
export function run(id: string, label: string, op: string, values: Record<string, unknown>): Record<string, unknown> {
  return { type: '@wilanis/node/run.schema.json', id, label, run: op, in: values };
}

/** What a switch node is made of: what it reads, the rules in order, and the node nothing else routed to. */
export interface Routing {
  id: string;
  label: string;
  in: Record<string, unknown>;
  rules: { when: string; to: string }[];
  otherwise: string;
}

/** A switch node: the rules in order, and the node nothing else routed to. */
export function route(routing: Routing): Record<string, unknown> {
  const { otherwise, ...rest } = routing;
  return { type: '@wilanis/node/switch.schema.json', ...rest, else: otherwise };
}

/** A word with its first letter raised, to join it onto another: customer becomes Customer. */
export const raised = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/** A word with its first letter lowered, to start an id with it: Customer becomes customer. */
const lowered = (word: string) => word.charAt(0).toLowerCase() + word.slice(1);

/** The store and the collection a write names, TODO where the flags do not say. */
export function storeOf(opts: Opts): Record<string, string> {
  return { store: opts.store ?? '@features/TODO/data/TODO.store.json', collection: opts.collection ?? 'TODO' };
}

/** A document of the tree by the path a flag gives, its aliases resolved; nothing where the tree has no such file. */
export function docOf<T>(root: string, ref: string | undefined): T | undefined {
  if (!ref) return undefined;
  try {
    const project = join(root, 'project.json');
    const aliases = existsSync(project)
      ? ((JSON.parse(readFileSync(project, 'utf8')) as { aliases?: Record<string, string> }).aliases ?? {})
      : {};
    const path = makeResolver(aliases, new Set())(ref);
    if (!path.startsWith('@features/')) return undefined;
    const file = join(root, path.slice(1));
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : undefined;
  } catch {
    return undefined;
  }
}

/** The shape the store the flags name keeps its collection of, where the tree has that store. */
export function storedShape(root: string, opts: Opts): string | undefined {
  type Store = { collections?: Record<string, { of?: string }> };
  return docOf<Store>(root, opts.store)?.collections?.[opts.collection ?? '']?.of;
}

/** The noun every id is built on: the stem of the shape, or `record` where nothing names one. */
export function nounOf(shape: string | undefined): string {
  const named = shape ? lowered(stem(shape)) : '';
  return /^[a-z][A-Za-z0-9]*$/.test(named) ? named : 'record';
}
