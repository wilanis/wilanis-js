/**
 * A scenario pins the reason a node refused with (RFC 0014): fuzz records it beside the status, regress diffs it, so a
 * refusal that became a fault and a reason that changed are both diffs; fuzz writes no scenario of a fault; and S002
 * refuses a reason pinned on a node that did not refuse. The example's GET /customers/{id} under seed 1 routes to
 * `upstreamFailed`, which refuses `upstream`: every case below breaks that one refusal.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import { loadTree } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { fuzz, regress } from '../src/index.js';
import { copyOfExample, INCLUDES, PLUGINS, planted, plantedPointing } from './example-harness.js';

const TRIGGER = '@features/customers/edge/get-customer.trigger.json';
const GRAPH = 'features/customers/data/get-row.graph.json';
const SCENARIO = 'scenarios/get-customer.1.scenario.json';
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

/** Edit the refuse node the seed-1 run of get-customer ends at, in a copy of the example. */
function editRefusal(dir: string, reason: string): void {
  const file = join(dir, GRAPH);
  const doc = read(file);
  doc.nodes.find((node: { id: string }) => node.id === 'upstreamFailed').in.reason = reason;
  writeFileSync(file, JSON.stringify(doc));
}

/** A copy of the example fuzzed once per trigger; the caller removes it. */
async function fuzzedCopy(): Promise<string> {
  const dir = copyOfExample();
  const fuzzed = await fuzz(loadTree(dir, PLUGINS, INCLUDES), { runs: 1, profile: 'live' });
  expect(fuzzed.ok, fuzzed.lines.join('\n')).toBe(true);
  return dir;
}

/** What regress says of get-customer's seed-1 scenario. */
async function replayed(dir: string): Promise<{ ok: boolean; line: string | undefined }> {
  const answer = await regress(loadTree(dir, PLUGINS, INCLUDES), { profile: 'live' });
  return { ok: answer.ok, line: answer.lines.find(line => line.startsWith(`@${SCENARIO}`)) };
}

describe('fuzz records the reason a node refused with, and regress diffs it', () => {
  it('pins the reason on the refusing node and on the call that ran its graph, and on nothing that answered', async () => {
    const dir = await fuzzedCopy();
    const nodes = read(join(dir, SCENARIO)).expect.nodes;
    expect(nodes['op.upstreamFailed']).toMatchObject({ status: 'failed', reason: 'upstream' });
    expect(nodes.op).toMatchObject({ status: 'failed', reason: 'upstream' });
    expect(nodes['op.fetched'].reason).toBeUndefined();
    expect(nodes['op.outcome'].reason).toBeUndefined();
    expect((await replayed(dir)).line).toBe(`@${SCENARIO}: same`);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a reason that changed is a diff, though the status is failed either way', async () => {
    const dir = await fuzzedCopy();
    editRefusal(dir, 'conflict');
    const { ok, line } = await replayed(dir);
    expect(ok).toBe(false);
    expect(line).toContain('op.upstreamFailed: reason upstream → conflict');
    expect(line).not.toContain('failed → ');
    rmSync(dir, { recursive: true, force: true });
  });

  it('a refusal that became a fault is a diff: the reason is none', async () => {
    const dir = await fuzzedCopy();
    // a reason that is not a word: the refuse handler breaks instead of refusing
    editRefusal(dir, '{{fetched.status}}');
    const { ok, line } = await replayed(dir);
    expect(ok).toBe(false);
    expect(line).toContain('op.upstreamFailed: reason upstream → none');
    rmSync(dir, { recursive: true, force: true });
  });

  it('a scenario from before reasons were recorded has none on any node, and replays as it did', async () => {
    const dir = await fuzzedCopy();
    const file = join(dir, SCENARIO);
    const doc = read(file);
    for (const node of Object.values(doc.expect.nodes) as { reason?: string }[]) delete node.reason;
    writeFileSync(file, JSON.stringify(doc));
    editRefusal(dir, 'conflict');
    expect((await replayed(dir)).line).toBe(`@${SCENARIO}: same`);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('fuzz writes no scenario of a fault', () => {
  it('says the fault, writes nothing for that run, and answers not ok', async () => {
    const dir = copyOfExample();
    editRefusal(dir, '{{fetched.status}}');
    const fuzzed = await fuzz(loadTree(dir, PLUGINS, INCLUDES), { runs: 1, profile: 'live' });
    expect(fuzzed.ok).toBe(false);
    expect(fuzzed.lines).toHaveLength(1);
    expect(fuzzed.lines[0]).toMatch(new RegExp(`^${TRIGGER} under seed 1: FAULT at 'op': .+`));
    expect(fuzzed.written.some(file => file.endsWith('get-customer.1.scenario.json'))).toBe(false);
    expect(fuzzed.written.length).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('S002: a reason belongs to a node that refused', () => {
  const scenario = (nodes: Record<string, unknown>) => ({
    $schema: 'https://raw.githubusercontent.com/wilanis/wilanis-js/main/packages/core/schemas/scenario.schema.json',
    description: 'A hand-written scenario of GET /customers/{id}.',
    trigger: TRIGGER,
    seed: 1,
    expect: { status: 'done', nodes },
  });

  it('refuses a reason on a node that answered, at the reason', () => {
    const pinned = scenario({ op: { status: 'done' }, 'op.customer': { status: 'done', reason: 'missing' } });
    expect(planted('scenarios/pinned.scenario.json', pinned)).toEqual(['S002']);
    expect(plantedPointing({ 'scenarios/pinned.scenario.json': pinned })).toEqual([
      'S002 @scenarios/pinned.scenario.json#expect/nodes/op.customer/reason',
    ]);
  });

  it('accepts a reason on a node that failed, and the scenarios fuzz writes', async () => {
    const pinned = scenario({ op: { status: 'failed', reason: 'upstream' } });
    expect(plantedPointing({ 'scenarios/pinned.scenario.json': pinned })).toEqual([]);
    const dir = await fuzzedCopy();
    expect(checkTree(loadTree(dir, PLUGINS, INCLUDES)).items).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});
