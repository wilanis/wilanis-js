/**
 * What `wilanis rehearse --record` and `wilanis fuzz --edges` share when they record the example (RFC 0036, step 5):
 * each writes its scenarios with a digest per node and `sharedStubs` in place of `stubs`, beside the one
 * `answers.json` that holds each value once; its `--check` judges that file as one more of the directory; a change of
 * behaviour diffs as the same scenarios written inline diff; and a value no scenario needs any more is not kept. On
 * copies of the example.
 */
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AnswersDoc, canonicalJson, loadTree, nodesOf, type ScenarioDoc, stubsOf } from '@wilanis/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EDGES, fuzz, RECORDED, regress, rehearse } from '../src/index.js';
import { copyOfExample, INCLUDES, PLUGINS } from './example-harness.js';

const load = (dir: string) => loadTree(dir, PLUGINS, INCLUDES);
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const GET_ROW = 'features/customers/data/get-row.graph.json';

/** Every scenario file below a directory, by its path below the tree's root. */
function scenariosUnder(root: string, dir: string): string[] {
  return readdirSync(join(root, dir)).flatMap(name => {
    const path = `${dir}/${name}`;
    if (statSync(join(root, path)).isDirectory()) return scenariosUnder(root, path);
    return name.endsWith('.scenario.json') ? [path] : [];
  });
}

/** The digests the scenarios under a directory point at, nodes and stubs apart. */
function pointedAt(root: string, dir: string): { nodes: Set<string>; stubs: Set<string> } {
  const out = { nodes: new Set<string>(), stubs: new Set<string>() };
  for (const file of scenariosUnder(root, dir)) {
    const sc: ScenarioDoc = read(join(root, file));
    for (const node of Object.values(sc.expect.nodes)) if (typeof node === 'string') out.nodes.add(node);
    for (const digest of Object.values(sc.sharedStubs ?? {})) out.stubs.add(digest);
  }
  return out;
}

/** A copy of a copy, so each case changes its own. */
function copyOf(root: string): string {
  const copy = mkdtempSync(join(tmpdir(), 'wilanis-'));
  cpSync(root, copy, { recursive: true });
  return copy;
}

/** A copy of a copy, with every scenario under `dir` written inline again and its answers file removed. */
function inlineCopy(root: string, dir: string): string {
  const copy = copyOf(root);
  const answers: AnswersDoc = read(join(copy, dir, 'answers.json'));
  for (const file of scenariosUnder(copy, dir)) {
    const sc: ScenarioDoc = read(join(copy, file));
    const { sharedStubs, ...rest } = sc;
    const stubs = sharedStubs ? { stubs: stubsOf(sc, answers).stubs } : {};
    writeFileSync(
      join(copy, file),
      JSON.stringify({ ...rest, ...stubs, expect: { ...sc.expect, nodes: nodesOf(sc, answers).nodes } }),
    );
  }
  rmSync(join(copy, dir, 'answers.json'));
  return copy;
}

let dir: string;
beforeAll(async () => {
  dir = copyOfExample();
  await rehearse(load(dir), { record: RECORDED });
  await fuzz(load(dir), { edges: true });
}, 120_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('rehearse --record and fuzz --edges share what their scenarios answered', () => {
  for (const [under, generated] of [
    [RECORDED, 'rehearse'],
    [EDGES, 'edges'],
  ]) {
    it(`writes every node answer and stub value under ${under}/ once, in ${under}/answers.json`, () => {
      const answers: AnswersDoc = read(join(dir, under, 'answers.json'));
      expect(answers.generated).toBe(generated);
      // no scenario holds an answer or a stub of its own
      for (const file of scenariosUnder(dir, under)) {
        const sc: ScenarioDoc = read(join(dir, file));
        expect(Object.values(sc.expect.nodes).every(node => typeof node === 'string')).toBe(true);
        expect(sc.stubs).toBeUndefined();
        expect(nodesOf(sc, answers).unresolved).toEqual([]);
        expect(stubsOf(sc, answers).unresolved).toEqual([]);
      }
      // each value is held once, and each is one a scenario points at: nothing more, nothing twice
      const pointed = pointedAt(dir, under);
      expect(Object.keys(answers.nodes).sort()).toEqual([...pointed.nodes].sort());
      expect(Object.keys(answers.stubs).sort()).toEqual([...pointed.stubs].sort());
      for (const map of [answers.nodes, answers.stubs])
        expect(new Set(Object.values(map).map(canonicalJson)).size).toBe(Object.keys(map).length);
      expect(pointed.nodes.size).toBeGreaterThan(0);
      expect(pointed.stubs.size).toBeGreaterThan(0);
    });
  }

  it('is judged by fuzz --edges --check as one more file of the directory: stale when edited, missing when gone', {
    timeout: 60_000,
  }, async () => {
    const copy = copyOf(dir);
    const answers = join(copy, EDGES, 'answers.json');
    writeFileSync(answers, `${JSON.stringify(read(answers), null, 2)}\n`);
    const edited = await fuzz(load(copy), { edges: true, check: true });
    expect(edited.recorded?.check).toEqual({ stale: [`${EDGES}/answers.json`], missing: [], extra: [] });
    rmSync(answers);
    const removed = await fuzz(load(copy), { edges: true, check: true });
    expect(removed.recorded?.check).toEqual({ stale: [], missing: [`${EDGES}/answers.json`], extra: [] });
    rmSync(copy, { recursive: true, force: true });
  });
});

describe('a recorded directory that shares, once the tree has moved', () => {
  it('diffs as the same scenarios written inline diff, once get-row routes elsewhere', {
    timeout: 120_000,
  }, async () => {
    const inline = inlineCopy(dir, RECORDED);
    const shared = copyOf(dir);
    for (const copy of [inline, shared]) {
      const graph = read(join(copy, GET_ROW));
      graph.nodes.find((node: { id: string }) => node.id === 'outcome').rules[0].when = 'status == 410';
      writeFileSync(join(copy, GET_ROW), JSON.stringify(graph));
    }
    const [byValue, byDigest] = [(await regress(load(inline))).lines, (await regress(load(shared))).lines];
    expect(byDigest.filter(line => line.includes(': DIFF ')).length).toBeGreaterThan(0);
    expect(byDigest).toEqual(byValue);
    for (const copy of [inline, shared]) rmSync(copy, { recursive: true, force: true });
  });

  it('keeps no value that only a branch it no longer records used', { timeout: 120_000 }, async () => {
    const copy = copyOf(dir);
    const moved = (file: string) => file.includes('.get-row.outcome.noCustomer.');
    // the digests only the noCustomer branch's scenarios point at, as recorded
    const all = scenariosUnder(copy, RECORDED);
    const digestsOf = (files: string[]) =>
      files.flatMap(file => {
        const sc: ScenarioDoc = read(join(copy, file));
        return [...Object.values(sc.expect.nodes), ...Object.values(sc.sharedStubs ?? {})] as string[];
      });
    const others = new Set(digestsOf(all.filter(file => !moved(file))));
    const only = digestsOf(all.filter(moved)).filter(digest => !others.has(digest));
    expect(only.length).toBeGreaterThan(0);
    const graph = read(join(copy, GET_ROW));
    graph.nodes.find((node: { id: string }) => node.id === 'outcome').rules[0].when = 'status == 410';
    writeFileSync(join(copy, GET_ROW), JSON.stringify(graph));
    await rehearse(load(copy), { record: RECORDED });
    const answers: AnswersDoc = read(join(copy, RECORDED, 'answers.json'));
    const now = new Set(digestsOf(scenariosUnder(copy, RECORDED)));
    const held = [...Object.keys(answers.nodes), ...Object.keys(answers.stubs)];
    // every value held is one a scenario points at now, so what only the old branch needed is gone
    expect(held.filter(digest => !now.has(digest))).toEqual([]);
    expect(only.filter(digest => !now.has(digest)).length).toBeGreaterThan(0);
    for (const digest of only.filter(one => !now.has(one))) expect(held).not.toContain(digest);
    rmSync(copy, { recursive: true, force: true });
  });
});
