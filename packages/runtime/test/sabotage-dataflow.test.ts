/**
 * Sabotage: the hints G004 and G008 give when a graph is written as control flow. A node runs when every input
 * it reads is ready, whatever a switch chose; the switch chooses who answers, not who runs. An author who reads
 * it the other way puts the effect of each branch beside the switch and joins the two answers with `||`, and
 * the checker refuses that as G008 at each effect and G004 at the join. Both are right and neither, worded for
 * the general case, names the misunderstanding, so where the shape is seen each hint names the idiom and the
 * edit instead (#497). Everywhere else the two keep the hint they had.
 */
import { describe, expect, it } from 'vitest';
import { sabotageHinting, sabotagePointing } from './example-harness.js';

const GRAPH = 'features/customers/data/keep-customer.graph.json';
const STORE = '@storage/store.port.json';
const STORE_DOC = '@customers/data/customers.store.json';
const CUSTOMER = '@customers/domain/Customer.shape.json';
/**
 * What the toggle reads of the customer: its key. keep-customer takes the whole record, and a toggle that writes
 * one field of it leaves the rest unread, which is G008's and not the claim here; the field is one no invariant
 * reads, since patching one an invariant reads is I007's.
 */
const TAKES = '@customers/domain/CustomerRef.shape.json';

const run = (id: string, op: string, input: Record<string, unknown>) => ({
  type: '@wilanis/node/run.schema.json',
  id,
  run: op,
  in: input,
});
const decide = (id: string, rules: { when: string; to: string }[], otherwise: string) => ({
  type: '@wilanis/node/switch.schema.json',
  id,
  in: { record: '{{get.record}}' },
  rules,
  else: otherwise,
});
const get = run('get', `${STORE}#get`, { store: STORE_DOC, collection: 'customers', key: '{{in.id}}' });
/** One write of the toggle: the flag this write sets, and nothing an invariant reads. */
const patch = (id: string, active: boolean) =>
  run(id, `${STORE}#patch`, {
    store: STORE_DOC,
    collection: 'customers',
    key: '{{in.id}}',
    changes: { active },
  });
const make = (value: string) => run('customer', '@std/object.port.json#make', { value, type: CUSTOMER });
const missing = run('noCustomer', '@std/outcome.port.json#refuse', {
  reason: 'missing',
  message: 'no customer {{in.id}}',
  type: CUSTOMER,
});

/** keep-customer rewritten as the toggle from the issue: both writes beside the switch, their answers ORed. */
const toggle = (graph: any) => {
  graph.in = TAKES;
  graph.out.from = ['customer', 'noCustomer'];
  graph.nodes = [
    get,
    decide('check', [{ when: 'has(record)', to: 'customer' }], 'noCustomer'),
    patch('pin', true),
    patch('unpin', false),
    make('{{pin.record || unpin.record}}'),
    missing,
  ];
};

const G008_OLD = 'G008 wire its result into another node, or name it in out.from';
const G004_OLD = (name: string, what: string) => `G004 make what '${name}' reads and what '${what}' takes one type`;

describe('sabotage: a graph written as control flow', () => {
  it('refuses the toggle at each write and at the join, and nowhere else', () => {
    expect(sabotagePointing(GRAPH, toggle)).toEqual([
      `G004 @${GRAPH}#nodes/customer/in/value`,
      `G008 @${GRAPH}#nodes/pin`,
      `G008 @${GRAPH}#nodes/unpin`,
    ]);
  });

  it('G008 names the idiom at an effect no switch routes: it runs on every branch', () => {
    const hints = sabotageHinting(GRAPH, toggle);
    for (const id of ['pin', 'unpin'])
      expect(hints).toContain(
        `G008 nothing routes to '${id}', so it runs on every branch: make it the 'to' of a switch rule, or read its answer from every branch`,
      );
  });

  it('G004 names the idiom at two answers joined with ||: branches converge at out.from', () => {
    expect(sabotageHinting(GRAPH, toggle)).toContain(
      "G004 two nodes' answers are joined at out.from, one per branch, never with ||: give each branch its own node and list both under out.from",
    );
  });

  it('G008 keeps its hint at a pure node nothing reads, since nothing ran that should not have', () => {
    // a made value nobody reads sits beside the switch too, but it has no effect to misplace
    const spare = run('spare', '@std/object.port.json#make', {
      value: { id: '{{in.id}}' },
      type: '@customers/domain/CustomerRef.shape.json',
    });
    expect(sabotageHinting(GRAPH, graph => graph.nodes.push(spare))).toEqual([G008_OLD]);
  });

  it('G008 keeps its hint at an effect a switch routes and nothing reads: it already runs on one branch', () => {
    const hints = sabotageHinting(GRAPH, graph => {
      graph.in = TAKES;
      graph.nodes = [
        get,
        decide('check', [{ when: 'has(record)', to: 'pin' }], 'noCustomer'),
        patch('pin', true),
        missing,
      ];
      graph.out.from = ['noCustomer'];
    });
    expect(hints).toEqual([G008_OLD]);
  });

  it('G004 keeps its hint where one read of the wrong type feeds the input', () => {
    // the example's own record as kept, handed the id where it made the record
    const hints = sabotageHinting(GRAPH, graph => {
      graph.nodes[2].in.value = '{{in.id}}';
    });
    expect(hints).toEqual([G004_OLD('value', '@std/object.port.json#make')]);
  });
});
