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
 * is held to every rule over its shape, so the same shape is the same rules.
 */
import { type Guard, guardsOf, idsOf, siteId, sitesOf } from '@wilanis/compiler';
import type { Loaded, TriggerDoc } from '@wilanis/core';
import type { FoundSwitch } from './branches.js';
import type { Embedder } from './embed.js';
import { upstreamOf } from './frames.js';
import { short } from './rehearsal-report.js';
import { whereOf } from './rehearse-where.js';

/**
 * Where the value a guard on `in` judges was already judged on this run path, said for a reader: the upstream
 * guard and the graph it stands in, or the site that proved the rule. Nothing where the guard judges anything but
 * `in`, where its value is not one node's copied field for field, or where that node is no site of the shape --
 * the guard is then steered, or reported unreachable, as any other decision is.
 */
export function heldUpstream(
  emb: Embedder,
  trigger: Loaded<TriggerDoc>,
  sw: FoundSwitch,
  guard: Guard,
): string | undefined {
  if (guard.site.kind !== 'taken') return undefined;
  const upstream = upstreamOf(sw);
  if (!upstream) return undefined;
  const at = whereOf(emb, trigger, upstream.prefix);
  const graph = at.site ? undefined : emb.scope.get('graph', at.graph);
  if (!graph) return undefined;
  const shape = emb.scope.canon(guard.shape);
  const judged = guardsOf(emb.scope, graph).find(
    one => idsOf(one).ok === upstream.node && emb.scope.canon(one.shape) === shape,
  );
  if (judged) return `by guard '${idsOf(judged).check}' in ${short(graph.path)}, which judged this value first`;
  const proved = sitesOf(emb.scope, shape).find(
    site => site.graph.path === graph.path && site.kind === 'made' && siteId(site) === upstream.node,
  );
  return proved ? `at '${upstream.node}' in ${short(graph.path)}, where the rule is proved` : undefined;
}
