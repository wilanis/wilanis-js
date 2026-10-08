/**
 * A recorded scenario that points into its directory's answers document is read as its inline form (RFC 0036, step 2).
 * Nothing writes a pointer yet, so each case plants one: the example's committed `scenarios/rehearsed/` is copied into
 * two copies of the example, and in one of them every scenario is rewritten as `--record` will write it -- a digest per
 * node, `sharedStubs` in place of `stubs` -- beside the `answers.json` they point into. The checker, `regress` and
 * `describe` must say of the pointing copy exactly what they say of the inline one, and name the answers document it
 * reads (step 4); `describe` and `ls` show the answers document itself.
 */
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import { answerDigest, type LoadResult, loadTree, type ScenarioDoc, schemaUrl } from '@wilanis/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describe as describeDoc, ls, RECORDED, regress } from '../src/index.js';
import { copyOfExample, EXAMPLE, INCLUDES, PLUGINS } from './example-harness.js';

const MISSING = `${RECORDED}/customers.get-customer/customers.get-row.outcome.noCustomer.scenario.json`;
const ANSWERS = `${RECORDED}/answers.json`;
const NAMED = `answers @${ANSWERS}`;
const GET_ROW = 'features/customers/data/get-row.graph.json';
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

/** Every scenario file below a directory, by its path below the tree's root. */
function scenariosUnder(root: string, dir: string): string[] {
  return readdirSync(join(root, dir)).flatMap(name => {
    const path = `${dir}/${name}`;
    if (statSync(join(root, path)).isDirectory()) return scenariosUnder(root, path);
    return name.endsWith('.scenario.json') ? [path] : [];
  });
}

/** A copy of the example holding the scenarios it keeps under `scenarios/rehearsed/`, inline as committed. */
function inlineCopy(): string {
  const dir = copyOfExample();
  cpSync(join(EXAMPLE, RECORDED), join(dir, RECORDED), { recursive: true });
  return dir;
}

/** One scenario as `--record` will write it: each node and each stub a digest, the value held in `held`. */
function pointing(sc: ScenarioDoc, held: { nodes: Record<string, unknown>; stubs: Record<string, unknown> }) {
  const nodes: Record<string, string> = {};
  for (const [path, answer] of Object.entries(sc.expect.nodes)) {
    nodes[path] = answerDigest(answer);
    held.nodes[nodes[path]] = answer;
  }
  const shared: Record<string, string> = {};
  for (const [path, value] of Object.entries(sc.stubs ?? {})) {
    shared[path] = answerDigest(value);
    held.stubs[shared[path]] = value;
  }
  const { stubs: _, ...rest } = sc;
  return { ...rest, ...(sc.stubs ? { sharedStubs: shared } : {}), expect: { ...sc.expect, nodes } };
}

/** A copy whose recorded scenarios all point into `scenarios/rehearsed/answers.json`. */
function pointingCopy(): string {
  const dir = inlineCopy();
  const held = { nodes: {}, stubs: {} };
  for (const file of scenariosUnder(dir, RECORDED))
    writeFileSync(join(dir, file), JSON.stringify(pointing(read(join(dir, file)), held)));
  const answers = { $schema: schemaUrl('answers'), description: 'Planted.', generated: 'rehearse', ...held };
  writeFileSync(join(dir, ANSWERS), JSON.stringify(answers));
  return dir;
}

/** Edit one document of a copy in place. */
function editing(dir: string, file: string, edit: (doc: any) => void): void {
  const doc = read(join(dir, file));
  edit(doc);
  writeFileSync(join(dir, file), JSON.stringify(doc));
}

/** What regress says of each scenario of a copy, under the profile the example serves. */
const replayed = async (dir: string) => (await regress(loadTree(dir, PLUGINS, INCLUDES), { profile: 'live' })).lines;

const copies: string[] = [];
let inline: string;
let shared: string;

beforeAll(() => {
  inline = inlineCopy();
  shared = pointingCopy();
  copies.push(inline, shared);
});

afterAll(() => {
  for (const dir of copies) rmSync(dir, { recursive: true, force: true });
});

describe('a recorded scenario that points is read as its inline form', () => {
  it('points, as planted: no node holds an answer and no scenario a stub', () => {
    const doc = read(join(shared, MISSING));
    expect(Object.values(doc.expect.nodes).every(node => typeof node === 'string')).toBe(true);
    expect(doc.stubs).toBeUndefined();
    expect(Object.keys(doc.sharedStubs).length).toBeGreaterThan(0);
  });

  it('is checked as the inline form is: the tree stands either way', () => {
    expect(checkTree(loadTree(shared, PLUGINS, INCLUDES)).items).toEqual([]);
    expect(checkTree(loadTree(inline, PLUGINS, INCLUDES)).items).toEqual([]);
  });

  it('replays the same, every one, with the lines the inline form gives', { timeout: 120_000 }, async () => {
    const lines = await replayed(shared);
    expect(lines.filter(line => line.includes(' DIFF '))).toEqual([]);
    expect(lines).toEqual(await replayed(inline));
  });

  it('is described as the inline form is, the routed lines read through nodesOf', () => {
    const one = (dir: string): LoadResult => loadTree(dir, PLUGINS, INCLUDES);
    const [byDigest, byValue] = [one(shared), one(inline)];
    // the file line names the copy, which differs; every other line but the one naming the answers is the scenario's
    const said = (load: LoadResult, file: string) =>
      describeDoc(load, `@${file}`)
        .replace(/^file .*$/m, '')
        .replace(`\n${NAMED}`, '');
    for (const file of scenariosUnder(inline, RECORDED)) expect(said(byDigest, file)).toBe(said(byValue, file));
    expect(describeDoc(byDigest, `@${MISSING}`)).toContain('op.outcome → noCustomer');
  });
});

describe('a pointing scenario diffs as its inline form', () => {
  it('names the same differences once get-row routes elsewhere', { timeout: 120_000 }, async () => {
    const moved = [inlineCopy(), pointingCopy()];
    copies.push(...moved);
    for (const dir of moved) editing(dir, GET_ROW, doc => (doc.nodes[1].rules[0].when = 'status == 410'));
    const [byValue, byDigest] = [await replayed(moved[0]), await replayed(moved[1])];
    const missing = byDigest.find(line => line.startsWith(`@${MISSING}`));
    expect(missing).toMatch(/DIFF branch 'status == 404' → noCustomer no longer routes there: .*op\.outcome: routed/);
    expect(byDigest).toEqual(byValue);
  });

  it('cancels at a path under sharedStubs, replayed with the stubs stubsOf resolved', {
    timeout: 120_000,
  }, async () => {
    const pinned = [inlineCopy(), pointingCopy()];
    copies.push(...pinned);
    for (const dir of pinned) editing(dir, MISSING, doc => (doc.cancelAt = 'op.fetched'));
    expect(checkTree(loadTree(pinned[1], PLUGINS, INCLUDES)).items).toEqual([]);
    const [byValue, byDigest] = [await replayed(pinned[0]), await replayed(pinned[1])];
    const missing = byDigest.find(line => line.startsWith(`@${MISSING}`));
    expect(missing).toContain('status failed → cancelled');
    expect(byDigest).toEqual(byValue);
  });

  it('says a pointer its answers document does not hold, and fires nothing for it', { timeout: 120_000 }, async () => {
    const node = read(join(shared, MISSING)).expect.nodes['op.outcome'];
    const stub = read(join(shared, MISSING)).sharedStubs['op.fetched'];
    const unheld = pointingCopy();
    copies.push(unheld);
    editing(unheld, ANSWERS, doc => {
      delete doc.nodes[node];
      delete doc.stubs[stub];
    });
    const line = (await replayed(unheld)).find(one => one.startsWith(`@${MISSING}`));
    expect(line).toBe(
      `@${MISSING}: DIFF op.outcome: points at ${node}, which ${ANSWERS} does not hold; ` +
        `stub op.fetched: points at ${stub}, which ${ANSWERS} does not hold`,
    );
    rmSync(join(unheld, ANSWERS));
    const none = (await replayed(unheld)).find(one => one.startsWith(`@${MISSING}`));
    expect(none).toMatch(new RegExp(`^@${MISSING}: DIFF op: points at [0-9a-f]{16}, and no answers.json is above it;`));
  });
});

/** The body `describe` prints for one document: what follows the blank line after its description. */
const body = (load: LoadResult, path: string) => {
  const lines = describeDoc(load, path).split('\n');
  return lines.slice(lines.indexOf('') + 1);
};

describe('wilanis describe and ls show the answers document', () => {
  it('names the answers document a pointing scenario reads, before the command that rewrites it', () => {
    expect(body(loadTree(shared, PLUGINS, INCLUDES), `@${MISSING}`).slice(-3)).toEqual([
      '    op.outcome → noCustomer',
      NAMED,
      'generated by wilanis rehearse --record: regenerate, do not edit',
    ]);
    // the same scenario written inline shares nothing, so it names no answers document at all
    const plain = body(loadTree(inline, PLUGINS, INCLUDES), `@${MISSING}`);
    expect(plain.some(line => line.startsWith('answers'))).toBe(false);
  });

  it('names it where only a stub is shared, and says so where no answers.json is above a pointing one', () => {
    const stubsOnly = pointingCopy();
    copies.push(stubsOnly);
    const inlineNodes = read(join(inline, MISSING)).expect.nodes;
    editing(stubsOnly, MISSING, doc => (doc.expect.nodes = inlineNodes));
    expect(body(loadTree(stubsOnly, PLUGINS, INCLUDES), `@${MISSING}`)).toContain(NAMED);
    rmSync(join(stubsOnly, ANSWERS));
    expect(body(loadTree(stubsOnly, PLUGINS, INCLUDES), `@${MISSING}`)).toContain(
      'answers none -- no answers.json is above it, so its pointers read nothing',
    );
  });

  it('reads no answers document another command wrote: describe names none, and check refuses each pointer', () => {
    const edges = pointingCopy();
    copies.push(edges);
    editing(edges, ANSWERS, doc => (doc.generated = 'edges'));
    const load = loadTree(edges, PLUGINS, INCLUDES);
    const said = body(load, `@${MISSING}`);
    expect(said).toContain(
      `answers none -- @${ANSWERS} was written by wilanis fuzz --edges, not by wilanis rehearse --record, so its pointers read nothing`,
    );
    expect(said).not.toContain('    op.outcome → noCustomer');
    expect(
      checkTree(load)
        .items.filter(one => one.file === `@${MISSING}`)
        .map(one => one.code),
    ).toContain('S007');
    // a scenario written by hand has no command of its own, so no answers document is ever its own
    editing(edges, MISSING, doc => delete doc.generated);
    expect(body(loadTree(edges, PLUGINS, INCLUDES), `@${MISSING}`)).toContain(
      `answers none -- @${ANSWERS} was written by wilanis fuzz --edges, and a hand-written scenario cannot point, so its pointers read nothing`,
    );
  });

  it('describes answers.json by how many node answers and stub values it holds, and who writes it', () => {
    const held = read(join(shared, ANSWERS));
    expect(body(loadTree(shared, PLUGINS, INCLUDES), `@${ANSWERS}`)).toEqual([
      `holds ${Object.keys(held.nodes).length} node answers and ${Object.keys(held.stubs).length} stub values ` +
        `for the scenarios under ${RECORDED}/`,
      'generated by wilanis rehearse --record: regenerate, do not edit',
    ]);
  });

  it('lists each answers document under ls answers, marked with the command that writes it', () => {
    const both = pointingCopy();
    copies.push(both);
    mkdirSync(join(both, 'scenarios/edges'), { recursive: true });
    const edges = { $schema: schemaUrl('answers'), description: 'Planted.', generated: 'edges', nodes: {}, stubs: {} };
    writeFileSync(join(both, 'scenarios/edges/answers.json'), JSON.stringify(edges));
    const load = loadTree(both, PLUGINS, INCLUDES);
    expect(ls(load, 'answers')).toEqual([
      'answers          @scenarios/edges/answers.json  (edges)',
      `answers          @${ANSWERS}  (rehearse)`,
    ]);
    expect(body(load, '@scenarios/edges/answers.json')).toEqual([
      'holds 0 node answers and 0 stub values for the scenarios under scenarios/edges/',
      'generated by wilanis fuzz --edges: regenerate, do not edit',
    ]);
  });
});
