/**
 * Where the rehearsal cannot follow a read of `in` out to anything it sets, the branch says why (RFC 0038, step 4):
 * the trace stopped at text composed from reads, at a read of `context`, or at a literal. A literal that meets the
 * branch's rule needs no steering; one that excludes it closes the branch on that path, which is no problem where
 * another path runs it and a branch never run where every path closes it. A closed branch is recorded as an unreachable
 * scenario that `regress` solves again. The trees are in `rehearse-stopped-trees.ts`.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import { type LoadResult, loadTree } from '@wilanis/core';
import { afterEach, describe, expect, it } from 'vitest';
import { type Case, casesFor, type FoundSwitch, type KSwitchLike } from '../src/branches.js';
import { meets } from '../src/domains.js';
import { BUILTIN_PLUGINS, RECORDED, type Rehearsal, regress, rehearse } from '../src/index.js';
import { switchesReached, uncoveredBy, untakenBy } from '../src/rehearse-reached.js';
import { stoppedTree } from './rehearse-stopped-trees.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A tree loaded, once the checker has let it through: a case about the walk must stand on a tree that passes. */
function loaded(dir: string): LoadResult {
  if (!dirs.includes(dir)) dirs.push(dir);
  const load = loadTree(dir, BUILTIN_PLUGINS);
  const refused = checkTree(load).format();
  if (refused) throw new Error(`the tree a case rehearses must itself pass:\n${refused}`);
  return load;
}

/** The cases of the switch `isHigh` under the first trigger, as the walk builds them under seed 1. */
async function casesOf(load: LoadResult): Promise<Case[]> {
  const trigger = load.registry.all('trigger').find(one => one.name === 'level');
  const walk = trigger && (await switchesReached(load, trigger, 1));
  const sw = walk?.found.find(one => one.at.endsWith('isHigh'));
  if (!walk || !sw) throw new Error('no switch isHigh');
  return casesFor(sw, walk.stubbing);
}

/** The lines of the decision `isHigh`, from its header to the next blank line. */
function linesOf(run: Rehearsal): string[] {
  const start = run.lines.findIndex(line => line.includes("switch 'isHigh'"));
  const end = run.lines.indexOf('', start);
  return run.lines.slice(start, end);
}

const ALL = "'judged' in features/rv/domain/all";
const OTHER = "'judged' in features/rv/domain/other";
const COMPOSED = `in.level is composed at ${ALL}, so the rehearsal cannot vary it: hand it as one read of a node there, or decide before the call`;
const HIGH = `${ALL} hands in.level the literal "high"`;
const EVERY = `every caller hands a literal it excludes: ${HIGH}; no run takes it until a caller hands a value it accepts`;

describe('a read of in whose trace stops', () => {
  it('says where text composed from reads stops it, and the edit', { timeout: 30_000 }, async () => {
    const load = loaded(stoppedTree('composed'));
    const cases = await casesOf(load);
    expect(cases.map(one => [one.unreachable, one.why])).toEqual([
      [['level'], { level: COMPOSED }],
      [['level'], { level: COMPOSED }],
    ]);
    const run = await rehearse(load, { seed: 1 });
    expect(linesOf(run)).toEqual([
      "features/rv/domain/judge  switch 'isHigh'  0/2 branches",
      `  ??  when level == 'high'  NEVER RUN -- ${COMPOSED}`,
      `  ??  anything else         NEVER RUN -- ${COMPOSED}`,
    ]);
    expect(run.ok).toBe(false);
  });

  it('runs the branch a literal meets with nothing steered, and says every caller excludes the other', {
    timeout: 30_000,
  }, async () => {
    const load = loaded(stoppedTree('literal'));
    const [high, otherwise] = await casesOf(load);
    expect(high).toMatchObject({ stubs: {} });
    expect(high?.input).toBeUndefined();
    expect(high && untakenBy(high)).toBeUndefined();
    expect(otherwise?.closed).toBe(HIGH);
    expect(otherwise && uncoveredBy(otherwise)).toBeUndefined();
    const run = await rehearse(load, { seed: 1 });
    expect(linesOf(run)).toEqual([
      "features/rv/domain/judge  switch 'isHigh'  1/2 branches",
      "  ok  when level == 'high'  answered from 'high'",
      `  ??  anything else         NEVER RUN -- ${EVERY}`,
    ]);
    expect(run.lines).toContain(
      `  - features/rv/domain/judge 'isHigh': the 'else' branch to low can never run -- ${EVERY}`,
    );
    expect(run.ok).toBe(false);
  });

  it('runs each branch on the path whose literal meets it, says where the other closes it, and is ok', {
    timeout: 30_000,
  }, async () => {
    const run = await rehearse(loaded(stoppedTree('literal', { other: 'low' })), { seed: 1 });
    expect(linesOf(run)).toEqual([
      "features/rv/domain/judge  switch 'isHigh'  2/2 branches",
      "  ok  when level == 'high'  answered from 'high'",
      `  --  when level == 'high'  closed on this path: ${OTHER} hands in.level the literal "low"`,
      "  ok  anything else         answered from 'low'",
      `  --  anything else         closed on this path: ${HIGH}`,
    ]);
    expect(run.ok, run.lines.join('\n')).toBe(true);
  });
});

/** A switch on `in.who` one call in, the call handing `who` as given; the graph it stands in is `all`. */
function handedOne(who: unknown): { found: FoundSwitch; graphOf: () => string } {
  const node: KSwitchLike = { kind: 'switch', in: { who: { ref: 'in', path: ['who'] } }, rules: [], else: 'other' };
  node.rules.push({ to: 'admin', label: "who == 'admin'" });
  const found = {
    at: 'call.sw',
    prefix: ['call'],
    node,
    via: ['call'],
    lists: [],
    from: [{ at: 'call', in: { who } }],
  };
  return { found, graphOf: () => '@features/rv/domain/all.graph.json' };
}

describe('a demand on a stopped trace, met where the walk is written by hand', () => {
  it('says a read of context stops it, with the path it reads', () => {
    const { found, graphOf } = handedOne({ ref: 'context', path: ['principal', 'role'] });
    const why = `in.who reads context.principal.role at 'call' in features/rv/domain/all, which the rehearsal does not vary: hand it as one read of a node there to steer it`;
    for (const one of casesFor(found, { generated: () => undefined, graphOf })) {
      expect(one).toMatchObject({ unreachable: ['who'], why: { who: why } });
      expect(uncoveredBy(one)).toBe(why);
    }
  });

  it('needs nothing where a literal meets the rule, and closes the branch it excludes', () => {
    const { found, graphOf } = handedOne({ value: 'admin' });
    const [admin, other] = casesFor(found, { generated: () => undefined, graphOf });
    expect(admin).toMatchObject({ stubs: {} });
    expect(admin?.unreachable ?? admin?.closed ?? admin?.input).toBeUndefined();
    expect(other?.closed).toBe(`'call' in features/rv/domain/all hands in.who the literal "admin"`);
    expect(other && untakenBy(other)).toBe(`closed on this path: ${other?.closed}`);
  });
});

describe('whether a literal meets a demand', () => {
  it('judges the value it names, its presence, the length and words of a text, and a list', () => {
    expect(meets('high', { eq: 'high', present: true })).toBe(true);
    expect(meets('low', { eq: 'high', present: true })).toBe(false);
    expect(meets('high', { ne: ['high'] })).toBe(false);
    expect(meets('high', { absent: true })).toBe(false);
    expect(meets(undefined, { absent: true })).toBe(true);
    expect(meets(undefined, { ne: ['high'] })).toBe(true);
    expect(meets(undefined, { present: true })).toBe(false);
    expect(meets('', { minLen: 1 })).toBe(false);
    expect(meets('abc', { maxLen: 3, contains: ['b'] })).toBe(true);
    expect(meets('abc', { omits: ['b'] })).toBe(false);
    expect(meets([1], { minLen: 1, has: [1] })).toBe(true);
    expect(meets(7, { gt: 5 })).toBe(true);
    expect(meets(3, { gt: 5 })).toBe(false);
  });
});

describe('rehearse --record: a branch a literal closes', () => {
  it('is recorded unreachable with its sentence, regress answers same, and reachable now once the literal changes', {
    timeout: 120_000,
  }, async () => {
    const dir = stoppedTree('literal');
    const recorded = await rehearse(loaded(dir), { record: RECORDED });
    const file = recorded.recorded?.written.find(one => one.includes('isHigh') && one.includes('low'));
    if (!file) throw new Error(`no recorded else in ${recorded.recorded?.written.join(', ')}`);
    const doc = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    expect(doc.expect).toEqual({ status: 'unreachable', nodes: {}, unreachable: `closed on this path: ${HIGH}` });
    const same = await regress(loaded(dir));
    expect(same.lines).toContain(`@${file}: same`);
    expect(same.ok, same.lines.join('\n')).toBe(true);

    const all = join(dir, 'features/rv/domain/all.graph.json');
    writeFileSync(all, readFileSync(all, 'utf8').replace('"level":"high"', '"level":"low"'));
    const changed = await regress(loaded(dir));
    expect(changed.lines).toContain(`@${file}: DIFF branch 'else' → low is reachable now`);
    const checked = await rehearse(loaded(dir), { check: true });
    expect(checked.recorded?.check?.stale).toContain(file);
  });
});
