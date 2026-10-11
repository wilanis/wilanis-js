/**
 * The tree a migration is recorded from (issue #923). `ensure` at startup and `wilanis migrate` are the two
 * callers of the one planner, and both write the `tree` column of the record. They must write one name, or one
 * tree's history names it two ways and nothing reading the column can tell trees apart. The tree these cases
 * plan is written into a temporary directory whose name is not the project's, so a caller that named the tree
 * by its directory would show here.
 */
import { basename } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyStores, ensureStore, planStores } from '../src/index.js';
import { treeOf } from '../src/record.js';
import { storeFor } from '../src/store.js';
import { context, fake } from './migrating.js';

const STORE = '@features/customers/data/customers.store.json';

describe('the tree a migration is recorded from', () => {
  it('ensure at startup and wilanis migrate record the same name: the project name, never the directory', async () => {
    const { ctx, env, register } = context();
    const { engine, asked } = fake({});
    register(engine);
    await applyStores(ctx, await planStores(ctx));
    env.serving = { root: ctx.root, log: () => undefined };
    await ensureStore(engine, storeFor(env, STORE), env);
    const trees = asked.applied.map(one => one.applying.tree);
    expect(asked.applied.map(one => one.applying.by.endsWith('(startup)'))).toEqual([false, false, true]);
    expect(trees).toEqual(['kept', 'kept', 'kept']);
    expect(basename(ctx.root)).not.toBe('kept');
  });

  it('names the tree by its directory only where no project is loaded, and says unknown where there is neither', () => {
    expect(treeOf({ document: () => undefined }, '/srv/trees/billing')).toBe('billing');
    expect(treeOf({}, '/srv/trees/billing')).toBe('billing');
    expect(treeOf({}, undefined)).toBe('unknown');
  });
});
