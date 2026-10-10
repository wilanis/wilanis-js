/**
 * A switch that reads a delegation's answer (#788). A binding operation met by a `run` lowers to a wrapper holding one
 * node `op`, the effect the kernel stubs and a seed records; a case for such a switch is written there, at
 * `<call>.op`, and never at the call. So a run that answers only effects from stubs -- an edge's, once it steers
 * (#782) -- is steered as the rehearsal is, and a recorded run shows the delegation running, as a real run does.
 */
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadTree } from '@wilanis/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { casesFor } from '../src/branches.js';
import { RECORDED, type Rehearsal, rehearse } from '../src/index.js';
import { switchesReached } from '../src/rehearse-reached.js';
import { copyOfExample, EXAMPLE, INCLUDES, PLUGINS } from './example-harness.js';

const load = (dir: string) => loadTree(dir, PLUGINS, INCLUDES);

/** The cases of one switch of a trigger's run, by the switch's dotted path, built over what seed 1 recorded. */
async function casesOf(trigger: string, at: string) {
  const tree = load(EXAMPLE);
  const found = tree.registry.all('trigger').find(one => one.name === trigger);
  if (!found) throw new Error(`no trigger ${trigger}`);
  const walk = await switchesReached(tree, found, 1);
  const sw = walk?.found.find(one => one.at === at);
  if (!sw) throw new Error(`no switch ${at} under ${trigger}`);
  return casesFor(sw, walk.stubbing);
}

/** Each branch of one decision as where it went and how it settled. */
function branchesOf(run: Rehearsal, graph: string, node: string) {
  const decision = run.decisions.find(one => one.graph.endsWith(graph) && one.node === node);
  if (!decision) throw new Error(`no decision ${graph} '${node}' in:\n${run.lines.join('\n')}`);
  return decision.branches.map(one => [one.to, one.uncovered ?? one.settled?.declared?.reason ?? one.settled?.status]);
}

describe("a case for a switch reading a delegation's answer", () => {
  it('writes its stub at the one effect the call delegates to, never at the call', { timeout: 30_000 }, async () => {
    const verdict = await casesOf('auth-customers', 'op.verdict');
    expect(verdict.map(one => Object.keys(one.stubs))).toEqual([
      ['op.checked.op'],
      ['op.checked.op'],
      ['op.checked.op'],
    ]);
    expect(verdict.map(one => one.unreachable)).toEqual([undefined, undefined, undefined]);
    // the demand is laid over the whole answer the seed recorded there, so what the branch reads next is still whole
    const steered = verdict[0].stubs['op.checked.op'] as { status: string; identity?: object };
    expect(steered.status).toBe('verified');
    expect(steered.identity).toBeDefined();
    const wasGood = await casesOf('refresh', 'op.wasGood');
    expect(wasGood.map(one => Object.keys(one.stubs))).toEqual([['op.traded.op'], ['op.traded.op']]);
  });
});

describe('the auth and refresh decisions', () => {
  it('settle at their declared outcomes under every seed, steered through the effect', {
    timeout: 90_000,
  }, async () => {
    for (const seed of [1, 2, 3]) {
      const run = await rehearse(load(EXAMPLE), { seed, profile: 'live' });
      expect(branchesOf(run, 'domain/sign-in-customer.graph.json', 'verdict'), `seed ${seed}`).toEqual([
        ['issued', 'done'],
        ['rejected', 'bad_credentials'],
        ['unavailable', 'directory_unavailable'],
      ]);
      expect(branchesOf(run, 'domain/sign-in-employee.graph.json', 'verdict'), `seed ${seed}`).toEqual([
        ['issued', 'done'],
        ['rejected', 'bad_credentials'],
        ['unavailable', 'directory_unavailable'],
      ]);
      expect(branchesOf(run, 'domain/refresh.graph.json', 'wasGood'), `seed ${seed}`).toEqual([
        ['renewed', 'done'],
        ['invalid', 'invalid_refresh'],
      ]);
    }
  });
});

describe('a recorded run of such a branch', () => {
  let dir: string;
  beforeAll(async () => {
    dir = copyOfExample();
    const recorded = await rehearse(load(dir), { record: RECORDED });
    expect(recorded.ok, recorded.lines.join('\n')).toBe(true);
  }, 60_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('stubs the effect and shows the delegation running, as a real run reports it', () => {
    const file = `${RECORDED}/access.auth-customers/access.sign-in-customer.verdict.issued.scenario.json`;
    const doc = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    expect(Object.keys(doc.sharedStubs ?? doc.stubs)).toEqual(['op.checked.op', 'op.issued.op']);
    expect(Object.keys(doc.expect.nodes)).toContain('op.checked.op');
    expect(doc.expect.status).toBe('done');
  });
});
