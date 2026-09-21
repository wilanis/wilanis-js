/**
 * P resolvers. A resolvers document names reads of the request; a data graph, a binding or a store binds each
 * read it takes under `reads`, local name -> `@path#resolver`, and reads {{name}}. Each document is judged once
 * here (P002, P003) and each entry of a `reads` map is judged where it is written (P004, P006, L002); whether
 * the trigger kinds that reach a read hand it is judged at the trigger (T004). Also `opNeeds`, which finds every
 * request.* path an operation reaches through its binding -- what B008, B009 and T004 hold their callers to --
 * as one reader of the walk `reach.ts` makes for the reach of a profile.
 *
 * The reads have one edge no document writes: a native call site over a scoped collection reads the reads that
 * collection is scoped by, because the compiler carries them there at lowering (RFC 0015). So a graph that
 * names no request at all still reaches one, and A006, T004 and B008 judge a scope's read the way they judge
 * any read a trigger reaches.
 */
import {
  type Loaded,
  type ResolverRead as ResolverSpec,
  type ResolversDoc,
  splitPath,
  splitRef,
  type Values,
} from '@wilanis/core';
import { collectionOf } from '../documents.js';
import { Walk } from '../reach.js';
import { type Judge, type JudgedResolver, RESERVED, type Refuser, readValuesOf } from './judge.js';

/**
 * One request.* path read under a trigger: where, and -- when the resolver declared itself required -- the
 * resolver's own path, which the trigger must guarantee.
 */
export interface RequestNeed {
  path: string[];
  file: string;
  required?: string[];
}

/** Judge a resolvers document: every name is free, every read is a path some trigger kind hands. */
export function checkResolversDoc(judge: Judge, doc: Loaded<ResolversDoc>): void {
  const refuse = judge.refuser(doc.path);
  const judged: Record<string, JudgedResolver> = {};
  for (const [name, spec] of Object.entries(doc.doc.resolvers)) {
    const resolver = judgeResolver(judge, refuse, name, spec);
    if (resolver) judged[name] = resolver;
  }
  judge.resolverReads.set(doc.path, judged);
}

function judgeResolver(judge: Judge, refuse: Refuser, name: string, spec: ResolverSpec): JudgedResolver | undefined {
  const at = `resolvers/${name}`;
  if (RESERVED.has(name)) {
    refuse(
      'P003',
      `resolver name '${name}' is reserved`,
      at,
      'in, const, request and secrets are roots; pick another name',
    );
    return undefined;
  }
  const path = splitPath(spec.read).slice(1);
  const read = judge.scope.requestRead(path);
  if (typeof read === 'string') {
    const hint = 'wilanis describe <trigger kind> shows what each kind hands as request.*';
    refuse('P002', `resolver '${name}': ${read}`, `${at}/read`, hint);
    return undefined;
  }
  // a resolver declared required is read as present; every trigger reaching it must then guarantee it (A006)
  const present = spec.required ? { type: read.type, optional: false } : read;
  return { path, read: present, required: Boolean(spec.required) };
}

/**
 * The resolvers a document may read, one per entry of its `reads` map, under the local name the entry gave
 * it -- a data graph's, a binding's or a store's, since every kind that binds a read is judged here. A domain
 * graph takes none: the request is the world's, and the domain never sees it (L002).
 */
export function resolversFor(
  judge: Judge,
  reads: Record<string, string> | undefined,
  from: Loaded,
  allowed: boolean,
): Record<string, JudgedResolver> {
  if (!reads) return {};
  const refuse = judge.refuser(from.path);
  if (!allowed) {
    const hint = 'read the request in the data layer: the data graph or the binding binds it under reads';
    refuse('L002', 'a domain graph never reads the request', 'reads', hint);
    return {};
  }
  const judged: Record<string, JudgedResolver> = {};
  for (const [name, ref] of Object.entries(reads)) {
    const resolver = readFor(judge, refuse, from, { name, ref });
    if (resolver) judged[name] = resolver;
  }
  return judged;
}

/**
 * P004, P006: one entry of a `reads` map, as the resolver it names. The local name is free (P006), and the
 * value addresses a resolver of a resolvers document -- `@path#name` -- so the path names a document that
 * exists (R001) and is visible (L005), and the document declares that name. The judged read answers under
 * the local name, and an entry refused here answers under none, so nothing downstream judges it twice.
 */
function readFor(
  judge: Judge,
  refuse: Refuser,
  from: Loaded,
  entry: { name: string; ref: string },
): JudgedResolver | undefined {
  const at = `reads/${entry.name}`;
  // P006: a name a value reads as a root would make {{name}} ambiguous, whoever bound it -- a graph, a
  // binding or a store. The half about a node's id is the graph's alone, and stays with the nodes it knows.
  if (RESERVED.has(entry.name)) {
    const hint = `${[...RESERVED].join(', ')} are roots; pick another name`;
    refuse('P006', `read name '${entry.name}' is reserved`, at, hint);
    return undefined;
  }
  const { path, op: resolver } = splitRef(entry.ref);
  if (!path || !resolver) {
    const hint = 'a read names one resolver: "@feature/edge/file.resolvers.json#name"';
    refuse('P004', `'${entry.ref}' is not a resolver reference`, at, hint);
    return undefined;
  }
  const doc = judge.scope.get('resolvers', path);
  if (!doc) {
    refuse('R001', `unknown resolvers document '${path}'`, at, 'wilanis ls resolvers');
    return undefined;
  }
  judge.visible(from, doc, at);
  const declared = judge.resolverReads.get(doc.path) ?? {};
  if (!(resolver in declared)) {
    const names = Object.keys(doc.doc.resolvers).join(', ') || 'none';
    const hint = `wilanis describe ${path} lists its resolvers: ${names}`;
    refuse('P004', `'${path}' declares no resolver '${resolver}'`, at, hint);
    return undefined;
  }
  return declared[resolver];
}

/** The resolvers a document reads, without refusing anything: the refusals were made where the map was judged. */
function quietResolvers(judge: Judge, reads: Record<string, string> | undefined): Record<string, JudgedResolver> {
  const judged: Record<string, JudgedResolver> = {};
  for (const [name, ref] of Object.entries(reads ?? {})) {
    const { path, op: resolver } = splitRef(ref);
    const doc = path ? judge.scope.get('resolvers', path) : undefined;
    const declared = doc ? (judge.resolverReads.get(doc.path) ?? {}) : {};
    if (resolver in declared) judged[name] = declared[resolver];
  }
  return judged;
}

/** The request.* paths a set of reads touches through the resolvers they name: what a trigger kind must hand. */
function requestNeedsOf(resolvers: Record<string, JudgedResolver>, reads: string[][], file: string): RequestNeed[] {
  const out: RequestNeed[] = [];
  for (const read of reads) {
    const resolver = resolvers[read[0]];
    if (!resolver) continue;
    out.push({
      path: [...resolver.path, ...read.slice(1)],
      file,
      required: resolver.required ? resolver.path : undefined,
    });
  }
  return out;
}

/**
 * The reads a native call site is scoped by: where the site is over a collection some store declares `scoped`,
 * the store's own `reads` for the names those columns fill, as if the site had written them. Nothing else
 * reaches them, and they are what makes a scope a read the trigger must guarantee.
 */
function scopeNeeds(judge: Judge, run: string, given: Values | undefined): RequestNeed[] {
  const site = collectionOf(judge.scope, { key: run, given });
  if (!site) return [];
  const store = judge.scope.registry.get('store', site.store);
  const scoped = store?.doc.collections[site.collection]?.scoped;
  if (!store || !scoped) return [];
  const resolvers = quietResolvers(judge, store.doc.reads);
  return requestNeedsOf(resolvers, judge.scope.templateReads(Object.values(scoped)), store.path);
}

/**
 * Every request.* path reachable from a domain port operation, through the binding that meets it under a
 * profile: one reader of the walk `reachOf` makes (reach.ts). A graph reads through its own `reads` and every
 * value its nodes write, a delegation through the binding's `reads` and its `in`, and a native site through the
 * reads the collection it is over is scoped by.
 */
export function opNeeds(judge: Judge, opRef: string, profile: string | undefined): RequestNeed[] {
  const out: RequestNeed[] = [];
  const walk = new Walk<undefined>(judge.scope, profile, {
    graph: graph => {
      const reads = graph.doc.nodes.flatMap(node => judge.scope.templateReads(readValuesOf(node)));
      out.push(...requestNeedsOf(quietResolvers(judge, graph.doc.reads), reads, graph.path));
    },
    delegation: (binding, _, bound) => {
      const resolvers = quietResolvers(judge, binding.doc.reads);
      out.push(...requestNeedsOf(resolvers, judge.scope.templateReads(bound.in), binding.path));
    },
    native: site => out.push(...scopeNeeds(judge, site.key, site.given)),
  });
  walk.operation(opRef, undefined);
  return out;
}
