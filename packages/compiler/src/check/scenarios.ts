/**
 * S scenarios. A scenario names a trigger the tree has (S001), pins a reason only on a node that refused (S002),
 * cancels its replay only at an effect it stubbed (S003), proves a branch the graph still has (S004), and
 * replays a policy only under a trigger that attaches it (S005). A scenario written by hand holds its answers and
 * stubs itself (S006), and every pointer of a recorded one resolves in its directory's answers document (S007), whose
 * shared answers S002 judges once (RFC 0036).
 */
import {
  type AnswersDoc,
  answersAbove,
  answersFor,
  type GraphDoc,
  isSwitch,
  type Loaded,
  nodesOf,
  policyPath,
  type ScenarioBranch,
  type ScenarioDoc,
  type ScenarioNode,
  type SwitchNode,
  stubsOf,
  type TriggerDoc,
} from '@wilanis/core';
import type { Judge, Refuser } from './judge.js';

/**
 * The refusals a scenario earns: naming a trigger the tree does not have (S001), pinning a reason on a node
 * that did not refuse (S002), cancelling at a node it did not stub (S003), naming a branch the graph does not
 * have (S004), naming a policy its trigger does not attach (S005), pointing though written by hand (S006), and
 * pointing at what its answers document does not hold (S007).
 */
export function checkScenario(judge: Judge, scenario: Loaded<ScenarioDoc>): void {
  const refuse = judge.refuser(scenario.path);
  const trigger = judge.scope.get('trigger', scenario.doc.trigger);
  if (!trigger) {
    refuse('S001', `scenario names unknown trigger '${scenario.doc.trigger}'`, 'trigger', 'wilanis ls trigger');
  }
  // a shared answer is judged once, in the answers document that holds it, so only the inline ones are judged here
  checkPinnedReasons(nodesOf(scenario.doc, undefined).nodes, INLINE, refuse);
  checkCancelAt(judge, scenario, refuse);
  if (scenario.doc.generated === undefined) checkWrittenByHand(scenario.doc, refuse);
  else checkResolved(judge, scenario, refuse);
  if (scenario.doc.branch) checkBranch(judge, scenario.doc.branch, refuse);
  if (scenario.doc.policy !== undefined) checkReplayedPolicy(judge, scenario.doc, trigger, refuse);
}

/**
 * The refusals an answers document earns: a shared answer that pins a reason though it did not end `failed` (S002),
 * judged once here rather than in each scenario that points at it.
 */
export function checkAnswers(judge: Judge, answers: Loaded<AnswersDoc>): void {
  checkPinnedReasons(answers.doc.nodes, SHARED, judge.refuser(answers.path));
}

/** Where a map of answers sits in its document, what one of its keys names, and how its document is written again. */
interface AnswersAt {
  at: string;
  named: string;
  hint: string;
}

/** A scenario's inline answers, by node path. */
const INLINE: AnswersAt = {
  at: 'expect/nodes',
  named: 'node',
  hint: 'a reason belongs to a node that refused; drop it, or let wilanis fuzz write the scenario again',
};

/** The answers an answers document shares, by digest. */
const SHARED: AnswersAt = {
  at: 'nodes',
  named: 'shared answer',
  hint: 'a reason belongs to a node that refused; wilanis rehearse --record (or wilanis fuzz --edges) writes the answers file again: run it and review the diff',
};

/**
 * S002: a reason belongs to a node that refused, and a node that refused ended `failed`. Judged over a map of answers:
 * a scenario's inline ones at `expect/nodes`, by node path, or an answers document's at `nodes`, by digest.
 */
function checkPinnedReasons(answers: Record<string, ScenarioNode>, where: AnswersAt, refuse: Refuser): void {
  for (const [id, node] of Object.entries(answers)) {
    if (node.reason === undefined || node.status === 'failed') continue;
    refuse(
      'S002',
      `${where.named} '${id}' pins reason '${node.reason}' but ended '${node.status}': only a node that refused gives a reason`,
      `${where.at}/${id}/reason`,
      where.hint,
    );
  }
}

/**
 * S006: a scenario written by hand holds its answers and its stubs itself. An answers document is rewritten whole by
 * a command that does not know the scenario, so a value it points at could disappear on the next record.
 */
function checkWrittenByHand(scenario: ScenarioDoc, refuse: Refuser): void {
  for (const [id, node] of Object.entries(scenario.expect.nodes ?? {})) {
    if (typeof node !== 'string') continue;
    refuse(
      'S006',
      `node '${id}' points at the shared answer ${node}, and a scenario written by hand holds its answers itself: no command keeps an answers file for it`,
      `expect/nodes/${id}`,
      `write the answer answers.json holds under nodes/${node} in place of the digest`,
    );
  }
  if (scenario.sharedStubs === undefined) return;
  refuse(
    'S006',
    'the scenario shares its stubs under sharedStubs, and a scenario written by hand holds its stubs itself: no command keeps an answers file for it',
    'sharedStubs',
    'move each entry of sharedStubs under stubs, with the value answers.json holds under stubs/<digest>',
  );
}

const RECORD_AGAIN =
  'wilanis rehearse --record (or wilanis fuzz --edges) writes the scenarios and their answers file together: run it and review the diff';

/**
 * S007: every pointer of a recorded scenario resolves in its own answers document, the one `answersAbove` finds with
 * the scenario's mark; and a stub is written inline or shared, never both. What `nodesOf` and `stubsOf` cannot resolve
 * is what is refused, so no pointer is resolved a second way here.
 */
function checkResolved(judge: Judge, scenario: Loaded<ScenarioDoc>, refuse: Refuser): void {
  const { doc } = scenario;
  const above = answersAbove(judge.scope.registry, scenario.path);
  for (const id of nodesOf(doc, above.own?.doc).unresolved) {
    const why = unheld(above, doc.generated, 'nodes');
    refuse('S007', `node '${id}' points at ${doc.expect.nodes[id]}${why}`, `expect/nodes/${id}`, RECORD_AGAIN);
  }
  for (const path of stubsOf(doc, above.own?.doc).unresolved) {
    const why = unheld(above, doc.generated, 'stubs');
    refuse('S007', `stub '${path}' points at ${doc.sharedStubs?.[path]}${why}`, `sharedStubs/${path}`, RECORD_AGAIN);
  }
  for (const path of Object.keys(doc.sharedStubs ?? {}).filter(one => Object.hasOwn(doc.stubs ?? {}, one))) {
    const both = `stub '${path}' is under both stubs and sharedStubs: a stub is written inline or shared, never both`;
    refuse('S007', both, `sharedStubs/${path}`, RECORD_AGAIN);
  }
}

/**
 * Why a pointer does not resolve, said after its digest: no answers document above the scenario, one another command
 * wrote, or its own, whose map does not hold the digest.
 */
function unheld(above: ReturnType<typeof answersAbove>, mark: string | undefined, map: 'nodes' | 'stubs'): string {
  const { own, other } = above;
  if (other) return `, and ${other.path} above it is marked '${other.doc.generated}' where this scenario is '${mark}'`;
  if (!own) return ', and no answers.json is above this scenario';
  return `, which ${own.path} does not hold under ${map}`;
}

/**
 * S003: `cancelAt` names a stubbed effect. The replay aborts the run's signal where that stub would have
 * answered, so a path the recording never stubbed is one the replay never reaches, and nothing is cancelled. A path
 * under `sharedStubs` is stubbed too, whether or not its digest resolves.
 */
function checkCancelAt(judge: Judge, scenario: Loaded<ScenarioDoc>, refuse: Refuser): void {
  const at = scenario.doc.cancelAt;
  if (at === undefined) return;
  const { stubs, unresolved } = stubsOf(scenario.doc, answersFor(judge.scope.registry, scenario.path)?.doc);
  if (Object.hasOwn(stubs, at) || unresolved.includes(at)) return;
  refuse(
    'S003',
    `cancelAt names '${at}', which is not a stubbed effect of this scenario`,
    'cancelAt',
    'cancelAt names a stubbed effect: one of the keys under stubs',
  );
}

const REGENERATE =
  'wilanis rehearse --record rewrites scenarios/rehearsed/ from the tree as it stands; a hand-written scenario names a node the switch has';

/**
 * S004: the branch a scenario proves is one the tree has -- its graph, a switch of that graph, and a node the
 * switch routes to. `when` is not judged: a rule's text is the solver's to compare, and a hand-written scenario
 * may paraphrase it.
 */
function checkBranch(judge: Judge, branch: ScenarioBranch, refuse: Refuser): void {
  const graph = judge.scope.get('graph', branch.graph);
  if (!graph) {
    refuse(
      'S004',
      `the branch names graph '${branch.graph}', which the tree does not have`,
      'branch/graph',
      REGENERATE,
    );
    return;
  }
  const node = switchOf(graph, branch.node, refuse);
  if (!node) return;
  const targets = targetsOf(node);
  if (targets.includes(branch.to)) return;
  refuse(
    'S004',
    `the branch names node '${branch.to}' of switch '${node.id}' in ${graph.path}, which no rule of the switch routes to: it routes to ${targets.join(', ')}`,
    'branch/to',
    REGENERATE,
  );
}

/** The switch a branch names in its graph, or nothing once S004 says which switches the graph has instead. */
function switchOf(graph: Loaded<GraphDoc>, id: string, refuse: Refuser): SwitchNode | undefined {
  const node = graph.doc.nodes.find(one => one.id === id);
  if (node && isSwitch(node)) return node;
  const switches = graph.doc.nodes.filter(isSwitch).map(one => one.id);
  const what = node ? 'is not a switch' : 'is no node of it';
  const has = switches.length ? `its switches are ${switches.join(', ')}` : 'it has no switch';
  refuse('S004', `the branch names node '${id}' of ${graph.path}, which ${what}: ${has}`, 'branch/node', REGENERATE);
  return undefined;
}

/**
 * Every node a switch routes to, in the order the rehearsal walks them: each rule's, the else, then where each
 * caught node's fault goes, since the rehearsal proves a catch as a branch of its own.
 */
function targetsOf(node: SwitchNode): string[] {
  const all = [...node.rules.map(rule => rule.to), node.else, ...Object.values(node.catch ?? {})];
  return [...new Set(all)];
}

/**
 * S005: a policy scenario replays a decision the tree has, under a trigger that attaches it, matched by canonical
 * path as the rehearsal matches a policy to the triggers that attach it. A trigger the tree does not have is
 * S001's, and is not judged again here.
 */
function checkReplayedPolicy(
  judge: Judge,
  scenario: ScenarioDoc,
  trigger: Loaded<TriggerDoc> | undefined,
  refuse: Refuser,
): void {
  const hint = `a policy scenario replays the decision under a trigger that attaches it: wilanis describe ${scenario.trigger}`;
  const policy = judge.scope.get('policy', scenario.policy ?? '');
  if (!policy) {
    refuse('S005', `scenario names unknown policy '${scenario.policy}'`, 'policy', hint);
    return;
  }
  if (!trigger) return;
  const attached = (trigger.doc.policies ?? []).map(use => judge.scope.canon(policyPath(use)));
  if (attached.includes(policy.path)) return;
  const attaches = attached.length ? `it attaches ${attached.join(', ')}` : 'it attaches none';
  refuse('S005', `trigger ${trigger.path} does not attach policy ${policy.path}: ${attaches}`, 'policy', hint);
}
