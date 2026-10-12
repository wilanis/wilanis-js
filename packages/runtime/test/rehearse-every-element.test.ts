/**
 * A demand on a list's element is met in every element the rehearsal makes, not in element 0 alone (#1003). A rule a
 * map runs per element -- a guard on each customer of a list -- judges every element, so a stub or an input whose
 * other elements keep their generated values breaks it wherever a generated value does: a generated email never holds
 * an `@`. The rehearsal keeps a list of more than one element and writes the demand into each, each changed from its
 * own generated value. The trees are in `rehearse-every-element-trees.ts`.
 */
import { rmSync } from 'node:fs';
import { checkTree } from '@wilanis/compiler';
import { type LoadResult, loadTree } from '@wilanis/core';
import { afterEach, describe, expect, it } from 'vitest';
import { everyElement } from '../src/demands.js';
import { BUILTIN_PLUGINS, rehearse } from '../src/index.js';
import { answering, patched, switchesReached } from '../src/rehearse-reached.js';
import { everyElementTree, type Held } from './rehearse-every-element-trees.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A tree loaded, once the checker has let it through: a case about the walk must stand on a tree that passes. */
function loaded(held: Held, rule?: string): LoadResult {
  const dir = everyElementTree(held, rule);
  dirs.push(dir);
  const load = loadTree(dir, BUILTIN_PLUGINS);
  const refused = checkTree(load).format();
  if (refused) throw new Error(`the tree a case rehearses must itself pass:\n${refused}`);
  return load;
}

/** The seeds each case runs under: between them, they make lists of one, two and three elements. */
const SEEDS = [1, 2, 3, 4, 5, 6];

/**
 * The customers a run of switch `loud` is steered with under a seed, where the rule on each one is met by the other
 * decisions on the way (`answering`): the stub of the list the node makes, or the list in the trigger's patched input.
 */
async function customersSteered(load: LoadResult, held: Held, seed: number): Promise<{ email: string }[]> {
  const trigger = load.registry.all('trigger')[0];
  const walk = trigger && (await switchesReached(load, trigger, seed));
  const sw = walk?.found.find(one => one.at === 'op.loud');
  if (!walk || !sw) throw new Error(`no switch 'loud': ${walk?.found.map(one => one.at).join(', ')}`);
  const steered = answering(walk, sw);
  if (held === 'node') return steered.stubs['op.customers:made'] as { email: string }[];
  let input = walk.input;
  for (const patch of steered.input) input = patched(walk, input, patch);
  return (input as { list: { email: string }[] }).list;
}

/** How each branch of switch `loud` settled under a seed, and whether the rehearsal was ok. */
async function loudUnder(load: LoadResult, seed: number) {
  const run = await rehearse(load, { seed });
  const decision = run.decisions.find(one => one.node === 'loud');
  const settled = decision?.branches.map(one => one.uncovered ?? one.settled?.error ?? one.settled?.status);
  return { settled, ok: run.ok, said: run.lines.join('\n') };
}

describe('a demand on a list element a node holds', () => {
  it('is met in every element of the stub, and the switch the list guard stands before answers', {
    timeout: 60_000,
  }, async () => {
    const load = loaded('node');
    const sizes = new Set<number>();
    for (const seed of SEEDS) {
      const customers = await customersSteered(load, 'node', seed);
      sizes.add(customers.length);
      for (const one of customers) expect(one.email, `seed ${seed}`).toContain('@');
      const { settled, ok, said } = await loudUnder(load, seed);
      expect(settled, said).toEqual(['done', 'done']);
      expect(ok, said).toBe(true);
    }
    // the list keeps more than one element: the rehearsal steers each, it does not cut the list to one
    expect(Math.max(...sizes)).toBeGreaterThan(1);
  });

  it('writes a value the rule pins into every element alike', { timeout: 60_000 }, async () => {
    const load = loaded('node', "email == 'ada@example.org'");
    for (const seed of SEEDS) {
      const customers = await customersSteered(load, 'node', seed);
      expect(customers.map(one => one.email)).toEqual(customers.map(() => 'ada@example.org'));
      const { ok, said } = await loudUnder(load, seed);
      expect(ok, said).toBe(true);
    }
  });
});

describe("a demand on an element of a list the trigger's input holds", () => {
  it('is met in every element the input holds, and the switch the guards stand before answers', {
    timeout: 60_000,
  }, async () => {
    const load = loaded('input');
    const sizes = new Set<number>();
    for (const seed of SEEDS) {
      const customers = await customersSteered(load, 'input', seed);
      sizes.add(customers.length);
      for (const one of customers) expect(one.email, `seed ${seed}`).toContain('@');
      const { settled, ok, said } = await loudUnder(load, seed);
      expect(settled, said).toEqual(['done', 'done']);
      expect(ok, said).toBe(true);
    }
    expect(Math.max(...sizes)).toBeGreaterThan(1);
  });
});

describe('every path a demand on an element stands for', () => {
  const root = { rows: [{ tags: [{}, {}] }, { tags: [{}] }], fixed: [{}, {}] };

  it('takes each step it names through every index the list there holds, outer lists first', () => {
    // index 0 of `rows` stands four steps from the end, index 0 of `tags` two
    expect(everyElement(root, ['rows', '0', 'tags', '0', 'name'], [4, 2])).toEqual([
      ['rows', '0', 'tags', '0', 'name'],
      ['rows', '0', 'tags', '1', 'name'],
      ['rows', '1', 'tags', '0', 'name'],
    ]);
  });

  it('leaves an index the read named itself, and keeps index 0 where the list is not there yet', () => {
    expect(everyElement(root, ['fixed', '0', 'name'])).toEqual([['fixed', '0', 'name']]);
    expect(everyElement({}, ['rows', '0', 'name'], [2])).toEqual([['rows', '0', 'name']]);
  });
});
