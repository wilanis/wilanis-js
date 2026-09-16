/**
 * The example's stores as `wilanis migrate` plans them, which is M05's demo said as a test: a database that
 * has recorded nothing is every collection created, and nothing lost.
 *
 * It sits beside `example.test.ts` rather than in it for the reason `atomic-example.test.ts` does: the file
 * is one concern's worth of the example, and the plan is a concern of its own. The planner itself is proved
 * in `packages/plugin-storage/test/plan.test.ts`; what is proved here is what the example declares.
 */
import { loadTree, Scope } from '@wilanis/core';
import { declaredOfStore, marksOfStore, plan } from '@wilanis/plugin-storage';
import { describe, expect, it } from 'vitest';
import { EXAMPLE, INCLUDES, PLUGINS } from './example-harness.js';

/** The example's two stores: the same collections over the memory connection and over the postgres one. */
const STORES = ['@monitor/data/entries.store.json', '@monitor/data/entries-postgres.store.json'];

describe("the example's migration plan", () => {
  it('is every collection created, against a database that has recorded nothing', () => {
    const load = loadTree(EXAMPLE, PLUGINS, INCLUDES);
    const scope = new Scope(load.registry, load.resolve);
    for (const path of STORES) {
      const store = scope.get('store', path)?.doc;
      const declaring = { connection: store?.connection ?? '', collections: store?.collections ?? {} };
      const steps = plan(
        {},
        declaredOfStore(declaring, of => scope.types.shape(of)),
        marksOfStore(declaring),
      ).steps;
      // both collections are created, and the unique the entries declare is written over the rows there are
      // none of: an empty database loses nothing, so the whole plan is additive and needs no permission
      expect(
        steps.map(step => `${step.do} ${step.target}`),
        path,
      ).toEqual(['create entries', 'create latest', 'unique entries']);
      // nothing is renamed, dropped or retyped: `renamed` says what a database holding rows would do, and a
      // fresh one has no `ua` to rename -- which is the stale-mark line the third command of the walk prints
      expect(
        steps.some(step => ['rename', 'drop', 'retype', 'remove'].includes(step.do)),
        path,
      ).toBe(false);
    }
  });
});
