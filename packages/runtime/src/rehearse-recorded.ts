/**
 * What the rehearsal hands `record.ts` of a run it made (RFC 0018): what it was fired with, what every effect
 * answered, the report, the fields the trigger's `out` marks secret, and for a branch's run the branch it proves, as
 * the graph document names it. A policy's decision is recorded as a run of the root `policyRoot` builds, naming the
 * policy and the attaching trigger that lent it a kind, and replayed through the same root.
 */
import type { Loaded, LoadResult, ScenarioDoc, TriggerDoc } from '@wilanis/core';
import { isSwitch, secretPaths } from '@wilanis/core';
import type { Report } from '@wilanis/engine';
import type { Case } from './branches.js';
import type { Embedder } from './embed.js';
import type { RecordedRun } from './record.js';
import type { Decision } from './rehearsal-report.js';
import { type PolicyRoot, policyRoot } from './stubbing.js';

/** What a branch's run hands back to be recorded: what it was fired with, what answered, and whether a node broke. */
export interface Ran {
  input: unknown;
  stubs: Record<string, unknown>;
  report: Report;
  broke: boolean;
}

/** What a recorded branch reads of the walk: the tree, the trigger, the seed and context it fired with, the probe. */
interface Walked {
  load: LoadResult;
  trigger: Loaded<TriggerDoc>;
  seed: number;
  context: Record<string, unknown>;
  probe: Embedder;
}

/** Where the trigger's `out` marks a field secret: a recorded output is written with those as the marker. */
export const secretOut = (emb: Embedder, trigger: Loaded<TriggerDoc>) => secretPaths(emb.types(trigger.doc).out);

/**
 * What a recorded run of a walked root names: the trigger it fired, or for a policy's decision the policy and the
 * attaching trigger whose kind and settings the root borrowed, the way in a replay goes through.
 */
export const namedBy = (walked: PolicyRoot): Pick<RecordedRun, 'trigger' | 'policy'> =>
  walked.attaching ? { trigger: walked.attaching, policy: walked } : { trigger: walked };

/**
 * Where the rehearsal records a walked root's runs: every trigger's, and a policy's decision once, from the first root
 * of it the profile serves -- which borrows from the first attaching trigger in path order where that one is served --
 * since its files are named by the policy and not by the kind. A policy nothing attaches is not recorded: a scenario
 * replays a decision under a trigger that attaches it (S005). Nothing where the rehearsal does not record.
 */
export function recordsInto(triggers: Loaded<TriggerDoc>[], runs: RecordedRun[] | undefined) {
  const recorded = new Set<string>();
  return (walked: PolicyRoot): RecordedRun[] | undefined => {
    if (!runs || triggers.includes(walked)) return runs;
    if (!walked.attaching || recorded.has(walked.path)) return undefined;
    recorded.add(walked.path);
    return runs;
  };
}

/**
 * The trigger document a scenario's replay fires: its trigger's, or where it names a policy, the root `policyRoot`
 * builds of that policy under the trigger, so the decision is fired under the kind and settings it was recorded under.
 */
export function replayedDoc(load: LoadResult, sc: ScenarioDoc, trigger: Loaded<TriggerDoc>): TriggerDoc {
  if (sc.policy === undefined) return trigger.doc;
  const policy = load.registry.get('policy', load.resolve(sc.policy));
  if (!policy) throw new Error(`scenario names unknown policy '${sc.policy}', which wilanis check refuses as S005`);
  return policyRoot(load, policy, trigger).doc;
}

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
  return { ...namedBy(walk.trigger), branch, seed: walk.seed, input, context: walk.context, stubs, report, secret };
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
