/**
 * P resolvers. A resolvers document names reads of the request; a data graph or a binding binds each read it
 * takes under `reads`, local name -> `@path#resolver`, and reads {{name}}. Each document is judged once here
 * (P002, P003) and each entry of a `reads` map is judged where it is written (P004, L002); whether the trigger
 * kinds that reach a read hand it is judged at the trigger (T004). Also the walk that finds every request.*
 * path an operation reaches through its binding, which B008 and T004 hold their callers to.
 */
import {
  isSwitch,
  type Loaded,
  type ResolverRead as ResolverSpec,
  type ResolversDoc,
  splitPath,
  splitRef,
} from '@wilanis/core';
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
 * The resolvers a graph or binding may read, one per entry of its `reads` map, under the local name the entry
 * gave it. A domain graph takes none: the request is the world's, and the domain never sees it (L002).
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
 * P004: one entry of a `reads` map, as the resolver it names. The value addresses a resolver of a resolvers
 * document -- `@path#name` -- so the path names a document that exists (R001) and is visible (L005), and the
 * document declares that name. The local name is the author's, and the judged read answers under it.
 */
function readFor(
  judge: Judge,
  refuse: Refuser,
  from: Loaded,
  entry: { name: string; ref: string },
): JudgedResolver | undefined {
  const at = `reads/${entry.name}`;
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

/** Every request.* path reachable from a domain port operation, through the binding that meets it under a profile. */
export function opNeeds(
  judge: Judge,
  opRef: string,
  profile: string | undefined,
  seen = new Set<string>(),
): RequestNeed[] {
  const hit = judge.scope.op(opRef);
  if (typeof hit === 'string' || hit.port.native) return [];
  const binding = judge.scope.bindingFor(hit.path, profile);
  if (typeof binding === 'string') return [];
  const bound = binding.doc.operations[hit.opName];
  if (!bound) return [];
  if (bound.graph) return graphNeeds(judge, judge.scope.canon(bound.graph), profile, seen);
  const resolvers = quietResolvers(judge, binding.doc.reads);
  return requestNeedsOf(resolvers, judge.scope.templateReads(bound.in), binding.path);
}

/** Every request.* path read under a graph: its own `reads`, and per node the one binding operation it reaches. */
function graphNeeds(judge: Judge, graphPath: string, profile: string | undefined, seen: Set<string>): RequestNeed[] {
  if (seen.has(graphPath)) return [];
  seen.add(graphPath);
  const graph = judge.scope.registry.get('graph', graphPath);
  if (!graph) return [];
  const reads = graph.doc.nodes.flatMap(node => judge.scope.templateReads(readValuesOf(node)));
  const out = requestNeedsOf(quietResolvers(judge, graph.doc.reads), reads, graph.path);
  for (const node of graph.doc.nodes) {
    if (isSwitch(node)) continue;
    const hit = judge.scope.op(node.run);
    if (typeof hit === 'string' || hit.port.native) continue;
    out.push(...opNeeds(judge, node.run, profile, seen));
  }
  return out;
}
