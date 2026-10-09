/**
 * What `writeRecorded` and `checkRecorded` make of the answers a recorded directory shares (RFC 0036, step 5), on
 * scenarios written here into an empty tree: each distinct value once, under the digest of exactly the JSON written,
 * no file where nothing is shared, a collision refused, and an `answers.json` owned as a scenario is -- the one at the
 * top of the directory written whole, and any below it never left to be read in its place.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AnswersDoc, answerDigest, canonicalJson, nodesOf, type ScenarioDoc, stubsOf } from '@wilanis/core';
import { afterEach, describe, expect, it } from 'vitest';
import { checkRecorded, RECORDED, writeRecorded } from '../src/index.js';
import { sharedOf } from '../src/recorded-answers.js';
import { keptIn } from '../src/recorded-dir.js';
import { EDGED, REHEARSED } from '../src/recorded-owner.js';

const ANSWERS = `${RECORDED}/answers.json`;
const CURRENT = { stale: [], missing: [], extra: [] };
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

/** A recorded scenario that runs nowhere, with the nodes and stubs a case gives it, written inline. */
const scenario = (nodes: Record<string, unknown>, stubs?: Record<string, unknown>): ScenarioDoc =>
  ({
    $schema: 'https://raw.githubusercontent.com/wilanis/wilanis-js/main/packages/core/schemas/scenario.schema.json',
    description: 'A run, written here.',
    generated: 'rehearse',
    trigger: '@features/customers/edge/get-customer.trigger.json',
    seed: 1,
    ...(stubs ? { stubs } : {}),
    expect: { status: 'done', nodes },
  }) as ScenarioDoc;

const FETCHED = { status: 'done', handler: '@http/http.port.json#request', out: { status: 404 } };
const ROUTED = { status: 'done', selected: 'noCustomer', out: 'noCustomer' };
const CANCELLED = { status: 'cancelled' };

/** Two scenarios that share a node answer and a stub value, and each hold one of their own. */
const DOCS = {
  'customers.get-customer/a.scenario.json': scenario(
    { op: ROUTED, 'op.fetched': FETCHED, 'op.gone': CANCELLED },
    { 'op.fetched': { status: 404 } },
  ),
  'customers.get-customer/b.scenario.json': scenario({ op: CANCELLED, 'op.fetched': FETCHED }, { 'op.fetched': 'x' }),
};

const roots: string[] = [];
/** An empty tree to write into. */
function tree(): string {
  const root = mkdtempSync(join(tmpdir(), 'wilanis-answers-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The lines of a map of the answers file, as `"<digest>":<value>` with no comma. */
const linesOf = (bytes: string) =>
  bytes
    .split('\n')
    .filter(line => /^"[0-9a-f]{16}":/.test(line))
    .map(line => line.replace(/,$/, ''));

describe('sharedOf and writeRecorded: each value once', () => {
  it('writes each distinct node answer and stub value once, one per line, sorted, under the digest of its line', () => {
    const root = tree();
    const written = writeRecorded(root, RECORDED, DOCS);
    expect(written).toEqual([ANSWERS, ...Object.keys(DOCS).map(file => `${RECORDED}/${file}`)]);
    const bytes = readFileSync(join(root, ANSWERS), 'utf8');
    const answers: AnswersDoc = JSON.parse(bytes);
    expect(Object.values(answers.nodes)).toHaveLength(3);
    expect(Object.values(answers.stubs)).toHaveLength(2);
    expect(answers).toMatchObject({ generated: 'rehearse' });
    expect(answers.description).toBe(
      `The node answers and stub values the scenarios under ${RECORDED}/ share, each once, under its digest. ` +
        'Written by wilanis rehearse --record; regenerate it, do not edit it.',
    );
    // the envelope opens the first line, each map opens on a line of its own, and each value is on one line
    expect(bytes.split('\n')[0]).toMatch(/^\{"\$schema":".*","generated":"rehearse","nodes":\{$/);
    expect(bytes).toContain('\n},"stubs":{\n');
    expect(bytes.endsWith('\n}}\n')).toBe(true);
    const lines = linesOf(bytes);
    expect(lines).toHaveLength(5);
    for (const line of lines) {
      const [, digest, text] = /^"([0-9a-f]{16})":(.*)$/.exec(line) ?? [];
      expect(createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)).toBe(digest);
      expect(text).toBe(canonicalJson(JSON.parse(text)));
    }
    const nodeLines = lines.slice(0, 3).map(line => line.slice(1, 17));
    expect(nodeLines).toEqual([...nodeLines].sort());
    // a scenario names digests, in the place of what it held, and reads back as it was written
    for (const [file, doc] of Object.entries(DOCS)) {
      const sc = read(join(root, RECORDED, file));
      expect(Object.keys(sc)).toEqual(Object.keys(doc).map(key => (key === 'stubs' ? 'sharedStubs' : key)));
      expect(Object.values(sc.expect.nodes).every(node => typeof node === 'string')).toBe(true);
      expect(nodesOf(sc, answers)).toEqual({ nodes: doc.expect.nodes, unresolved: [] });
      expect(stubsOf(sc, answers)).toEqual({ stubs: doc.stubs, unresolved: [] });
    }
    expect(checkRecorded(root, RECORDED, DOCS)).toEqual(CURRENT);
  });

  it('writes the same bytes whatever order the scenarios and their keys come in', () => {
    const [one, other] = [tree(), tree()];
    writeRecorded(one, RECORDED, DOCS);
    const reversed: Record<string, ScenarioDoc> = JSON.parse(
      JSON.stringify(Object.fromEntries(Object.entries(DOCS).reverse())),
    );
    reversed['customers.get-customer/b.scenario.json'].expect.nodes['op.fetched'] = {
      out: { status: 404 },
      handler: FETCHED.handler,
      status: 'done',
    };
    writeRecorded(other, RECORDED, reversed);
    expect(readFileSync(join(other, ANSWERS), 'utf8')).toBe(readFileSync(join(one, ANSWERS), 'utf8'));
  });

  it('hashes exactly the JSON it writes: a Date as its text, an absent value left out as JSON leaves it out', () => {
    const root = tree();
    const at = new Date(0);
    const docs = {
      'x/dated.scenario.json': scenario(
        { op: { status: 'done', out: { at, gone: undefined, list: [undefined, 1] } } },
        { op: { at }, 'op.absent': undefined },
      ),
    };
    writeRecorded(root, RECORDED, docs);
    const answers: AnswersDoc = read(join(root, ANSWERS));
    const sc = read(join(root, RECORDED, 'x/dated.scenario.json'));
    // what the scenario means is what its inline form, written as JSON, would have meant
    const inline: ScenarioDoc = JSON.parse(JSON.stringify(docs['x/dated.scenario.json']));
    expect(nodesOf(sc, answers)).toEqual(nodesOf(inline, undefined));
    expect(stubsOf(sc, answers)).toEqual(stubsOf(inline, undefined));
    expect(sc.expect.nodes.op).toBe(answerDigest({ status: 'done', out: { at: at.toISOString(), list: [null, 1] } }));
    expect(sc.sharedStubs).toEqual({ op: answerDigest({ at: at.toISOString() }) });
    for (const line of linesOf(readFileSync(join(root, ANSWERS), 'utf8'))) {
      const [, digest, text] = /^"([0-9a-f]{16})":(.*)$/.exec(line) ?? [];
      expect(answerDigest(JSON.parse(text))).toBe(digest);
    }
  });

  it('refuses two values one digest names, naming both, and takes one value twice', () => {
    const one = () => 'aaaaaaaaaaaaaaaa';
    expect(() => sharedOf(DOCS, RECORDED, REHEARSED, one)).toThrow(
      `two different values share the digest aaaaaaaaaaaaaaaa, and an answers file holds one value under a digest: ` +
        `${canonicalJson({ status: 404 })} and ${canonicalJson(ROUTED)}`,
    );
    const twice = { 'a.scenario.json': scenario({ op: CANCELLED, 'op.x': { ...CANCELLED } }) };
    expect(sharedOf(twice, RECORDED, REHEARSED, one).answers?.nodes).toEqual({ aaaaaaaaaaaaaaaa: CANCELLED });
  });

  it('writes no answers file where nothing is shared, removes the one it wrote before, and checks so', () => {
    const root = tree();
    writeRecorded(root, RECORDED, DOCS);
    const unreachable = { 'x/never.scenario.json': { ...scenario({}), expect: { status: 'unreachable', nodes: {} } } };
    expect(sharedOf(unreachable as Record<string, ScenarioDoc>, RECORDED, REHEARSED).answers).toBeUndefined();
    expect(checkRecorded(root, RECORDED, unreachable as Record<string, ScenarioDoc>).extra).toContain(ANSWERS);
    expect(writeRecorded(root, RECORDED, unreachable as Record<string, ScenarioDoc>)).toEqual([
      `${RECORDED}/x/never.scenario.json`,
    ]);
    expect(existsSync(join(root, ANSWERS))).toBe(false);
    expect(writeRecorded(root, RECORDED, {})).toEqual([]);
    expect(existsSync(join(root, ANSWERS))).toBe(false);
  });
});

describe('writeRecorded and checkRecorded: the answers file is owned as a scenario is', () => {
  it('refuses to write over an answers.json it did not write, and keeps one where it writes none', () => {
    for (const generated of [undefined, 'edges']) {
      const root = tree();
      mkdirSync(join(root, RECORDED), { recursive: true });
      const mine = JSON.stringify({ description: 'mine', generated, nodes: {}, stubs: {} });
      writeFileSync(join(root, ANSWERS), mine);
      expect(() => writeRecorded(root, RECORDED, DOCS)).toThrow(
        `${ANSWERS} would be written over, and --record did not write it (no "generated": "rehearse"): ` +
          `move it out of ${RECORDED}/, where --record writes`,
      );
      expect(existsSync(join(root, RECORDED, 'customers.get-customer'))).toBe(false);
      expect(readFileSync(join(root, ANSWERS), 'utf8')).toBe(mine);
      expect(checkRecorded(root, RECORDED, DOCS).stale).toEqual([ANSWERS]);
      // where nothing would be shared, it is in no one's way, and left as it is
      expect(writeRecorded(root, RECORDED, {})).toEqual([]);
      expect(keptIn(root, RECORDED, {})).toEqual([ANSWERS]);
    }
  });

  it('calls an answers.json below the top extra, removes one it wrote, and refuses one it did not', () => {
    const root = tree();
    writeRecorded(root, RECORDED, DOCS);
    const stray = `${RECORDED}/customers.get-customer/answers.json`;
    writeFileSync(join(root, stray), readFileSync(join(root, ANSWERS)));
    expect(checkRecorded(root, RECORDED, DOCS)).toEqual({ ...CURRENT, extra: [stray] });
    writeRecorded(root, RECORDED, DOCS);
    expect(existsSync(join(root, stray))).toBe(false);
    expect(checkRecorded(root, RECORDED, DOCS)).toEqual(CURRENT);
    // one nobody owns, or another command wrote, is extra all the same, and the write leaves it and refuses
    for (const generated of [undefined, 'edges']) {
      writeFileSync(join(root, stray), JSON.stringify({ description: 'stray', generated, nodes: {}, stubs: {} }));
      expect(checkRecorded(root, RECORDED, DOCS)).toEqual({ ...CURRENT, extra: [stray] });
      expect(keptIn(root, RECORDED, DOCS)).toEqual([]);
      expect(() => writeRecorded(root, RECORDED, DOCS)).toThrow(
        `${stray} would be read in place of ${ANSWERS} by the scenarios beside it, and --record did not write it`,
      );
      expect(existsSync(join(root, stray))).toBe(true);
    }
  });

  it("marks the edges directory's answers file as fuzz --edges's", () => {
    const shared = sharedOf(DOCS, 'scenarios/edges', EDGED);
    expect(shared.answers?.generated).toBe('edges');
    expect(shared.answers?.description).toContain('under scenarios/edges/ share');
    expect(shared.answers?.description).toContain('Written by wilanis fuzz --edges;');
  });
});
