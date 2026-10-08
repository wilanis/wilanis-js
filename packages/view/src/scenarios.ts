/**
 * What the viewer shows of scenarios (RFC 0018): on a trigger's page, the scenarios that replay it, grouped by who
 * wrote them as `wilanis ls` marks them; on a scenario's, the sentence a generated one is marked with, and what each
 * node is expected to do, read through `nodesOf` (RFC 0036). The words and the grouping are the runtime's, so a page
 * and `wilanis describe` cannot say a scenario two ways.
 */
import { answersFor, type Loaded, nodesOf, type ScenarioDoc, type Scope } from '@wilanis/core';
import { AUTHORS, expectsSaid, generatedSaid, provesSaid, scenariosOf, WRITTEN_BY } from '@wilanis/runtime';
import type { VExpectedNode, VScenarioGroup, VScenarioRow } from './types.js';

/** One scenario as a row of a trigger's page: the branch it proves, or its file's name, and how it expects to end. */
const rowOf = (one: Loaded<ScenarioDoc>): VScenarioRow => ({
  path: one.path,
  said: one.doc.branch ? provesSaid(one.doc.branch) : one.name,
  expects: expectsSaid(one.doc.expect),
});

/** The scenarios that replay one trigger's fire: a group per author that wrote any, in the order describe counts them. */
export function scenarioGroupsOf(scope: Scope, trigger: Loaded): VScenarioGroup[] {
  const written = scenariosOf(trigger, scope);
  return AUTHORS.filter(by => written[by].length).map(by => ({
    by,
    ...(by === 'hand' ? {} : { writtenBy: WRITTEN_BY[by] }),
    scenarios: written[by].map(rowOf),
  }));
}

/**
 * What a scenario's page tables under "Expected per node": a row per node, each answer resolved through `nodesOf`, so
 * the page never reads `expect.nodes` itself and never shows a digest in place of a value.
 */
export function expectedNodesOf(scope: Scope, scenario: Loaded<ScenarioDoc>): VExpectedNode[] {
  const { nodes } = nodesOf(scenario.doc, answersFor(scope.registry, scenario.path)?.doc);
  return Object.entries(nodes).map(([node, answer]) => ({ node, ...answer }));
}

/** The sentence a scenario's or an answers document's page marks it with, where a command wrote it. */
export const generatedOf = (doc: Loaded): string | undefined => generatedSaid(doc.doc as ScenarioDoc);
