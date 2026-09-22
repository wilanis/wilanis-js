/**
 * Where a rehearsed switch is, and what runs under one node.
 *
 * A run is deeper than the documents that describe it. A trigger fires a port operation, which lowers to a
 * wrapper spec; the wrapper calls the bound graph; that graph calls others through their own bindings; and,
 * where a field invariant could not be proved over a list (RFC 0007), a `map` runs each element through a
 * nested spec the compiler made out of the invariant and no document holds. A decision has to be named by the
 * graph its author wrote, so the walk has to know, at every step, which of those things it descended into.
 *
 * That is the whole of this module: resolving a node's handler to the spec behind it, and a dotted path to the
 * graph -- and the guarded site -- it belongs to, and to the type its node declares it answers. `rehearse.ts`
 * beside it walks and runs; nothing here runs anything or reads a report.
 */
import { guardSpecAt } from '@wilanis/compiler';
import { type BindingDoc, hasVars, type Loaded, type Operation, type TriggerDoc, type Type } from '@wilanis/core';
import type { Embedder } from './embed.js';

/** A lowered spec as this walk reads one: its nodes by id, whatever each of them turns out to be. */
export type Spec = { nodes: Record<string, unknown> };

/**
 * Where a switch is, as a decision names it: the graph document it belongs to, and -- when it sits inside the
 * nested spec a list site's guard runs -- the site in that graph whose guard it is. A list guard's spec is
 * reached through a `map`, so the walk descends into something no document holds; a decision that named only
 * the graph would call the guard's own switch an authored one, because its ids inside the nested spec are the
 * fixed `in:*` rather than the site's `<id>:*`.
 */
export interface Where {
  graph: string;
  /** the guarded site the switch is inside the guard of, where the walk descended into a guard's nested spec */
  site?: string;
}

/** The spec of a graph named directly, or nothing when the tree does not hold one under that path. */
export function graphSpec(emb: Embedder, ref: string): Spec | undefined {
  try {
    return emb.graph(ref).spec;
  } catch {
    return undefined;
  }
}

/** The graph a binding operation runs, when its handler names one. */
export function bindingGraph(emb: Embedder, handler: string): string | undefined {
  const hash = handler.lastIndexOf('#');
  if (hash < 0) return undefined;
  const [path, opName] = [handler.slice(0, hash), handler.slice(hash + 1)];
  try {
    return (emb.scope.get('binding', path)?.doc as BindingDoc | undefined)?.operations?.[opName]?.graph;
  } catch {
    return undefined;
  }
}

/**
 * The spec behind one node's handler, whatever kind of thing the compiler put there: a graph it names, the
 * nested spec a list site's guard runs, or the wrapper a binding operation lowers to. A binding lowers to a
 * spec holding a single node `op`, so a graph reached through a binding sits one level deeper than the
 * document suggests: the kernel stubs it at `<node>.op.<id>`, and the walk is handed that shape rather than
 * the bound graph, so the prefixes it records match the paths a run reports.
 *
 * A guard's spec is asked for by name because it is neither a graph nor a binding -- the compiler made it out
 * of an invariant and no document holds it -- and a walk that could not open it would leave every list site's
 * guard unrehearsed, which is what #437 was.
 */
export function specBehind(emb: Embedder, handler: string): Spec | undefined {
  if (handler.startsWith('graph:')) return graphSpec(emb, handler.slice('graph:'.length));
  if (guardSpecAt(handler)) return emb.guardSpec(handler);
  const ref = bindingGraph(emb, handler);
  return ref ? { nodes: { op: { kind: 'call', handler: `graph:${ref}` } } } : undefined;
}

/**
 * The operation a handler meets: the port operation behind a binding's, or the one it names itself. A graph
 * reached by `graph:` answers its own `out` instead, so it names none.
 */
function operationOf(emb: Embedder, handler: string): Operation | undefined {
  const hash = handler.lastIndexOf('#');
  const binding = hash < 0 ? undefined : emb.scope.get('binding', handler.slice(0, hash))?.doc;
  const hit = emb.scope.op(binding ? `${binding.port}#${handler.slice(hash + 1)}` : handler);
  return typeof hit === 'string' ? undefined : hit.op;
}

/** What a handler declares it answers, where the declaration is closed: no type variable a call site binds. */
function answeredBy(emb: Embedder, handler: string): Type | undefined {
  try {
    const spec = handler.startsWith('graph:')
      ? emb.scope.get('graph', handler.slice('graph:'.length))?.doc.out?.type
      : operationOf(emb, handler)?.returns;
    const type = spec ? emb.scope.types.spec(spec) : undefined;
    return type && !hasVars(type) ? type : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The type the node at a dotted path declares it answers, read off the spec rather than off a run: what a
 * rehearsal needs to build a value for a node no stub recorded -- a call into a graph, whose answer the kernel
 * never generates. A map's element index is a segment of the path and no node of the spec. Nothing for a map
 * itself, a switch, or a node whose operation leaves its type to the call site.
 */
export function declaredAt(emb: Embedder, root: Spec, nodePath: string): Type | undefined {
  const node = nodeAt(emb, root, nodePath.split('.'));
  return node && node.kind !== 'map' && typeof node.handler === 'string' ? answeredBy(emb, node.handler) : undefined;
}

/** A node of a lowered spec, as far as a walk down a path reads one. */
type SpecNode = { kind?: string; handler?: unknown };

/** The node a dotted path ends at: the spec behind each call stepped into, and a map's element index stepped over. */
function nodeAt(emb: Embedder, root: Spec, segments: string[]): SpecNode | undefined {
  let spec: Spec | undefined = root;
  for (let at = 0; spec && at < segments.length; at++) {
    const node = spec.nodes?.[segments[at]] as SpecNode | undefined;
    if (!node || at === segments.length - 1) return node;
    if (node.kind === 'map') at++;
    spec = typeof node.handler === 'string' ? specBehind(emb, node.handler) : undefined;
  }
  return undefined;
}

/** The handler one node of a spec names, when it names one at all. */
const handlerAt = (spec: Spec, segment: string): string | undefined => {
  const node = spec.nodes?.[segment] as { handler?: unknown } | undefined;
  return typeof node?.handler === 'string' ? node.handler : undefined;
};

/** The graph one node of a spec runs, named directly or through the binding that meets it. */
export function graphAt(emb: Embedder, spec: Spec, segment: string): string | undefined {
  const handler = handlerAt(spec, segment);
  if (!handler) return undefined;
  return handler.startsWith('graph:') ? handler.slice('graph:'.length) : bindingGraph(emb, handler);
}

/**
 * The graph a trigger's fire runs: the one the profile's binding meets the operation with, or the operation
 * itself where nothing does. The binding is read off the compiled wrapper spec -- a binding operation lowers
 * to a single node `op` -- rather than from the port reference, which names no binding and would resolve to
 * nothing.
 */
export function rootGraph(emb: Embedder, trigger: Loaded<TriggerDoc>): string {
  const spec = emb.operation(trigger.doc.fire.run).spec as Spec;
  return emb.scope.canon(graphAt(emb, spec, 'op') ?? trigger.doc.fire.run);
}

/** True when the graph at this path says `atomic`: every branch that does not answer undoes what it wrote. */
export function atomicAt(emb: Embedder, graph: string): boolean {
  return emb.scope.get('graph', graph)?.doc.atomic === true;
}

/** One step of the descent: the graph a node runs, or the guard whose nested spec it maps its list through. */
function stepInto(emb: Embedder, spec: Spec, segment: string, at: Where): Where {
  const handler = handlerAt(spec, segment);
  const guard = handler ? guardSpecAt(handler) : undefined;
  if (guard) return { graph: emb.scope.canon(guard.graph), site: guard.id };
  const ref = graphAt(emb, spec, segment);
  return ref ? { graph: emb.scope.canon(ref) } : at;
}

/** The spec a node runs, so the descent reads the next segment in the right place: a guard's, or a graph's. */
function specOf(emb: Embedder, spec: Spec, segment: string): Spec | undefined {
  const handler = handlerAt(spec, segment);
  if (handler && guardSpecAt(handler)) return emb.guardSpec(handler);
  const ref = graphAt(emb, spec, segment);
  return ref ? graphSpec(emb, ref) : undefined;
}

/**
 * The graph document a switch belongs to, and the guarded site it is inside the guard of: the trigger's own
 * graph, then whatever each step of the path descends into -- the graph a call runs, or a guard's nested spec.
 */
export function whereOf(emb: Embedder, trigger: Loaded<TriggerDoc>, prefix: string[]): Where {
  let spec = emb.operation(trigger.doc.fire.run).spec as Spec;
  let at: Where = { graph: rootGraph(emb, trigger) };
  for (const segment of prefix) {
    const next = stepInto(emb, spec, segment, at);
    if (next === at) continue;
    at = next;
    const sub = specOf(emb, spec, segment);
    if (sub) spec = sub;
  }
  return at;
}
