/**
 * S scenarios. A scenario names a trigger the tree has (S001), pins a reason only on a node that refused (S002),
 * cancels its replay only at an effect it stubbed (S003), proves a branch the graph still has (S004), and
 * replays a policy only under a trigger that attaches it (S005).
 */
import {
  type GraphDoc,
  isSwitch,
  type Loaded,
  policyPath,
  type ScenarioBranch,
  type ScenarioDoc,
  type SwitchNode,
  type TriggerDoc,
} from '@wilanis/core';
import type { Judge, Refuser } from './judge.js';

/**
 * The refusals a scenario earns: naming a trigger the tree does not have (S001), pinning a reason on a node
 * that did not refuse (S002), cancelling at a node it did not stub (S003), naming a branch the graph does not
 * have (S004), and naming a policy its trigger does not attach (S005).
 */
export function checkScenario(judge: Judge, scenario: Loaded<ScenarioDoc>): void {
  const refuse = judge.refuser(scenario.path);
  const trigger = judge.scope.get('trigger', scenario.doc.trigger);
  if (!trigger) {
    refuse('S001', `scenario names unknown trigger '${scenario.doc.trigger}'`, 'trigger', 'wilanis ls trigger');
  }
  checkPinnedReasons(scenario.doc, refuse);
  checkCancelAt(scenario.doc, refuse);
  if (scenario.doc.branch) checkBranch(judge, scenario.doc.branch, refuse);
  if (scenario.doc.policy !== undefined) checkReplayedPolicy(judge, scenario.doc, trigger, refuse);
}

/** S002: a reason belongs to a node that refused, and a node that refused ended `failed`. */
function checkPinnedReasons(scenario: ScenarioDoc, refuse: Refuser): void {
  for (const [id, node] of Object.entries(scenario.expect.nodes ?? {})) {
    if (node.reason === undefined || node.status === 'failed') continue;
    refuse(
      'S002',
      `node '${id}' pins reason '${node.reason}' but ended '${node.status}': only a node that refused gives a reason`,
      `expect/nodes/${id}/reason`,
      'a reason belongs to a node that refused; drop it, or let wilanis fuzz write the scenario again',
    );
  }
}

/**
 * S003: `cancelAt` names a stubbed effect. The replay aborts the run's signal where that stub would have
 * answered, so a path the recording never stubbed is one the replay never reaches, and nothing is cancelled.
 */
function checkCancelAt(scenario: ScenarioDoc, refuse: Refuser): void {
  const at = scenario.cancelAt;
  if (at === undefined || Object.hasOwn(scenario.stubs ?? {}, at)) return;
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
