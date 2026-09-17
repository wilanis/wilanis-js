/**
 * Where a value of a shape comes into being. A field invariant (RFC 0007) is a rule about a shape, and a rule
 * about a shape is judged at the places a value of it first exists: a node that makes one, and a graph that
 * takes one from its caller. `sitesOf` finds both, and the checker (I005) and the compiler (the guard it
 * lowers) read the same list, so neither can judge a site the other does not see.
 */
import {
  type GraphDoc,
  hasVars,
  isMap,
  isSwitch,
  type Loaded,
  type Node,
  type Scope,
  substitute,
  type Type,
  type TypeSpec,
} from '@wilanis/core';
import { bindings } from './documents.js';

/** Whether a site holds one value of the shape or a list of them: a list is guarded element by element. */
export type SiteArity = 'one' | 'list';

/**
 * One place a value of a shape comes into being: the graph it is in, and either the node that makes it or the
 * graph's own `in`. A made site names the node; a taken site names none, since the value arrives as `in`.
 */
export interface Site {
  graph: Loaded<GraphDoc>;
  /** the node that makes the value, or nothing where the graph takes it as `in` */
  node: Node | undefined;
  kind: 'made' | 'taken';
  arity: SiteArity;
}

/** How a site is written in a refusal or a report: `in` where the graph takes the value, else the node's id. */
export const siteId = (site: Site): string => site.node?.id ?? 'in';

/**
 * Every site of a shape in the tree: a node whose native operation answers the shape (a `type` field bound to
 * `$T`, or a `returns` that names it), and every graph whose `in` is the shape. A domain operation's result is
 * not a site -- it was made inside the graph that answers it, and judged there -- and neither is a `refuse`,
 * which declares a type so it can stand opposite the node that answers but never makes a value.
 */
export function sitesOf(scope: Scope, shape: string): Site[] {
  const want = scope.canon(shape);
  const out: Site[] = [];
  for (const graph of scope.registry.all('graph')) {
    const taken = arityOf(scope, quietSpec(scope, graph.doc.in), want);
    if (taken) out.push({ graph, node: undefined, kind: 'taken', arity: taken });
    for (const node of graph.doc.nodes) {
      const made = madeArity(scope, node, want);
      if (made) out.push({ graph, node, kind: 'made', arity: made });
    }
  }
  return out;
}

/** The type a spec names, or nothing: a spec that resolves to nothing is R001 where the document is judged. */
function quietSpec(scope: Scope, spec: TypeSpec | undefined): Type | undefined {
  if (spec === undefined) return undefined;
  try {
    return scope.types.spec(spec);
  } catch {
    return undefined;
  }
}

/**
 * Whether a type is the shape or a list of it, and which. Only the shape itself counts: a type that merely
 * holds one in a field is a value of that other type, judged at the site the field's own value was made.
 */
function arityOf(scope: Scope, type: Type | undefined, want: string): SiteArity | undefined {
  if (!type) return undefined;
  if (type.kind === 'object' && type.name && scope.canon(type.name) === want) return 'one';
  if (type.kind === 'list') return arityOf(scope, type.of, want) ? 'list' : undefined;
  return undefined;
}

/**
 * Whether a node makes a value of the shape: it runs a native operation that answers something, and what it
 * answers -- its `returns` with the variables this call site binds substituted, a list of them for a map --
 * is the shape or a list of it.
 */
function madeArity(scope: Scope, node: Node, want: string): SiteArity | undefined {
  if (isSwitch(node)) return undefined;
  const hit = scope.op(node.run);
  if (typeof hit === 'string' || !hit.port.native || hit.op.refuses) return undefined;
  const answered = quietSpec(scope, hit.op.returns);
  if (!answered) return undefined;
  const one = hasVars(answered) ? substitute(answered, bindings(scope, hit.op, node.in)) : answered;
  return arityOf(scope, isMap(node) ? { kind: 'list', of: one } : one, want);
}
