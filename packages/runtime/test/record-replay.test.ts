/**
 * A recorded scenario replays the same where a refusal ends its run while other nodes still run (#908). The engine
 * cancels only what had not started, and an effect a stub answers settles sooner than one a handler answers, so the
 * run that recorded the stubs and `regress` replaying them could cancel different nodes. Every recorder reads its
 * expectation off the replay, fired as `regress` fires it, and writes nothing of a run whose replay another node
 * ended first (#935).
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadTree } from '@wilanis/core';
import type { Report } from '@wilanis/engine';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EDGES, embedderFor, fuzz, RECORDED, regress, rehearse } from '../src/index.js';
import { recordedProfile } from '../src/profile.js';
import { endedOtherwise } from '../src/replay.js';
import { copyOfExample, INCLUDES, PLUGINS } from './example-harness.js';

const GET_ROW = 'features/customers/data/get-row.graph.json';
const NO_CUSTOMER = 'scenarios/rehearsed/customers.get-customer/customers.get-row.outcome.noCustomer.scenario.json';
const load = (dir: string) => loadTree(dir, PLUGINS, INCLUDES);
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

/**
 * A GET to the customers API, typed as its row: an effect no switch reads, so the rehearsal never stubs it. `site`
 * is what the node carries beside its call, a `timeoutMs` say.
 */
const fetchOf = (id: string, path: string, site: Record<string, unknown> = {}) => ({
  type: '@wilanis/node/run.schema.json',
  id,
  label: id,
  run: '@http/http.port.json#request',
  ...site,
  in: {
    connection: '@connections/customers-api.connection.json',
    method: 'GET',
    path,
    produces: 'application/json',
    returns: '@customers/edge/CustomerRow.shape.json',
  },
});

/**
 * The example with `get-row` reading the row twice more, one read after the other, beside the switch that refuses:
 * `sideFact` waits for the second read, and the row the graph answers waits for `sideFact`. When `outcome` refuses,
 * `sideFact` has not started where the reads were answered by handlers, and has where stubs answered them.
 */
function racing(): string {
  const dir = copyOfExample();
  const doc = read(join(dir, GET_ROW));
  const fact = {
    type: '@wilanis/node/run.schema.json',
    id: 'sideFact',
    label: 'The id, once both reads answered',
    run: '@std/text.port.json#fill',
    in: { template: '{id}', values: { id: '{{in.id}}', again: '{{sideTwo.status}}' } },
  };
  doc.nodes.splice(1, 0, fetchOf('side', '/customer/{{in.id}}'), fetchOf('sideTwo', '/customer/{{side.status}}'), fact);
  const customer = doc.nodes.find((node: { id: string }) => node.id === 'customer');
  customer.run = '@std/object.port.json#merge';
  customer.in = {
    base: '{{fetched.body}}',
    over: { id: '{{sideFact}}' },
    type: '@customers/domain/Customer.shape.json',
  };
  writeFileSync(join(dir, GET_ROW), JSON.stringify(doc, null, 2));
  return dir;
}

describe('a refusal that ends a run while other nodes still run', () => {
  let dir: string;
  beforeAll(() => {
    dir = racing();
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('ends with other nodes cancelled when handlers answer than when stubs do: the race the recorders meet', async () => {
    const loaded = load(dir);
    const trigger = loaded.registry.all('trigger').find(one => one.name === 'get-customer');
    const profile = recordedProfile(loaded.registry.project?.doc);
    const missing = { 'op.fetched': { status: 404, headers: {} } };
    const fire = (stubs: Record<string, unknown>) =>
      embedderFor(loaded, { seed: 1, profile }).fire(
        trigger?.doc as never,
        { id: 'c1' },
        { params: { id: 'c1' } },
        {
          stubs,
        },
      );
    const generated = await fire(missing);
    const stubbed = await fire({ ...missing, 'op.side': { status: 200 }, 'op.sideTwo': { status: 200 } });
    expect(generated.nodes.op.sub?.nodes.sideFact.status).toBe('cancelled');
    expect(stubbed.nodes.op.sub?.nodes.sideFact.status).toBe('done');
  });

  it('is recorded by rehearse --record as regress replays it', async () => {
    await rehearse(load(dir), { record: RECORDED });
    const answers = read(join(dir, RECORDED, 'answers.json'));
    const recorded = read(join(dir, NO_CUSTOMER));
    expect(answers.nodes[recorded.expect.nodes['op.sideFact']].status).toBe('done');
    const replayed = await regress(load(dir));
    expect(replayed.lines.filter(line => !line.endsWith(': same'))).toEqual([]);
    expect((await rehearse(load(dir), { check: true })).recorded?.check?.stale).toEqual([]);
  });

  it('is recorded by fuzz --edges and by fuzz as regress replays it', async () => {
    await fuzz(load(dir), { edges: true });
    await fuzz(load(dir), { runs: 5 });
    const replayed = await regress(load(dir));
    expect(replayed.results.some(one => one.scenario.includes('/edges/customers.update-customer/'))).toBe(true);
    expect(replayed.lines.filter(line => !line.endsWith(': same'))).toEqual([]);
  });
});

/**
 * The example with `get-row` reading the row once more, under a timeout, and refusing as `raced` as soon as it
 * answered, beside the switch that refuses; the row itself is read with no timeout and no retry. The order is the
 * kernel's, step by step, never the clock's. Where the seed answers `side` through its handler, its timeout adds
 * steps, `side` answers after the row, and the switch's refusal ends the run first. A recorded stub answers in place
 * of the handler and of its timeout, so where the stubs answer both reads, `sideFact` refuses one step after its read
 * and the switch two steps after its own: the replay ends at the sibling first.
 */
function refusingSibling(): string {
  const dir = copyOfExample();
  const doc = read(join(dir, GET_ROW));
  const [fetched] = doc.nodes;
  delete fetched.timeoutMs;
  delete fetched.retry;
  const raced = {
    type: '@wilanis/node/run.schema.json',
    id: 'sideFact',
    label: 'Refuse once the second read answered',
    run: '@std/outcome.port.json#refuse',
    in: { reason: 'raced', message: 'raced {{side.status}}', type: '@customers/domain/Customer.shape.json' },
  };
  doc.nodes.splice(1, 0, fetchOf('side', '/customer/{{in.id}}', { timeoutMs: 5000 }), raced);
  writeFileSync(join(dir, GET_ROW), JSON.stringify(doc, null, 2));
  return dir;
}

/** What every refused line says after the run's endings: why, and what to do. */
const WHY = 'Which node ends the run depends on which settles first';

describe('a sibling that ends the run first only in the replay', () => {
  let dir: string;
  beforeAll(() => {
    dir = refusingSibling();
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('is not recorded by rehearse --record, which names the branch, both endings and what to do', async () => {
    const answer = await rehearse(load(dir), { record: RECORDED });
    const branch = "get-customer: get-row 'outcome' when status == 404 routes to noCustomer";
    const line = answer.lines.find(one => one.startsWith(branch));
    expect(line).toBe(
      `${branch}: NOT RECORDED: the run that chose the stubs refuses as missing at 'op.noCustomer', and the replay ` +
        `of those stubs refuses as raced at 'op.sideFact'. ${WHY}: make one of the two run only after the other is ` +
        'decided, or make it stop refusing or breaking, then run wilanis rehearse --record again',
    );
    expect(answer.ok).toBe(false);
    expect(existsSync(join(dir, NO_CUSTOMER))).toBe(false);
    const replayed = await regress(load(dir));
    expect(replayed.lines.filter(one => one.includes('/rehearsed/') && !one.endsWith(': same'))).toEqual([]);
  });

  it('is not recorded by fuzz --edges, which names the trigger and the edge', async () => {
    const answer = await fuzz(load(dir), { edges: true });
    const run = '@features/customers/edge/update-customer.trigger.json with id empty';
    expect(answer.lines.find(one => one.startsWith(run))).toBe(
      `${run}: NOT RECORDED: the run that chose the stubs refuses as upstream at 'op.current.op.upstreamFailed', ` +
        "and the replay of those stubs refuses as raced at 'op.current.op.sideFact'. " +
        `${WHY}: make one of the two run only after the other is decided, or make it stop refusing or breaking, ` +
        'then run wilanis fuzz --edges again',
    );
    expect(answer.ok).toBe(false);
    expect(existsSync(join(dir, EDGES, 'customers.update-customer/id.empty.scenario.json'))).toBe(false);
  });

  it('is not recorded by fuzz, which names the trigger and the seed', async () => {
    const answer = await fuzz(load(dir), { runs: 2 });
    const run = '@features/customers/edge/get-customer.trigger.json under seed 2';
    expect(answer.lines.find(one => one.startsWith(run))).toBe(
      `${run}: NOT RECORDED: the run that chose the stubs refuses as upstream at 'op.upstreamFailed', and the ` +
        `replay of those stubs refuses as raced at 'op.sideFact'. ${WHY}: make one of the two run only after the ` +
        'other is decided, or make it stop refusing or breaking, then run wilanis fuzz again',
    );
    expect(answer.ok).toBe(false);
    expect(answer.written.filter(file => file.endsWith('/get-customer.2.scenario.json'))).toEqual([]);
  });

  // three clocks, each recording the whole example three ways: longer than one rehearsal is given
  it('says the same whatever the clock reads: every reading one tick, or every reading a tick on', {
    timeout: 20_000,
  }, async () => {
    const said = async () => {
      const rehearsed = await rehearse(load(dir), { record: RECORDED });
      const edged = await fuzz(load(dir), { edges: true });
      const fuzzed = await fuzz(load(dir), { runs: 2 });
      return [...rehearsed.lines, ...edged.lines, ...fuzzed.lines].filter(line => line.includes('NOT RECORDED'));
    };
    const real = await said();
    let tick = 0;
    for (const clock of [() => 1000, () => ++tick]) {
      const frozen = vi.spyOn(Date, 'now').mockImplementation(clock);
      try {
        expect(await said()).toEqual(real);
      } finally {
        frozen.mockRestore();
      }
    }
    expect(real.length).toBeGreaterThan(0);
  });
});

/** A node of a report that failed: refused where it gives a reason, broke where it gives none. */
const failed = (fields: { reason?: string; error: string; sub?: unknown }) => ({
  status: 'failed',
  startedAt: 0,
  endedAt: 1,
  ...fields,
});

/** A run of get-customer that failed at one node of get-row, reached through the call `op`, as the engine reports it. */
function failedAt(node: string, fields: { reason?: string; error: string }): Report {
  const sub = { graph: GET_ROW, status: 'failed', startedAt: 0, endedAt: 1, nodes: { [node]: failed(fields) } };
  const op = failed({ ...fields, sub });
  return { graph: 'get-customer', status: 'failed', startedAt: 0, endedAt: 1, nodes: { op } } as unknown as Report;
}

/**
 * A sibling can break rather than refuse. Where both happen, the engine says the run refused (`outcomeOf`), so a
 * replay that breaks is one where the sibling broke before the switch's branch ran: reports made by hand say it.
 */
describe('a sibling that breaks first only in the replay', () => {
  const missing = failedAt('noCustomer', { reason: 'missing', error: 'no customer c1' });

  it('is not recorded: the line says where the replay broke and what it threw', () => {
    const broke = failedAt('sideFact', { error: 'message: expected a string' });
    expect(endedOtherwise(missing, broke, 'wilanis rehearse --record')).toBe(
      "NOT RECORDED: the run that chose the stubs refuses as missing at 'op.noCustomer', and the replay of those " +
        "stubs breaks at 'op.sideFact': message: expected a string. " +
        `${WHY}: make one of the two run only after the other is decided, or make it stop refusing or breaking, ` +
        'then run wilanis rehearse --record again',
    );
  });

  it('is recorded where both runs broke at one node, whatever each threw: the node names the fault', () => {
    const once = failedAt('sideFact', { error: 'message: expected a string' });
    const again = failedAt('sideFact', { error: 'message: expected text' });
    expect(endedOtherwise(once, again, 'wilanis rehearse --record')).toBeUndefined();
    expect(endedOtherwise(missing, failedAt('noCustomer', { reason: 'missing', error: 'no customer c2' }), 'x')).toBe(
      undefined,
    );
  });
});
