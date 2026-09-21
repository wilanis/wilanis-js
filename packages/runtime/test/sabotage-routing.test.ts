/**
 * Sabotage: an effect no switch routes runs on every branch. A node runs when what it reads is ready, whatever a
 * switch chose; the switch decides who answers, not who runs. So a write beside a switch, read only under one
 * of its branches, runs on the others for nothing, and G015 refuses it where it sits (#491). The same write
 * routed under the branch that reads it is what the author meant, and checks clean; one every branch reads,
 * or that out.from names, ran for a reason on every run; and one nothing reads at all is G008's alone.
 */
import { describe, expect, it } from 'vitest';
import { sabotage, sabotageHinting, sabotagePointing, sabotageSaying } from './example-harness.js';

const GRAPH = 'features/monitor/data/kept-update.graph.json';
const STORE = '@storage/store.port.json';
const ENTRIES = '@monitor/data/entries.store.json';
const ENTRY = '@monitor/domain/Entry.shape.json';

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
const get = run('get', `${STORE}#get`, { store: ENTRIES, collection: 'entries', key: '{{in.id}}' });
/** One write of the toggle: the caller's fields, and the agent standing in for the flag the example has not. */
const patch = (id: string, agent: string) =>
  run(id, `${STORE}#patch`, {
    store: ENTRIES,
    collection: 'entries',
    key: '{{in.id}}',
    changes: { url: '{{in.url}}', method: '{{in.method}}', agent },
  });
const make = (id: string, value: string) => run(id, '@std/object.port.json#make', { value, type: ENTRY });
const refuse = (id: string) =>
  run(id, '@std/outcome.port.json#refuse', { reason: 'missing', message: `no entry {{in.id}}`, type: ENTRY });
/** Is the write's record there? The check each branch makes of its own patch. */
const checkOf = (id: string, write: string, row: string, gone: string) =>
  decide(id, { record: `{{${write}.record}}` }, [{ when: 'has(record)', to: row }], gone);

/** What both spellings of the toggle share: read, decide on presence, decide on the flag, check each write. */
const shared = (pinned: string, unpinned: string) => ({
  before: [
    get,
    decide('check', { record: '{{get.record}}' }, [{ when: 'has(record)', to: 'decide' }], 'missing'),
    decide(
      'decide',
      { agent: '{{get.record.agent}}' },
      [{ when: "has(agent) && agent == 'pinned'", to: unpinned }],
      pinned,
    ),
  ],
  after: [
    checkOf('checkPin', 'pin', 'rowPinned', 'missingAfterPin'),
    checkOf('checkUnpin', 'unpin', 'rowUnpinned', 'missingAfterUnpin'),
    make('rowPinned', '{{pin.record}}'),
    make('rowUnpinned', '{{unpin.record}}'),
    refuse('missing'),
    refuse('missingAfterPin'),
    refuse('missingAfterUnpin'),
  ],
  from: ['rowPinned', 'rowUnpinned', 'missing', 'missingAfterPin', 'missingAfterUnpin'],
});

/** The issue's toggle: the flag switch routes to each branch's check, and both writes sit beside it. */
const toggle = (graph: any) => {
  const { before, after, from } = shared('checkPin', 'checkUnpin');
  graph.nodes = [...before, patch('pin', 'pinned'), patch('unpin', 'unpinned'), ...after];
  graph.out.from = from;
};

/** The same toggle as the other agents wrote it: the flag switch routes to the write, and the check reads it. */
const routedToggle = (graph: any) => {
  const { before, after, from } = shared('pin', 'unpin');
  graph.nodes = [...before, patch('pin', 'pinned'), patch('unpin', 'unpinned'), ...after];
  graph.out.from = from;
};

/** One write beside the presence switch, checked under both of its branches: read on every run. */
const checkedEverywhere = (graph: any) => {
  graph.nodes = [
    get,
    decide('check', { record: '{{get.record}}' }, [{ when: 'has(record)', to: 'wasThere' }], 'wasNot'),
    patch('stamp', 'seen'),
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
    expect(sabotagePointing(GRAPH, toggle)).toEqual([`G015 @${GRAPH}#nodes/pin`, `G015 @${GRAPH}#nodes/unpin`]);
  });

  it('G015 says the write runs on every branch and names where its answer enters one', () => {
    // rowPinned reads pin too, but sits behind checkPin: the check is where the answer enters the branch
    expect(sabotageSaying(GRAPH, toggle)).toEqual([
      "G015 effect 'pin' runs on every branch, but its answer is read only under 'checkPin'",
      "G015 effect 'unpin' runs on every branch, but its answer is read only under 'checkUnpin'",
    ]);
  });

  it('G015 hints the edit: make the write the to of the rule that leads to its reader', () => {
    expect(sabotageHinting(GRAPH, toggle)).toEqual([HINT('pin', 'checkPin'), HINT('unpin', 'checkUnpin')]);
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
    expect(sabotage(GRAPH, graph => graph.nodes.push(patch('spare', 'spare')))).toEqual(['G008']);
  });
});
