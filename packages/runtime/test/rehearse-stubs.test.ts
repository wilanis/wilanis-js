/**
 * What a steered stub holds (#844). A case writes the fields its rule reads into a node's answer, and every other node
 * that reads that answer must still find a whole value of the type the node declares. Each tree in
 * `rehearse-stubs-trees.ts` is built so that a stub holding only the steered fields breaks a sibling:
 *
 * - a list a map runs over is made to hold an element, in the answer of a call into a graph, which no seed records;
 * - two switches read one node's answer, the second behind the first, so the second's case must keep the first's field;
 * - a rule reads a field inside an optional object the seed left out, so the object is made whole from its type;
 * - a guard judges a list a `map` of `#make` made, and the kernel reads a map's stubs per element, never at the map.
 */
import { rmSync } from 'node:fs';
import { checkTree } from '@wilanis/compiler';
import { loadTree } from '@wilanis/core';
import { afterEach, describe, expect, it } from 'vitest';
import { BUILTIN_PLUGINS, type Rehearsal, rehearse } from '../src/index.js';
import { layersTree, mappedTree, nonemptyTree, parentTree } from './rehearse-stubs-trees.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The tree rehearsed, once the checker has let it through: a case about the walk must stand on a tree that passes. */
async function rehearsed(dir: string, seed = 1): Promise<Rehearsal> {
  dirs.push(dir);
  const load = loadTree(dir, BUILTIN_PLUGINS);
  const refused = checkTree(load).format();
  if (refused) throw new Error(`the tree a case rehearses must itself pass:\n${refused}`);
  return rehearse(load, { seed });
}

/** Each branch of one decision as where it went and how it settled: its declared reason, or why it never ran. */
function branchesOf(run: Rehearsal, graph: string, node: string) {
  const decision = run.decisions.find(one => one.graph.endsWith(graph) && one.node === node);
  if (!decision) throw new Error(`no decision ${graph} '${node}' in:\n${run.lines.join('\n')}`);
  return decision.branches.map(one => [
    one.to,
    one.uncovered ?? one.settled?.error ?? one.settled?.declared?.reason ?? one.settled?.status,
  ]);
}

describe('a list made to hold an element', () => {
  it('keeps every other field of the answer that holds it, so a sibling reading one still runs', {
    timeout: 30_000,
  }, async () => {
    const done = await rehearsed(nonemptyTree());
    expect(branchesOf(done, 'domain/judge.graph.json', 'decide')).toEqual([
      ['high', 'done'],
      ['low', 'done'],
    ]);
    expect(done.ok, done.lines.join('\n')).toBe(true);
  });
});

describe('two switches over one answer', () => {
  it("keep the field the first was steered on when the second's case is laid over it, under every seed", {
    timeout: 60_000,
  }, async () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const done = await rehearsed(layersTree(), seed);
      // the switches after `status` both answer on its branch to `ok`, so the run answers rather than refusing
      expect(branchesOf(done, 'domain/check.graph.json', 'status'), `seed ${seed}`).toEqual([
        ['ok', 'done'],
        ['broke', 'broke'],
      ]);
      expect(branchesOf(done, 'domain/check.graph.json', 'agree'), `seed ${seed}`).toEqual([
        ['moved', 'done'],
        ['disagree', 'disagree'],
      ]);
      expect(branchesOf(done, 'domain/check.graph.json', 'moved'), `seed ${seed}`).toEqual([
        ['same', 'same'],
        ['good', 'done'],
      ]);
      expect(done.ok, done.lines.join('\n')).toBe(true);
    }
  });
});

describe('a field inside an optional object the seed left out', () => {
  it('is written into an object made whole from its type, so its required fields are there', {
    timeout: 60_000,
  }, async () => {
    for (const seed of [1, 2, 3, 4]) {
      const done = await rehearsed(parentTree(), seed);
      expect(branchesOf(done, 'domain/report.graph.json', 'has'), `seed ${seed}`).toEqual([
        ['measured', 'done'],
        ['notMeasured', 'done'],
      ]);
      expect(done.ok, done.lines.join('\n')).toBe(true);
    }
  });
});

describe('a guard over a list a map made', () => {
  it("is steered through the map's element, so the violated branch reaches the refusal", {
    timeout: 30_000,
  }, async () => {
    const done = await rehearsed(mappedTree());
    expect(branchesOf(done, 'domain/all.graph.json', 'in:check')).toEqual([
      ['in:ok', 'done'],
      ['in:violated', 'invariant'],
    ]);
    expect(done.ok, done.lines.join('\n')).toBe(true);
  });
});
