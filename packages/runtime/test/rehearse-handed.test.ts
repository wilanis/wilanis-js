/**
 * How the rehearsal steers a switch or a guard that reads `in` where `in` is no longer the trigger's own (RFC 0038,
 * step 2). The read is followed out through every call and map that handed it down (`traced`), to what the rehearsal
 * sets: a node's answer, an element of a list a node holds, or the trigger's input. A traced demand never lands past
 * a guard: where it meets a guard's answer, it is written into the value the guard judges, so the guard judges it.
 * The trees are in `rehearse-handed-trees.ts`.
 */
import { rmSync } from 'node:fs';
import { checkTree } from '@wilanis/compiler';
import { type LoadResult, loadTree } from '@wilanis/core';
import { afterEach, describe, expect, it } from 'vitest';
import { casesFor } from '../src/branches.js';
import { BUILTIN_PLUGINS, type Rehearsal, rehearse } from '../src/index.js';
import { switchesReached } from '../src/rehearse-reached.js';
import { broadcastTree, calledTree, eachGuardTree, peopleTree, throughGuardTree } from './rehearse-handed-trees.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A tree loaded, once the checker has let it through: a case about the walk must stand on a tree that passes. */
function loaded(dir: string): LoadResult {
  dirs.push(dir);
  const load = loadTree(dir, BUILTIN_PLUGINS);
  const refused = checkTree(load).format();
  if (refused) throw new Error(`the tree a case rehearses must itself pass:\n${refused}`);
  return load;
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

/** What each case of one switch steers, under seed 1: the stubs it writes, by node path and field, and the input it patches. */
async function steeredBy(load: LoadResult, at: string) {
  const trigger = load.registry.all('trigger')[0];
  const walk = trigger && (await switchesReached(load, trigger, 1));
  const sw = walk?.found.find(one => one.at === at);
  if (!walk || !sw) throw new Error(`no switch ${at}: ${walk?.found.map(one => one.at).join(', ')}`);
  return casesFor(sw, walk.stubbing).map(one => ({
    stubs: Object.keys(one.stubs),
    input: (one.input ?? []).map(patch => patch.path.join('.')),
    unreachable: one.unreachable ?? [],
  }));
}

describe('a value a map hands every element alike (M2)', () => {
  it("is followed out through the map's own in to the node that answers it", { timeout: 30_000 }, async () => {
    const load = loaded(broadcastTree());
    expect(await steeredBy(load, 'op.judged.0.op.isFirst')).toEqual([
      { stubs: ['op.info'], input: [], unreachable: [] },
      { stubs: ['op.info'], input: [], unreachable: [] },
    ]);
    const done = await rehearse(load, { seed: 1 });
    expect(branchesOf(done, 'domain/judge.graph.json', 'isFirst')).toEqual([
      ['first', 'done'],
      ['high', 'done'],
    ]);
    expect(branchesOf(done, 'domain/judge.graph.json', 'isHigh')).toEqual([
      ['isFirst', 'done'],
      ['low', 'done'],
    ]);
    expect(done.ok, done.lines.join('\n')).toBe(true);
  });
});

describe('a value a calling graph hands', () => {
  for (const [handed, what] of [
    ['node', 'copied from a node (M16)'],
    ['object', 'inside an object the call writes out'],
  ] as const)
    it(`is followed out to the node it is ${what}`, { timeout: 30_000 }, async () => {
      const load = loaded(calledTree(handed));
      expect(await steeredBy(load, 'op.judged.op.isHigh')).toEqual([
        { stubs: ['op.facts'], input: [], unreachable: [] },
        { stubs: ['op.facts'], input: [], unreachable: [] },
      ]);
      const done = await rehearse(load, { seed: 1 });
      expect(branchesOf(done, 'domain/judge.graph.json', 'isHigh')).toEqual([
        ['high', 'done'],
        ['low', 'done'],
      ]);
      expect(done.ok, done.lines.join('\n')).toBe(true);
    });

  it("is followed out to the trigger's input where a call hands it on under another name", {
    timeout: 30_000,
  }, async () => {
    const load = loaded(calledTree('renamed'));
    expect(await steeredBy(load, 'op.judged.op.isHigh')).toEqual([
      { stubs: [], input: ['level'], unreachable: [] },
      { stubs: [], input: ['level'], unreachable: [] },
    ]);
    const done = await rehearse(load, { seed: 1 });
    expect(branchesOf(done, 'domain/judge.graph.json', 'isHigh')).toEqual([
      ['high', 'done'],
      ['low', 'done'],
    ]);
    expect(done.ok, done.lines.join('\n')).toBe(true);
  });
});

describe('a guard on each element a map writes (Item 12)', () => {
  it('is steered through element 0 of the list the map runs over, to both its branches', {
    timeout: 30_000,
  }, async () => {
    const load = loaded(eachGuardTree());
    expect(await steeredBy(load, 'op.written.0.op.in:check')).toEqual([
      { stubs: ['op.plan'], input: [], unreachable: [] },
      { stubs: ['op.plan'], input: [], unreachable: [] },
    ]);
    const done = await rehearse(load, { seed: 1 });
    expect(branchesOf(done, 'data/write.graph.json', 'in:check')).toEqual([
      ['in:ok', 'done'],
      ['in:violated', 'invariant'],
    ]);
    expect(done.ok, done.lines.join('\n')).toBe(true);
  });
});

describe('a guard on each element of a list a guard upstream judged element by element', () => {
  it('is held across a map', { timeout: 30_000 }, async () => {
    // each edit is made a PageEdit at `edits`, whose map judges every element before `written` hands one to the write
    const done = await rehearse(loaded(eachGuardTree('each')), { seed: 1 });
    const held = "by guard 'edits:check' in features/rv/domain/refresh, which judged this value first";
    const decision = done.decisions.find(one => one.graph.endsWith('data/write.graph.json') && one.node === 'in:check');
    expect(
      decision?.branches.map(one => [one.to, one.held]),
      done.lines.join('\n'),
    ).toEqual([
      ['in:ok', held],
      ['in:violated', held],
    ]);
    expect(done.lines).toContain(`  ok  holds     held upstream ${held}`);
    expect(done.ok, done.lines.join('\n')).toBe(true);
  });
});

describe('a demand traced to the answer of a guard upstream', () => {
  it('writes an element of a list a guarded node holds into the value that guard judges', {
    timeout: 30_000,
  }, async () => {
    const load = loaded(eachGuardTree('plan'));
    expect(await steeredBy(load, 'op.written.0.op.in:check')).toEqual([
      { stubs: ['op.plan:made'], input: [], unreachable: [] },
      { stubs: ['op.plan:made'], input: [], unreachable: [] },
    ]);
    const done = await rehearse(load, { seed: 1 });
    expect(branchesOf(done, 'data/write.graph.json', 'in:check')).toEqual([
      ['in:ok', 'done'],
      ['in:violated', 'invariant'],
    ]);
    expect(done.ok, done.lines.join('\n')).toBe(true);
  });

  it("goes on past a taken site's in:ok as in, out to what the guard's caller handed", {
    timeout: 30_000,
  }, async () => {
    const load = loaded(throughGuardTree());
    expect(await steeredBy(load, 'op.judged.op.rated.op.isHigh')).toEqual([
      { stubs: ['op.facts'], input: [], unreachable: [] },
      { stubs: ['op.facts'], input: [], unreachable: [] },
    ]);
    const done = await rehearse(load, { seed: 1 });
    expect(branchesOf(done, 'domain/rate.graph.json', 'isHigh')).toEqual([
      ['high', 'done'],
      ['low', 'done'],
    ]);
    expect(done.ok, done.lines.join('\n')).toBe(true);
  });

  it('is written into the value that guard judges, never past it', { timeout: 30_000 }, async () => {
    // keep is handed the person's name, which person:check judged, beside the draft's email
    const load = loaded(peopleTree('email'));
    const steered = await steeredBy(load, 'op.kept.op.in:check');
    for (const one of steered) expect(one.stubs).not.toContain('op.person');
    expect(steered.flatMap(one => one.stubs)).toContain('op.person:made');
    const done = await rehearse(load, { seed: 1 });
    const lines = done.lines;
    const at = lines.findIndex(line => line.includes("data/keep-person  guard 'in:check'"));
    expect(lines.slice(at, at + 3)).toEqual([
      "features/people/data/keep-person  guard 'in:check' A person is reachable  1/2 branches",
      "  ok  holds     answered from 'in:ok'",
      "  ??  violated  NEVER RUN -- the rehearsal did not reach it: the run ended at 'person:violated' in features/people/domain/register-person, which refused as invariant",
    ]);
  });
});
