/**
 * What the rehearsal hands `record.ts` of a run it made (RFC 0018): what it was fired with, what every effect
 * answered, the report, the fields the trigger's `out` marks secret, and for a branch's run the branch it proves, as
 * the graph document names it.
 */
import type { Loaded, LoadResult, TriggerDoc } from '@wilanis/core';
import { isSwitch, secretPaths } from '@wilanis/core';
import type { Report } from '@wilanis/engine';
import type { Case } from './branches.js';
import type { Embedder } from './embed.js';
import type { RecordedRun } from './record.js';
import type { Decision } from './rehearsal-report.js';

/** What a branch's run hands back to be recorded: what it was fired with, what answered, and whether a node broke. */
export interface Ran {
  input: unknown;
  stubs: Record<string, unknown>;
  report: Report;
  broke: boolean;
}

/** What a recorded branch reads of the walk: the tree, the trigger, the seed and request it fired with, the probe. */
interface Walked {
  load: LoadResult;
  trigger: Loaded<TriggerDoc>;
  seed: number;
  request: Record<string, unknown>;
  probe: Embedder;
}

/** Where the trigger's `out` marks a field secret: a recorded output is written with those as the marker. */
export const secretOut = (emb: Embedder, trigger: Loaded<TriggerDoc>) => secretPaths(emb.types(trigger.doc).out);

/** One branch's run as it is recorded, named by the branch it proves and, where a sibling shares its target, its place. */
export function recordedOf(walk: Walked, decision: Decision, of: { one: Case; cases: Case[]; ran: Ran }): RecordedRun {
  const { one, cases, ran } = of;
  const shared = cases.filter(other => other.branch.to === one.branch.to).length > 1;
  const graph = walk.load.resolve(decision.graph);
  const branch = {
    graph,
    node: decision.node,
    when: one.branch.when,
    to: authoredTo(walk.probe, { graph, node: decision.node }, one),
    ...(shared ? { n: cases.indexOf(one) } : {}),
  };
  const { input, stubs, report } = ran;
  const secret = secretOut(walk.probe, walk.trigger);
  return { trigger: walk.trigger, branch, seed: walk.seed, input, request: walk.request, stubs, report, secret };
}

/**
 * The node a case routes to as the graph document writes it. The lowered spec may route elsewhere -- a guarded
 * site's made node is moved aside to `<id>:made` with whatever routed it (RFC 0007) -- and a scenario names what a
 * reader of the document can find.
 */
function authoredTo(emb: Embedder, at: { graph: string; node: string }, one: Case): string {
  const node = emb.scope.get('graph', at.graph)?.doc.nodes.find(each => each.id === at.node);
  if (!node || !isSwitch(node)) return one.branch.to;
  if (one.branch.rule >= 0) return node.rules[one.branch.rule]?.to ?? one.branch.to;
  return one.branch.rule === -1 ? node.else : one.branch.to;
}
