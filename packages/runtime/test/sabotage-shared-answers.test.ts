/**
 * A scenario's pointers into its directory's answers document (RFC 0036): a scenario written by hand holds its answers
 * and stubs itself (S006), every pointer of a recorded one resolves in the answers document `answersFor` finds for it
 * (S007), and a shared answer pins a reason only where it refused, judged once in that document (S002). Nothing writes
 * a pointer yet, so each case plants a recorded scenario of `get-row`'s `noCustomer` branch and the `answers.json`
 * beside it in a copy of the example, which keeps none of its own scenarios.
 */
import { answerDigest, schemaUrl } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { plantedEditingAllHinting, plantedEditingAllSaying, plantedPointing } from './example-harness.js';

const DIR = 'scenarios/rehearsed';
const FILE = `${DIR}/customers.get-customer/customers.get-row.outcome.noCustomer.scenario.json`;
const ANSWERS = `${DIR}/answers.json`;
const MINE = 'scenarios/customers.get-row.outcome.noCustomer.scenario.json';

const ROUTED = { status: 'done', selected: 'noCustomer', out: 'noCustomer' };
const REFUSED = { status: 'failed', handler: '@std/outcome.port.json#refuse', reason: 'missing' };
const CANCELLED = { status: 'cancelled' };
const FETCHED = { status: 404, headers: {}, body: { id: 'india' } };
const [routed, refused, cancelled, fetched] = [ROUTED, REFUSED, CANCELLED, FETCHED].map(answerDigest);

/** The answers document of a directory, holding every value the recorded scenario points at, as `--record` will. */
const answers = (generated = 'rehearse', nodes: Record<string, unknown> = {}, stubs: Record<string, unknown> = {}) => ({
  $schema: schemaUrl('answers'),
  description: 'The values the scenarios of this directory share, planted.',
  generated,
  nodes: { [routed]: ROUTED, [refused]: REFUSED, [cancelled]: CANCELLED, ...nodes },
  stubs: { [fetched]: FETCHED, ...stubs },
});

/** The recorded scenario, every node and its one stub a digest, with what a case adds or breaks. */
const recorded = (extra: Record<string, unknown> = {}) => ({
  $schema: schemaUrl('scenario'),
  description: 'A recorded run of the noCustomer branch, planted with its pointers.',
  generated: 'rehearse',
  trigger: '@features/customers/edge/get-customer.trigger.json',
  branch: {
    graph: '@features/customers/data/get-row.graph.json',
    node: 'outcome',
    when: 'status == 404',
    to: 'noCustomer',
  },
  seed: 1,
  in: { id: 'hotel403' },
  sharedStubs: { 'op.fetched': fetched },
  expect: {
    status: 'failed',
    reason: 'missing',
    nodes: { 'op.outcome': routed, 'op.noCustomer': refused, 'op.customer': cancelled },
  },
  ...extra,
});

/** The recorded scenario copied by hand: no `generated`, its pointers kept unless the case writes them inline. */
const byHand = (extra: Record<string, unknown> = {}) => {
  const { generated: _, ...rest } = recorded(extra);
  return rest;
};

/** The nodes of the recorded scenario, each written inline. */
const INLINE = { 'op.outcome': ROUTED, 'op.noCustomer': REFUSED, 'op.customer': CANCELLED };
/** The refusals of one code a case expects, each as `code file#at`. */
const at = (file: string, code: string, ...where: string[]) => where.map(one => `${code} @${file}#${one}`);

describe('S006: a scenario written by hand holds its answers and stubs itself', () => {
  it('refuses a recorded scenario copied by hand with its digests kept, at each node and at sharedStubs', () => {
    const refusals = plantedPointing({ [ANSWERS]: answers(), [MINE]: byHand() });
    expect(refusals.sort()).toEqual(
      at(
        MINE,
        'S006',
        'expect/nodes/op.customer',
        'expect/nodes/op.noCustomer',
        'expect/nodes/op.outcome',
        'sharedStubs',
      ),
    );
  });

  it('refuses one that keeps only sharedStubs, its answers inline', () => {
    const doc = byHand({ expect: { status: 'failed', reason: 'missing', nodes: INLINE } });
    expect(plantedPointing({ [ANSWERS]: answers(), [MINE]: doc })).toEqual(at(MINE, 'S006', 'sharedStubs'));
  });

  it('says which answer it points at, and that the edit is to write that answer in its place', () => {
    const doc = byHand({ sharedStubs: undefined, stubs: { 'op.fetched': FETCHED } });
    const placed = { [ANSWERS]: answers(), [MINE]: doc };
    expect(plantedEditingAllSaying(placed, {})).toContain(
      `S006 node 'op.outcome' points at the shared answer ${routed}, and a scenario written by hand holds its answers itself: no command keeps an answers file for it`,
    );
    expect(plantedEditingAllHinting(placed, {})).toContain(
      `S006 write the answer answers.json holds under nodes/${routed} in place of the digest`,
    );
  });

  it('refuses it inside a recorded directory too, though every digest resolves there, and S007 says nothing', () => {
    const doc = byHand({ expect: { status: 'failed', reason: 'missing', nodes: INLINE } });
    expect(plantedPointing({ [ANSWERS]: answers(), [FILE]: doc })).toEqual(at(FILE, 'S006', 'sharedStubs'));
  });
});

describe('S007: every pointer of a recorded scenario resolves in its answers document', () => {
  it('refuses a node digest the answers document does not hold, at the node, naming the file', () => {
    const lacking = answers();
    delete (lacking.nodes as Record<string, unknown>)[routed];
    const placed = { [ANSWERS]: lacking, [FILE]: recorded() };
    expect(plantedPointing(placed)).toEqual(at(FILE, 'S007', 'expect/nodes/op.outcome'));
    expect(plantedEditingAllSaying(placed, {})).toEqual([
      `S007 node 'op.outcome' points at ${routed}, which @${ANSWERS} does not hold under nodes`,
    ]);
  });

  it('refuses a stub digest held under nodes but not under stubs, at the stub', () => {
    const misplaced = answers('rehearse', { [fetched]: CANCELLED });
    delete (misplaced.stubs as Record<string, unknown>)[fetched];
    expect(plantedPointing({ [ANSWERS]: misplaced, [FILE]: recorded() })).toEqual(
      at(FILE, 'S007', 'sharedStubs/op.fetched'),
    );
  });

  it('refuses a recorded scenario moved under a second recorded directory whose answers lack its digests', () => {
    const other = 'scenarios/other/customers.get-customer/moved.scenario.json';
    const empty = { ...answers(), nodes: {}, stubs: {} };
    const placed = { [ANSWERS]: answers(), 'scenarios/other/answers.json': empty, [other]: recorded() };
    expect(plantedPointing(placed).sort()).toEqual(
      at(
        other,
        'S007',
        'expect/nodes/op.customer',
        'expect/nodes/op.noCustomer',
        'expect/nodes/op.outcome',
        'sharedStubs/op.fetched',
      ),
    );
  });

  it('refuses every pointer of a recorded scenario with no answers.json above it', () => {
    const said = plantedEditingAllSaying({ [FILE]: recorded() }, {});
    expect(said).toHaveLength(4);
    expect(said).toContain(`S007 stub 'op.fetched' points at ${fetched}, and no answers.json is above this scenario`);
  });

  it('refuses every pointer into an answers document another command wrote', () => {
    const said = plantedEditingAllSaying({ [ANSWERS]: answers('edges'), [FILE]: recorded() }, {});
    expect(said).toHaveLength(4);
    expect(said).toContain(
      `S007 node 'op.outcome' points at ${routed}, and @${ANSWERS} above it is marked 'edges' where this scenario is 'rehearse'`,
    );
  });

  it('refuses a path both under stubs and under sharedStubs, at sharedStubs', () => {
    const both = recorded({ stubs: { 'op.fetched': FETCHED } });
    expect(plantedPointing({ [ANSWERS]: answers(), [FILE]: both })).toEqual(at(FILE, 'S007', 'sharedStubs/op.fetched'));
    expect(plantedEditingAllHinting({ [ANSWERS]: answers(), [FILE]: both }, {})).toEqual([
      'S007 wilanis rehearse --record (or wilanis fuzz --edges) writes the scenarios and their answers file together: run it and review the diff',
    ]);
  });

  it('leaves a cancelAt at a shared stub that does not resolve to S007 alone', () => {
    const lacking = { ...answers(), stubs: {} };
    const doc = recorded({ cancelAt: 'op.fetched' });
    expect(plantedPointing({ [ANSWERS]: lacking, [FILE]: doc })).toEqual(at(FILE, 'S007', 'sharedStubs/op.fetched'));
  });
});

describe('S002: a shared answer is judged once, in its answers document', () => {
  it('refuses a shared answer with a reason that ended done, at nodes/<digest>/reason, and not in each scenario', () => {
    const pinned = { status: 'done', selected: 'noCustomer', out: 'noCustomer', reason: 'missing' };
    const digest = answerDigest(pinned);
    const pointing = (extra = {}) =>
      recorded({ expect: { status: 'failed', nodes: { 'op.outcome': digest }, ...extra } });
    const placed = {
      [ANSWERS]: answers('rehearse', { [digest]: pinned }),
      [FILE]: pointing(),
      [`${DIR}/customers.get-customer/again.scenario.json`]: pointing({ reason: 'missing' }),
    };
    expect(plantedPointing(placed)).toEqual([`S002 @${ANSWERS}#nodes/${digest}/reason`]);
    expect(plantedEditingAllSaying(placed, {})).toEqual([
      `S002 shared answer '${digest}' pins reason 'missing' but ended 'done': only a node that refused gives a reason`,
    ]);
  });

  it('refuses an inline answer of a recorded scenario at expect/nodes, as before', () => {
    const doc = recorded({ expect: { status: 'failed', nodes: { op: { status: 'done', reason: 'missing' } } } });
    expect(plantedPointing({ [ANSWERS]: answers(), [FILE]: doc })).toEqual(at(FILE, 'S002', 'expect/nodes/op/reason'));
  });
});

describe('a scenario that points where it may', () => {
  it('passes a recorded scenario whose every digest resolves, and one written by hand with everything inline', () => {
    const inline = byHand({ sharedStubs: undefined, stubs: { 'op.fetched': FETCHED }, cancelAt: 'op.fetched' });
    const doc = { ...inline, expect: { status: 'failed', reason: 'missing', nodes: INLINE } };
    expect(
      plantedPointing({ [ANSWERS]: answers(), [FILE]: recorded({ cancelAt: 'op.fetched' }), [MINE]: doc }),
    ).toEqual([]);
  });
});
