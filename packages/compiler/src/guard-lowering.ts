/**
 * Putting a guard into a lowered graph (RFC 0007, and `guard.ts` beside this for what a guard is). The nodes of
 * the graph are lowered first, exactly as they are written; then each guarded site is rewritten in place, so
 * that nothing else in the spec has to know a guard is there. A made site's node moves aside to `<id>:made` and
 * `<id>` becomes the value the rule let through, which is why every read of `{{<id>}}` elsewhere is untouched;
 * a taken site leaves the caller's value at `in` and puts the judged one at `in:ok`, which `Roots.aliases` has
 * already pointed every authored `{{in}}` at.
 *
 * A list of the shape is guarded element by element: the three nodes become a nested spec and the site becomes
 * a `map` over the list with `onItemFailure: 'fail'`, the mechanism a bound graph already runs through, so the
 * first element that violates the rule refuses the whole list with its reason.
 */
import type { KernelSpec, KMap, KNode, KSwitch, Redact } from '@wilanis/engine';
import {
  type Guard,
  type GuardHandlers,
  type GuardIds,
  guardIds,
  guardNodes,
  guardSpec,
  guardSpecName,
  TAKEN_IDS,
  violatedIds,
} from './guard.js';

/** The ids one guard occupies in the spec it is lowered into: a taken site's are fixed, a made site's its own. */
const idsFor = (guard: Guard): GuardIds => (guard.site.kind === 'taken' ? { ...TAKEN_IDS } : guardIds(guard.id));

/** The map that runs one element of a list through the guard: the list in, the element handed whole as `in`. */
function guardMap(from: string, handler: string, redact: Redact | undefined): KMap {
  return {
    kind: 'map',
    handler,
    over: { ref: from, path: [] },
    in: {},
    bind: { in: [] },
    onItemFailure: 'fail',
    redact,
  };
}

/**
 * What the report shows of a guarded value: the secret paths the node that made it declared of its answer,
 * since the guard answers the same value. Its `in` paths are left behind with it -- they name that node's own
 * inputs, and the guard's one input is the whole value rather than any of them.
 */
function redactOf(node: KNode | undefined): Redact | undefined {
  const out = node && node.kind !== 'switch' ? node.redact?.out : undefined;
  return out?.length ? { out } : undefined;
}

/**
 * Whatever routed the node now routes the node that moved aside, so the value is made exactly when it was made
 * before and the guard stands between it and everything downstream. Routing to the guard's own answer instead
 * would leave the made node running on every branch, including the ones its author routed it away from.
 */
function reroute(spec: KernelSpec, from: string, to: string): void {
  for (const node of Object.values(spec.nodes)) if (node.kind === 'switch') rerouteSwitch(node, from, to);
}

/** One switch's routes to `from` sent to `to`: its rules, its fallback, and where a fault it catches goes. */
function rerouteSwitch(node: KSwitch, from: string, to: string): void {
  for (const rule of node.rules) if (rule.to === from) rule.to = to;
  if (node.else === from) node.else = to;
  const catches = node.catch ?? {};
  for (const [caught, target] of Object.entries(catches)) if (target === from) catches[caught] = to;
}

/**
 * One guard written into a spec. A made site's node is moved aside first, and whatever routed it follows it
 * there, so that the id it had now names the value the guard let through; a taken site has no node to move,
 * since the value is the kernel's `in`.
 */
function lowerOne(spec: KernelSpec, guard: Guard, handlers: GuardHandlers): GuardIds {
  const ids = idsFor(guard);
  const made = spec.nodes[guard.id];
  if (guard.site.kind === 'made') {
    delete spec.nodes[guard.id];
    spec.nodes[ids.made] = made;
    reroute(spec, guard.id, ids.made);
  }
  if (guard.arity === 'list') {
    const nested = guardSpec(guard, guardSpecName(spec.name, guard.id), handlers);
    handlers.nested(nested);
    spec.nodes[ids.ok] = guardMap(ids.made, nested.name, redactOf(made));
    return ids;
  }
  for (const [id, node] of Object.entries(guardNodes(guard, ids, handlers))) spec.nodes[id] = node;
  const answered = spec.nodes[ids.ok];
  if (answered.kind === 'call') answered.redact = redactOf(made);
  return ids;
}

/**
 * `<id>:violated` -- and `<id>:violated:2`, ... where more than one rule is unproved -- appended after `<id>`
 * wherever the graph answered with `<id>`, so a graph refuses when its guard does, with the one refusal the
 * guard routed to. A list site adds nothing: its map refuses with the element's reason rather than routing
 * anywhere.
 */
function withViolated(output: string[] | undefined, guard: Guard, ids: GuardIds): string[] | undefined {
  if (!output || guard.arity === 'list') return output;
  const out: string[] = [];
  for (const candidate of output) {
    out.push(candidate);
    if (candidate === ids.ok) out.push(...violatedIds(ids, guard.unproved.length));
  }
  return out;
}

/**
 * Every guard of a graph written into its lowered spec, in the order `guardsOf` found them. The spec is
 * rewritten in place and answered, so a caller reads one spec whether or not anything was guarded.
 */
export function lowerGuards(spec: KernelSpec, guards: Guard[], handlers: GuardHandlers): KernelSpec {
  let output = spec.output;
  for (const guard of guards) output = withViolated(output, guard, lowerOne(spec, guard, handlers));
  spec.output = output;
  return spec;
}
