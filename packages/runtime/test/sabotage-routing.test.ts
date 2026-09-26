/**
 * Sabotage: an effect no switch routes runs on every branch. A node runs when what it reads is ready, whatever a
 * switch chose; the switch decides who answers, not who runs. So a write beside a switch, read only under one
 * of its branches, runs on the others for nothing, and G015 refuses it where it sits (#491). The same write
 * routed under the branch that reads it is what the author meant, and checks clean; one every branch reads,
 * or that out.from names, ran for a reason on every run; and one nothing reads at all is G008's alone.
 */
import { describe, expect, it } from 'vitest';
import { sabotage, sabotageHinting, sabotagePointing, sabotageSaying } from './example-harness.js';

const GRAPH = 'features/customers/data/keep-customer.graph.json';
const STORE = '@storage/store.port.json';
const CUSTOMERS = '@customers/data/customers.store.json';
const CUSTOMER = '@customers/domain/Customer.shape.json';
/**
 * What the toggles read of the customer: its key. keep-customer takes the whole record, and a toggle that writes
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
const decide = (
  id: string,
  input: Record<string, string>,
  rules: { when: string; to: string }[],
  otherwise: string,
) => ({
  type: '@wilanis/node/switch.schema.json',
  id,
  in: input,
  rules,
  else: otherwise,
});
const get = run('get', `${STORE}#get`, { store: CUSTOMERS, collection: 'customers', key: '{{in.id}}' });
/** One write of the toggle: the flag this write sets, and nothing an invariant reads. */
const patch = (id: string, active: boolean) =>
  run(id, `${STORE}#patch`, {
    store: CUSTOMERS,
    collection: 'customers',
    key: '{{in.id}}',
    changes: { active },
  });
const make = (id: string, value: string) => run(id, '@std/object.port.json#make', { value, type: CUSTOMER });
const refuse = (id: string) =>
  run(id, '@std/outcome.port.json#refuse', { reason: 'missing', message: `no customer {{in.id}}`, type: CUSTOMER });
/** Is the write's record there? The check each branch makes of its own patch. */
const checkOf = (id: string, write: string, row: string, gone: string) =>
  decide(id, { record: `{{${write}.record}}` }, [{ when: 'has(record)', to: row }], gone);

/** What both spellings of the toggle share: read, decide on presence, decide on the flag, check each write. */
const shared = (active: string, inactive: string) => ({
  before: [
    get,
    decide('check', { record: '{{get.record}}' }, [{ when: 'has(record)', to: 'decide' }], 'missing'),
    decide('decide', { active: '{{get.record.active}}' }, [{ when: 'has(active) && active', to: inactive }], active),
  ],
  after: [
    checkOf('checkActivate', 'activate', 'rowActive', 'missingAfterActivate'),
    checkOf('checkDeactivate', 'deactivate', 'rowInactive', 'missingAfterDeactivate'),
    make('rowActive', '{{activate.record}}'),
    make('rowInactive', '{{deactivate.record}}'),
    refuse('missing'),
    refuse('missingAfterActivate'),
    refuse('missingAfterDeactivate'),
  ],
  from: ['rowActive', 'rowInactive', 'missing', 'missingAfterActivate', 'missingAfterDeactivate'],
});

/** The issue's toggle: the flag switch routes to each branch's check, and both writes sit beside it. */
const toggle = (graph: any) => {
  const { before, after, from } = shared('checkActivate', 'checkDeactivate');
  graph.in = TAKES;
  graph.nodes = [...before, patch('activate', true), patch('deactivate', false), ...after];
  graph.out.from = from;
};

/** The same toggle as the other agents wrote it: the flag switch routes to the write, and the check reads it. */
const routedToggle = (graph: any) => {
  const { before, after, from } = shared('activate', 'deactivate');
  graph.in = TAKES;
  graph.nodes = [...before, patch('activate', true), patch('deactivate', false), ...after];
  graph.out.from = from;
};

/** One write beside the presence switch, checked under both of its branches: read on every run. */
const checkedEverywhere = (graph: any) => {
  graph.in = TAKES;
  graph.nodes = [
    get,
    decide('check', { record: '{{get.record}}' }, [{ when: 'has(record)', to: 'wasThere' }], 'wasNot'),
    patch('stamp', true),
    checkOf('wasThere', 'stamp', 'row', 'missingAfterStamp'),
    checkOf('wasNot', 'stamp', 'rowAnyway', 'missing'),
    make('row', '{{stamp.record}}'),
    make('rowAnyway', '{{stamp.record}}'),
    refuse('missing'),
    refuse('missingAfterStamp'),
  ];
  graph.out.from = ['row', 'rowAnyway', 'missing', 'missingAfterStamp'];
};

const HINT = (id: string, reader: string) =>
  `G015 route the effect under the branch that reads it: make '${id}' the 'to' of the switch rule that leads to '${reader}', or read its answer from every branch`;

describe('sabotage: an effect no switch routes, read under one branch', () => {
  it('G015 refuses each write of the toggle, and nothing else', () => {
    expect(sabotage(GRAPH, toggle)).toEqual(['G015', 'G015']);
  });

  it('G015 points at each write where it sits', () => {
    expect(sabotagePointing(GRAPH, toggle)).toEqual([
      `G015 @${GRAPH}#nodes/activate`,
      `G015 @${GRAPH}#nodes/deactivate`,
    ]);
  });

  it('G015 says the write runs on every branch and names where its answer enters one', () => {
    // rowActive reads activate too, but sits behind checkActivate: the check is where the answer enters the branch
    expect(sabotageSaying(GRAPH, toggle)).toEqual([
      "G015 effect 'activate' runs on every branch, but its answer is read only under 'checkActivate'",
      "G015 effect 'deactivate' runs on every branch, but its answer is read only under 'checkDeactivate'",
    ]);
  });

  it('G015 hints the edit: make the write the to of the rule that leads to its reader', () => {
    expect(sabotageHinting(GRAPH, toggle)).toEqual([
      HINT('activate', 'checkActivate'),
      HINT('deactivate', 'checkDeactivate'),
    ]);
  });

  it('is silent once each write is the to of the rule whose branch reads it', () => {
    expect(sabotage(GRAPH, routedToggle)).toEqual([]);
  });

  it('is silent where every branch of the switch reads the write', () => {
    expect(sabotage(GRAPH, checkedEverywhere)).toEqual([]);
  });

  it('is silent on the example, whose every effect an unrouted switch or out.from reads', () => {
    expect(sabotage(GRAPH, () => undefined)).toEqual([]);
  });

  it('leaves an effect nothing reads to G008', () => {
    expect(sabotage(GRAPH, graph => graph.nodes.push(patch('spare', true)))).toEqual(['G008']);
  });
});
