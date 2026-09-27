/**
 * What the rehearsal hands `record.ts` of a run it made (RFC 0018): what it was fired with, what every effect
 * answered, the report, the fields the trigger's `out` marks secret, and for a branch's run the branch it proves, as
 * the graph document names it. A policy's decision is recorded as a run of the root `policyRoot` builds, naming the
 * policy and the attaching trigger that lent it a kind, and replayed through the same root. A branch the solver
 * cannot reach is recorded with why and no run, and replayed by solving it again from what the trigger's run reaches.
 */
import type { Loaded, LoadResult, ScenarioBranch, ScenarioDoc, TriggerDoc } from '@wilanis/core';
import { isSwitch, secretPaths } from '@wilanis/core';
import type { Report } from '@wilanis/engine';
import { type Case, casesFor } from './branches.js';
import type { Embedder } from './embed.js';
import type { RecordedRun, Recording } from './record.js';
import type { Decision } from './rehearsal-report.js';
import { type Reached, switchesReached, uncoveredBy } from './rehearse-reached.js';
import { whereOf } from './rehearse-where.js';
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
export function recordsInto(triggers: Loaded<TriggerDoc>[], runs: Recording[] | undefined) {
  const recorded = new Set<string>();
  return (walked: PolicyRoot): Recording[] | undefined => {
    if (!runs || triggers.includes(walked)) return runs;
    if (!walked.attaching || recorded.has(walked.path)) return undefined;
    recorded.add(walked.path);
    return runs;
  };
}

/**
 * The root a scenario's replay fires: its trigger, or where it names a policy, the root `policyRoot` builds of that
 * policy under the trigger, so the decision is fired under the kind and settings it was recorded under.
 */
function replayedRoot(load: LoadResult, sc: ScenarioDoc, trigger: Loaded<TriggerDoc>): Loaded<TriggerDoc> {
  if (sc.policy === undefined) return trigger;
  const policy = load.registry.get('policy', load.resolve(sc.policy));
  if (!policy) throw new Error(`scenario names unknown policy '${sc.policy}', which wilanis check refuses as S005`);
  return policyRoot(load, policy, trigger);
}

/** The trigger document a scenario's replay fires: the document of the root `replayedRoot` answers. */
export const replayedDoc = (load: LoadResult, sc: ScenarioDoc, trigger: Loaded<TriggerDoc>): TriggerDoc =>
  replayedRoot(load, sc, trigger).doc;

/**
 * One branch as it is recorded, named by the branch it proves and, where a sibling shares its target, its place: the
 * run it made, or -- where the solver could not solve or steer it -- why no input reaches it. Nothing for a run that
 * broke a node for real, which a scenario's stubs cannot say.
 */
export function recordedOf(walk: Walked, decision: Decision, of: { one: Case; cases: Case[]; ran?: Ran }) {
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
  const named = { ...namedBy(walk.trigger), branch, seed: walk.seed };
  const unreachable = uncoveredBy(one);
  if (unreachable !== undefined) return { ...named, unreachable };
  if (!ran || ran.broke) return undefined;
  const { input, stubs, report } = ran;
  return { ...named, input, context: walk.context, stubs, report, secret: secretOut(walk.probe, walk.trigger) };
}

/**
 * How a scenario that recorded its branch unreachable differs from what the solver answers today, found as the
 * rehearsal finds it (`switchesReached`) rather than by running it: nothing while the branch is still one no input
 * reaches, and that it is reachable now once the solver can solve and steer its case. A branch no switch the trigger
 * reaches still has, and a scenario that names none, are differences too: there is nothing left to solve.
 */
export async function solvedAgain(
  load: LoadResult,
  sc: ScenarioDoc,
  trigger: Loaded<TriggerDoc>,
  profile?: string,
): Promise<string[]> {
  const branch = sc.branch;
  if (!branch) return ['unreachable names no branch to solve again'];
  const reached = await switchesReached(load, replayedRoot(load, sc, trigger), sc.seed, profile);
  const one = reached && caseOf(reached, branch);
  const named = `branch '${branch.when}' → ${branch.to}`;
  if (!one) return [`${named} is no longer a case of '${branch.node}' where this trigger reaches it`];
  return uncoveredBy(one) === undefined ? [`${named} is reachable now`] : [];
}

/**
 * The case that proves a branch, read off the first switch the walk reaches that the branch names -- its graph and its
 * id -- as the first run of a trigger keeps the file two runs name: the case with the branch's rule and target.
 */
function caseOf(reached: Reached, branch: ScenarioBranch): Case | undefined {
  const graph = reached.load.resolve(branch.graph);
  const named = reached.found.find(
    sw =>
      sw.at.split('.').pop() === branch.node &&
      reached.load.resolve(whereOf(reached.probe, reached.trigger, sw.prefix).graph) === graph,
  );
  if (!named) return undefined;
  const at = { graph, node: branch.node };
  return casesFor(named, reached.stubbing).find(
    one => one.branch.when === branch.when && authoredTo(reached.probe, at, one) === branch.to,
  );
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
