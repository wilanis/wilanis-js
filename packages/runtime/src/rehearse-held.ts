/**
 * A guard whose value an enclosing graph already judged (RFC 0035). A data graph that takes a guarded shape as its
 * `in` keeps its own guard at `in:ok`, so it is correct under any caller; but on a run path where the value it takes
 * is one a domain graph made and guarded a frame out, that value has already passed the same rule, and the second
 * guard cannot refuse it. Nothing the rehearsal can set reaches it either -- its `in` is whatever the caller handed
 * down -- so without this it reads as a branch that can never run, which is a gap in the walk and not in the tree.
 *
 * Whether the value is the same one is read off the lowered specs: every input the guard reads off `in` was copied,
 * field for field, from one node of an enclosing spec (`upstreamOf` in `frames.ts`). Whether that node is judged is
 * never re-derived here: it is judged when it is a site of the same shape in its graph, which `sitesOf` finds and
 * `guardsOf` says is guarded or proved, and a guarded one is read by the ids the compiler gave it (`idsOf`). A site
 * is held to every rule over its shape, so the same shape is the same rules. Across a map, the value is element 0 of
 * the list the node answers, and that node is judged when it is a list site of the shape: its guard judges every
 * element before the map hands one down (RFC 0038).
 */
import { type Guard, guardSpecAt, guardsOf, idsOf, siteId, sitesOf, TAKEN_IDS } from '@wilanis/compiler';
import type { Loaded, TriggerDoc } from '@wilanis/core';
import { type KNode, nodeRefs, type Outcome, outcomeOf, type Report } from '@wilanis/engine';
import type { FoundSwitch } from './branches.js';
import type { Embedder } from './embed.js';
import { type Upstream, upstreamOf } from './frames.js';
import { short, stateName } from './rehearsal-report.js';
import { answeredWithin } from './rehearse-calls.js';
import { graphSpec, type Spec, whereOf } from './rehearse-where.js';

/**
 * Where the value a guard on `in` judges was already judged on this run path, said for a reader: the upstream
 * guard and the graph it stands in, or the site that proved the rule. Nothing where the guard judges anything but
 * `in`, where its value is not one node's copied field for field, or where that node is no site of the shape -- a
 * list site where the value is an element of the node's list, a site of one value otherwise. The guard is then
 * steered, or reported unreachable, as any other decision is.
 */
export function heldUpstream(
  emb: Embedder,
  trigger: Loaded<TriggerDoc>,
  sw: FoundSwitch,
  guard: Guard,
): string | undefined {
  if (guard.site.kind !== 'taken') return undefined;
  let upstream = upstreamOf(sw);
  const root = emb.operation(trigger.doc.fire.run).spec;
  // the node a value was copied from may be a call into one of the tree's graphs, which is run, never stubbed: the
  // value is then what the node inside answers, judged where that node stands (#1027)
  while (upstream) {
    const said = judgedAt(emb, trigger, guard, upstream);
    if (said) return said;
    const inside = answeredWithin(emb, root, [...upstream.prefix, upstream.node].join('.'));
    const segments = inside?.at.split('.');
    upstream = segments && { ...upstream, prefix: segments.slice(0, -1), node: segments.at(-1) ?? '' };
  }
  return undefined;
}

/** Where one node of an enclosing spec judged the value a guard reads, said for a reader; nothing where it did not. */
function judgedAt(emb: Embedder, trigger: Loaded<TriggerDoc>, guard: Guard, upstream: Upstream): string | undefined {
  const at = whereOf(emb, trigger, upstream.prefix);
  const graph = at.site ? undefined : emb.scope.get('graph', at.graph);
  if (!graph) return undefined;
  const shape = emb.scope.canon(guard.shape);
  // the type checker already keeps an element from landing on a site of one value, and a field on a list site;
  // the arity says which site the value is judged at, and keeps that true if the walk ever reads more widely
  const arity = upstream.element ? 'list' : 'one';
  const judged = guardsOf(emb.scope, graph).find(
    one => idsOf(one).ok === upstream.node && one.arity === arity && emb.scope.canon(one.shape) === shape,
  );
  if (judged) return `by guard ${guardName(judged)} in ${short(graph.path)}, which judged this value first`;
  const proved = sitesOf(emb.scope, shape).find(
    site =>
      site.graph.path === graph.path && site.kind === 'made' && site.arity === arity && siteId(site) === upstream.node,
  );
  return proved ? `at '${upstream.node}' in ${short(graph.path)}, where the rule is proved` : undefined;
}

/**
 * How a reader finds an upstream guard: its switch, by id. A list site has no switch of its own -- it is a map over a
 * nested spec whose switch is the fixed `in:check` -- so it is named as that switch of the site's node.
 */
const guardName = (guard: Guard): string =>
  guard.arity === 'list' ? `'${TAKEN_IDS.check}' of '${guard.id}'` : `'${idsOf(guard).check}'`;

/** Where a run that did not answer ended: the innermost graph, through each failed call's own run, and its outcome. */
export function endedIn(
  report: Report,
): (Extract<Outcome, { kind: 'refused' | 'faulted' }> & { graph: string }) | undefined {
  const outcome = outcomeOf(report);
  if (outcome.kind !== 'refused' && outcome.kind !== 'faulted') return undefined;
  const node = report.nodes[outcome.at];
  const deeper = node?.sub ?? node?.items?.find(item => item.status === 'failed')?.sub;
  return (deeper && endedIn(deeper)) || { ...outcome, graph: report.graph };
}

/**
 * Where a run steered to break a guard's rule was refused first by a guard holding one of the same rules upstream of
 * it, said for a reader: in another graph the value came through, or in this graph where the value this guard judges
 * is made from the one that guard answered. No value that breaks the rule gets past it to this one, which is a fact
 * of the tree on this path and no gap in the walk (#1027). Nothing where the run ended anywhere else -- at a guard of
 * this graph on another branch among them.
 */
export function judgedFirst(emb: Embedder, report: Report | undefined, guard: Guard): string | undefined {
  const ended = report && endedIn(report);
  if (ended?.kind !== 'refused' || ended.reason !== 'invariant') return undefined;
  const nested = guardSpecAt(ended.graph);
  const graph = nested?.graph ?? ended.graph.replace(/^graph:/, '');
  if (graph === guard.site.graph.path && !madeFrom(emb, guard, nested?.id ?? answerOf(ended.at))) return undefined;
  const rules = guard.unproved.map(one => `'${stateName(one.invariant)}' does not hold`);
  if (!rules.some(rule => ended.message.includes(rule))) return undefined;
  // a guard is named by its switch, as every held line names it: `<id>:violated` and `<id>:violated:<n>` are `<id>:check`
  const check = ended.at.replace(/:violated(:\d+)?$/, ':check');
  return `by guard '${check}' in ${short(graph)}, which judged this value first`;
}

/** The node a guard's refusal stands for, by the node it refuses at: `in:ok` for the graph's `in`, else the site's id. */
function answerOf(violated: string): string {
  const site = violated.replace(/:violated(:\d+)?$/, '');
  return site === 'in' ? TAKEN_IDS.ok : site;
}

/** Whether the value a guard at a made site judges is made, through the nodes of its graph, from the node `from`. */
function madeFrom(emb: Embedder, guard: Guard, from: string): boolean {
  const spec = graphSpec(emb, guard.site.graph.path);
  if (!spec || guard.site.kind !== 'made') return false;
  const seen = new Set<string>();
  const queue = [idsOf(guard).made];
  while (queue.length) {
    const id = queue.pop() ?? '';
    if (id === from) return true;
    if (!seen.has(id)) queue.push(...readsOf(spec, id));
    seen.add(id);
  }
  return false;
}

/** The nodes of a spec one node reads. */
function readsOf(spec: Spec, id: string): string[] {
  const node = spec.nodes[id] as KNode | undefined;
  return node ? [...nodeRefs({ ...node, in: node.in ?? {} })].filter(ref => ref in spec.nodes) : [];
}
