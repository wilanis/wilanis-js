/**
 * A recorded scenario replays the same where a refusal ends its run while other nodes still run (#908). The engine
 * cancels only what had not started, and an effect a stub answers settles sooner than one a handler answers, so the
 * run that recorded the stubs and `regress` replaying them could cancel different nodes. Every recorder reads its
 * expectation off the replay, fired as `regress` fires it.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadTree } from '@wilanis/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { embedderFor, fuzz, RECORDED, regress, rehearse } from '../src/index.js';
import { recordedProfile } from '../src/profile.js';
import { copyOfExample, INCLUDES, PLUGINS } from './example-harness.js';

const GET_ROW = 'features/customers/data/get-row.graph.json';
const NO_CUSTOMER = 'scenarios/rehearsed/customers.get-customer/customers.get-row.outcome.noCustomer.scenario.json';
const load = (dir: string) => loadTree(dir, PLUGINS, INCLUDES);
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

/** A GET to the customers API, typed as its row: an effect no switch reads, so the rehearsal never stubs it. */
const fetchOf = (id: string, path: string) => ({
  type: '@wilanis/node/run.schema.json',
  id,
  label: id,
  run: '@http/http.port.json#request',
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
