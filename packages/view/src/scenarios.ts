/**
 * What the viewer shows of scenarios (RFC 0018): on a trigger's page, the scenarios that replay it, grouped by who
 * wrote them as `wilanis ls` marks them; on a scenario's, the sentence a generated one is marked with. The words and
 * the grouping are the runtime's, so a page and `wilanis describe` cannot say a scenario two ways.
 */
import type { Loaded, ScenarioDoc, Scope } from '@wilanis/core';
import { AUTHORS, expectsSaid, generatedSaid, provesSaid, scenariosOf, WRITTEN_BY } from '@wilanis/runtime';
import type { VScenarioGroup, VScenarioRow } from './types.js';

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

/** The sentence a scenario's page marks it with, where a command wrote it. */
export const generatedOf = (doc: Loaded): string | undefined => generatedSaid(doc.doc as ScenarioDoc);
