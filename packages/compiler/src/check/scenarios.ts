/**
 * S scenarios. A scenario names a trigger the tree has (S001), pins a reason only on a node that refused (S002),
 * and cancels its replay only at an effect it stubbed (S003).
 */
import type { Loaded, ScenarioDoc } from '@wilanis/core';
import type { Judge, Refuser } from './judge.js';

/**
 * The refusals a scenario earns: naming a trigger the tree does not have (S001), pinning a reason on a node
 * that did not refuse (S002), and cancelling at a node it did not stub (S003).
 */
export function checkScenario(judge: Judge, scenario: Loaded<ScenarioDoc>): void {
  const refuse = judge.refuser(scenario.path);
  if (!judge.scope.get('trigger', scenario.doc.trigger)) {
    refuse('S001', `scenario names unknown trigger '${scenario.doc.trigger}'`, 'trigger', 'wilanis ls trigger');
  }
  checkPinnedReasons(scenario.doc, refuse);
  checkCancelAt(scenario.doc, refuse);
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
