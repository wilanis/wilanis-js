/**
 * What the rehearsal reaches (#637). Every other decision on a branch's run is steered to answer, so a switch behind a
 * call that decides on a generated answer is still reached; a list the trigger hands down under another name is made
 * to hold an element; and a branch whose run never got to its switch is reported as not reached -- never credited
 * with whatever ended the run -- and is not recorded as though it ran. A switch in the same graph that routes what a
 * switch reads is steered to route it there, and not only to answer (#569).
 */
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadTree } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { RECORDED, type Rehearsal, rehearse } from '../src/index.js';
import { codes, copyOfExample, EXAMPLE, INCLUDES, PLUGINS } from './example-harness.js';

const load = (dir: string) => loadTree(dir, PLUGINS, INCLUDES);
const GET_ROW = 'features/customers/data/get-row.graph.json';
const KEPT_GET = 'features/customers/data/kept-get.graph.json';

/** One decision of a rehearsal, by the graph that declares it and the switch's id. */
const decisionOf = (run: Rehearsal, graph: string, node: string) =>
  run.decisions.find(one => one.graph.endsWith(graph) && one.node === node);

describe('the rehearsal reaches a switch behind a call that decides first', () => {
  it("steers get-row to answer, so update-row's branches settle at their own nodes behind update-customer's get", {
    timeout: 20_000,
  }, async () => {
    const run = await rehearse(load(EXAMPLE), { seed: 1, profile: 'live' });
    expect(run.ok, run.lines.join('\n')).toBe(true);
    const row = decisionOf(run, 'data/update-row.graph.json', 'outcome');
    expect(row?.triggers).toEqual(['update-customer']);
    expect(row?.branches.map(one => [one.to, one.settled?.status, one.settled?.declared?.reason])).toEqual([
      ['noCustomer', 'failed', 'missing'],
      ['customer', 'done', undefined],
      ['upstreamFailed', 'failed', 'upstream'],
    ]);
    // and the guard update-customer lowered over the customer it makes judges it, rather than get-row's refusal
    const guard = decisionOf(run, 'domain/update-customer.graph.json', 'customer:check');
    expect(guard?.branches.map(one => [one.to, one.settled?.status, one.settled?.declared?.reason])).toEqual([
      ['customer', 'done', undefined],
      ['customer:violated', 'failed', 'invariant'],
    ]);
    for (const one of [...(row?.branches ?? []), ...(guard?.branches ?? [])])
      expect(one.settled?.propagated).toBeUndefined();
  });

  it('makes the list a batch delete maps over hold an id, under the seed that generates it none', {
    timeout: 20_000,
  }, async () => {
    // the trigger hands its ids to a graph that takes the list whole, as that graph's `in`
    const run = await rehearse(load(EXAMPLE), { seed: 5, profile: 'live' });
    const row = decisionOf(run, 'data/delete-row.graph.json', 'outcome');
    expect(row?.triggers).toContain('delete-customers');
    for (const one of row?.branches ?? []) expect(one.uncovered, one.uncovered).toBeUndefined();
  });
});

describe("the rehearsal steers a guard's own graph to the node it judges (#569)", () => {
  it("routes kept-get's switch to the made node a guard judges, not to its first branch that answers", {
    timeout: 60_000,
  }, async () => {
    const dir = copyOfExample();
    // a gold record is answered first, from a node of its own: the guarded `customer` is now the second branch that
    // answers, so a run steered only to answer takes the gold branch, and the guard over `customer` never runs
    const doc = JSON.parse(readFileSync(join(dir, KEPT_GET), 'utf8'));
    const decides = doc.nodes.find((node: any) => node.type.endsWith('/switch.schema.json'));
    decides.rules.unshift({ when: "has(record) && record.tier == 'gold'", to: 'goldCustomer' });
    const customer = doc.nodes.find((node: any) => node.id === 'customer');
    doc.nodes.push({ ...customer, id: 'goldCustomer', label: 'The gold record' });
    doc.out.from.unshift('goldCustomer');
    writeFileSync(join(dir, KEPT_GET), JSON.stringify(doc, null, 2));
    expect(codes(dir)).toEqual([]);
    // what the read answers is drawn from the seed, so the guard is reached under every seed, not one that happens to
    // generate the record it needs
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const run = await rehearse(load(dir), { seed, profile: 'local' });
      expect(run.ok, run.lines.join('\n')).toBe(true);
      const guard = decisionOf(run, 'data/kept-get.graph.json', 'customer:check');
      expect(guard?.branches.map(one => [one.to, one.settled?.status, one.settled?.declared?.reason])).toEqual([
        ['customer', 'done', undefined],
        ['customer:violated', 'failed', 'invariant'],
      ]);
      const kept = decisionOf(run, 'data/kept-get.graph.json', decides.id);
      expect(kept?.branches.map(one => [one.to, one.settled?.status])).toEqual([
        ['goldCustomer:made', 'done'],
        ['customer:made', 'done'],
        ['noCustomer', 'failed'],
      ]);
    }
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('a branch the rehearsal never reached', () => {
  it('is reported as not reached, saying where the run ended, and is not recorded', { timeout: 60_000 }, async () => {
    const dir = copyOfExample();
    // get-row now refuses on every branch, so nothing can steer update-customer past its get
    const doc = JSON.parse(readFileSync(join(dir, GET_ROW), 'utf8'));
    const customer = doc.nodes.find((node: any) => node.id === 'customer');
    customer.run = '@std/outcome.port.json#refuse';
    customer.in = { reason: 'missing', message: 'no row', type: '@customers/domain/Customer.shape.json' };
    writeFileSync(join(dir, GET_ROW), JSON.stringify(doc, null, 2));
    expect(codes(dir)).toEqual([]);
    const run = await rehearse(load(dir), { record: RECORDED });
    expect(run.ok).toBe(false);
    const row = decisionOf(run, 'data/update-row.graph.json', 'outcome');
    expect(row?.branches).toHaveLength(3);
    for (const one of row?.branches ?? []) {
      expect(one.settled).toBeUndefined();
      expect(one.uncovered).toMatch(
        /^the rehearsal did not reach it: the run ended at '\w+' in features\/customers\/data\/get-row, which refused as \w+$/,
      );
    }
    expect(run.lines.join('\n')).toContain('NEVER RUN -- the rehearsal did not reach it: the run ended at ');
    // a run that never got to the switch proves nothing of its branches: neither a run nor an unreachable is written
    const recorded = readdirSync(join(dir, RECORDED, 'customers.update-customer'));
    expect(recorded.filter(file => file.includes('.update-row.'))).toEqual([]);
    expect(recorded.length).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });
});
