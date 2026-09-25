/**
 * What a scenario names must be in the tree (RFC 0018): the trigger it replays (S001), the branch it proves --
 * a graph, a switch of it, and a node the switch routes to (S004) -- and the policy it replays under a trigger
 * that attaches it (S005). Each case plants one scenario in a copy of the example. The branch is `get-row`'s
 * `outcome`, which routes to `noCustomer`, `customer`, `upstreamFailed` (the else) and, when the call broke,
 * `unreachable`; the policies are `@wilanis/access`'s, attached by the customers' triggers.
 */
import { describe, expect, it } from 'vitest';
import { planted, plantedAll, plantedEditingAllSaying, plantedPointing } from './example-harness.js';

const SCHEMAS = 'https://raw.githubusercontent.com/wilanis/wilanis-js/main/packages/core/schemas';
const FILE = 'scenarios/rehearsed/get-customer/customers.get-row.outcome.noCustomer.scenario.json';
const GET = '@features/customers/edge/get-customer.trigger.json';
const DELETE = '@features/customers/edge/delete-customer.trigger.json';
const GRAPH = '@features/customers/data/get-row.graph.json';
const EMPLOYEES = '@access/edge/employees-only.policy.json';
const SIGNED_IN = '@access/edge/signed-in.policy.json';

/** A scenario of one trigger, valid but for what a case adds or breaks. */
const scenario = (trigger: string, extra: Record<string, unknown> = {}) => ({
  $schema: `${SCHEMAS}/scenario.schema.json`,
  description: 'A recorded run, planted to see what the checker makes of what it names.',
  trigger,
  seed: 1,
  expect: { status: 'done', nodes: {} },
  ...extra,
});

/** A scenario of GET /customers/{id} proving `outcome`'s branch, with one field of the branch replaced. */
const proving = (edit: Partial<Record<'graph' | 'node' | 'when' | 'to', string>>, extra = {}) =>
  scenario(GET, {
    generated: 'rehearse',
    branch: { graph: GRAPH, node: 'outcome', when: 'status == 404', to: 'noCustomer', ...edit },
    ...extra,
  });

/** What the checker says of one planted scenario, as `code message`. */
const saying = (doc: unknown) => plantedEditingAllSaying({ [FILE]: doc }, {});

describe('S001: a scenario names a trigger the tree has', () => {
  it('refuses a trigger that is gone, at trigger, from check/scenarios.ts', () => {
    expect(plantedPointing({ [FILE]: scenario('@customers/edge/no-such.trigger.json') })).toEqual([
      `S001 @${FILE}#trigger`,
    ]);
  });
});

describe('S004: a scenario proves a branch the graph has', () => {
  it('refuses a graph the tree does not have, at branch/graph', () => {
    const doc = proving({ graph: '@customers/data/no-such.graph.json' });
    expect(plantedPointing({ [FILE]: doc })).toEqual([`S004 @${FILE}#branch/graph`]);
    expect(saying(doc)).toEqual([
      "S004 the branch names graph '@customers/data/no-such.graph.json', which the tree does not have",
    ]);
  });

  it('refuses a node that is not a switch, at branch/node, naming the switches the graph has', () => {
    const doc = proving({ node: 'fetched' });
    expect(plantedPointing({ [FILE]: doc })).toEqual([`S004 @${FILE}#branch/node`]);
    expect(saying(doc)).toEqual([
      "S004 the branch names node 'fetched' of @features/customers/data/get-row.graph.json, which is not a switch: its switches are outcome",
    ]);
  });

  it('refuses a node the graph does not have, at branch/node', () => {
    expect(plantedPointing({ [FILE]: proving({ node: 'route' }) })).toEqual([`S004 @${FILE}#branch/node`]);
  });

  it("refuses a target the switch does not route to, at branch/to, naming the switch's targets", () => {
    const doc = proving({ to: 'gone' });
    expect(plantedPointing({ [FILE]: doc })).toEqual([`S004 @${FILE}#branch/to`]);
    expect(saying(doc)).toEqual([
      "S004 the branch names node 'gone' of switch 'outcome' in @features/customers/data/get-row.graph.json, which no rule of the switch routes to: it routes to noCustomer, customer, upstreamFailed, unreachable",
    ]);
  });

  it('refuses a run node the switch does not route to, though the graph has it', () => {
    expect(planted(FILE, proving({ to: 'fetched' }))).toEqual(['S004']);
  });

  it('passes a hand-written scenario of the else, whose when is not judged', () => {
    const doc = proving({ when: 'else', to: 'upstreamFailed' });
    delete (doc as Record<string, unknown>).generated;
    expect(planted('scenarios/mine.scenario.json', doc)).toEqual([]);
  });

  it('passes every rule, and the branch a catch routes to, whatever its when says', () => {
    expect(
      plantedAll({
        'scenarios/a.scenario.json': proving({ to: 'customer', when: 'the row came back' }),
        'scenarios/b.scenario.json': proving({ to: 'unreachable', when: 'fetched broke' }),
      }),
    ).toEqual([]);
  });
});

describe('S005: a policy scenario replays a policy its trigger attaches', () => {
  it('refuses a policy the trigger does not attach, at policy, naming what it attaches', () => {
    const doc = scenario(DELETE, { policy: SIGNED_IN });
    expect(plantedPointing({ [FILE]: doc })).toEqual([`S005 @${FILE}#policy`]);
    expect(saying(doc)).toEqual([
      'S005 trigger @features/customers/edge/delete-customer.trigger.json does not attach policy @features/access/edge/signed-in.policy.json: it attaches @features/access/edge/employees-only.policy.json, @features/access/edge/can-register.policy.json',
    ]);
  });

  it('refuses a policy on a trigger that attaches none', () => {
    const doc = scenario('@access/edge/issue-otp.trigger.json', { policy: EMPLOYEES });
    expect(planted(FILE, doc)).toEqual(['S005']);
    expect(saying(doc)).toEqual([
      'S005 trigger @features/access/edge/issue-otp.trigger.json does not attach policy @features/access/edge/employees-only.policy.json: it attaches none',
    ]);
  });

  it('refuses a policy the tree does not have, at policy', () => {
    const doc = scenario(DELETE, { policy: '@access/edge/no-such.policy.json' });
    expect(plantedPointing({ [FILE]: doc })).toEqual([`S005 @${FILE}#policy`]);
  });

  it('leaves a policy under a trigger that is gone to S001', () => {
    expect(planted(FILE, scenario('@customers/edge/no-such.trigger.json', { policy: EMPLOYEES }))).toEqual(['S001']);
  });

  it('passes a policy scenario whose trigger attaches it, matched by canonical path', () => {
    const decided = scenario(DELETE, {
      policy: '@features/access/edge/employees-only.policy.json',
      branch: {
        graph: '@access/domain/require-employee.graph.json',
        node: 'isEmployee',
        when: "has(principal) && principal.realm == 'employee'",
        to: 'granted',
      },
    });
    expect(planted('scenarios/rehearsed/policies/employees-only/granted.scenario.json', decided)).toEqual([]);
  });
});
