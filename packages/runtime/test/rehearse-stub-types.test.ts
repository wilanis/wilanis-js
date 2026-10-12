/**
 * A solved stub fits the type of the node it stands for (#1026). A keep -- a map with `where` and no operation --
 * answers the list it runs over, so a case that steers a switch on a keep's answer builds a list of that list's
 * elements, never of `null`. And every stub a case would hand a run is checked against its node's type first: one
 * that does not fit, or whose type nothing says, is a value no real run sees, so the case is said and not run.
 */
import { rmSync } from 'node:fs';
import { checkTree } from '@wilanis/compiler';
import { loadTree, type Type } from '@wilanis/core';
import { afterEach, describe, expect, it } from 'vitest';
import { BUILTIN_PLUGINS, rehearse } from '../src/index.js';
import { misfitOf } from '../src/rehearse-reached.js';
import { keptTree } from './rehearse-keep-trees.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("a keep's answer, as a case steers it", () => {
  it('is a list of the elements it keeps, so the case that needs one runs', { timeout: 30_000 }, async () => {
    const dir = keptTree();
    dirs.push(dir);
    const load = loadTree(dir, BUILTIN_PLUGINS);
    expect(checkTree(load).format()).toBe('');
    const done = await rehearse(load, { seed: 1 });
    const decision = done.decisions.find(one => one.graph.endsWith('domain/page.graph.json') && one.node === 'any');
    const taken = decision?.branches.find(one => one.to === 'n');
    expect(taken?.uncovered, done.lines.join('\n')).toBeUndefined();
    expect(taken?.settled?.status).toBe('done');
  });
});

describe('a stub checked against its type before a run', () => {
  const item: Type = { kind: 'object', fields: { score: { type: { kind: 'number' }, required: true } }, open: false };
  const items: Type = { kind: 'list', of: item };
  const typed = (path: string) => (path === 'op.kept' ? items : undefined);

  it('lets a run have stubs that fit', () => {
    expect(misfitOf({ 'op.kept': [{ score: 3 }] }, typed)).toBeUndefined();
  });
  it('says the stub that does not fit, and where in it', () => {
    expect(misfitOf({ 'op.kept': [null] }, typed)).toBe(
      "the rehearsal's stub does not fit its type: op.kept[0]: expected object",
    );
  });
  it('says the node whose type nothing says', () => {
    expect(misfitOf({ 'op.other': [] }, typed)).toBe(
      "the rehearsal cannot tell the type 'op.other' answers, so it cannot check the stub it would hand it",
    );
  });
});
