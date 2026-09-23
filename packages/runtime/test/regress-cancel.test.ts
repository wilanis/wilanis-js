import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import { loadTree } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { embedderFor, fuzz, regress } from '../src/index.js';
import { copyOfExample, INCLUDES, PLUGINS } from './example-harness.js';

const TRIGGER = '@features/customers/edge/get-customer.trigger.json';
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

/**
 * A copy of the example holding one scenario of GET /customers/{id}, recorded by fuzz and then pinned by hand to
 * cancel at the row's fetch: the one scenario, the rest of what fuzz wrote left out.
 */
async function pinnedAt(cancelAt: string, expect: (recorded: any) => unknown): Promise<string> {
  const dir = copyOfExample();
  const written = join(dir, 'fuzzed');
  await fuzz(loadTree(dir, PLUGINS, INCLUDES), { runs: 1, profile: 'live', out: 'fuzzed' });
  const recorded = read(join(written, 'get-customer.1.scenario.json'));
  rmSync(written, { recursive: true, force: true });
  mkdirSync(join(dir, 'scenarios'), { recursive: true });
  const pinned = { ...recorded, cancelAt, expect: expect(recorded) };
  writeFileSync(join(dir, 'scenarios', 'get-customer.cancelled.scenario.json'), JSON.stringify(pinned));
  return dir;
}

/** The run cancelled at the fetch: the fetch in flight when the signal fired, everything after it never started. */
const cancelledAtFetch = (recorded: any) => ({
  status: 'cancelled',
  nodes: {
    op: { status: 'failed', handler: recorded.expect.nodes.op.handler },
    'op.fetched': { status: 'failed', handler: '@http/http.port.json#request' },
    'op.outcome': { status: 'cancelled' },
    'op.customer': { status: 'cancelled' },
    'op.noCustomer': { status: 'cancelled' },
    'op.upstreamFailed': { status: 'cancelled' },
  },
});

describe('regress, a scenario that pins a cancellation', () => {
  it('replays as the same: the named effect aborts the run, and the rest of the graph never starts', async () => {
    const dir = await pinnedAt('op.fetched', cancelledAtFetch);
    // the pinned scenario is a document of the tree, and the tree still passes check with it
    expect(checkTree(loadTree(dir, PLUGINS, INCLUDES)).items).toEqual([]);
    const replayed = await regress(loadTree(dir, PLUGINS, INCLUDES), { profile: 'live' });
    expect(replayed.lines).toEqual(['@scenarios/get-customer.cancelled.scenario.json: same']);
    expect(replayed.ok).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('diffs against the uncancelled recording: cancelled is a status regress holds the tree to', async () => {
    let was = '';
    const dir = await pinnedAt('op.fetched', recorded => {
      was = recorded.expect.status;
      return recorded.expect;
    });
    const replayed = await regress(loadTree(dir, PLUGINS, INCLUDES), { profile: 'live' });
    expect(replayed.ok).toBe(false);
    expect(replayed.lines[0]).toContain(`status ${was} → cancelled`);
    expect(replayed.lines[0]).toContain('op.outcome: done → cancelled');
    rmSync(dir, { recursive: true, force: true });
  });

  it('names a node, never a duration: the stub at the path rejects as an aborted call and records nothing', async () => {
    const dir = copyOfExample();
    const load = loadTree(dir, PLUGINS, INCLUDES);
    const trigger = load.registry.all('trigger').find(one => one.path === load.resolve(TRIGGER));
    const control = new AbortController();
    const record: Record<string, unknown> = {};
    const emb = embedderFor(load, {
      seed: 1,
      record,
      profile: 'live',
      cancelAt: { path: 'op.fetched', abort: () => control.abort() },
    });
    const request = { params: { id: 'c1' } };
    const report = await emb.fire(trigger?.doc as never, { id: 'c1' }, request, { signal: control.signal });
    expect(control.signal.aborted).toBe(true);
    expect(report.status).toBe('cancelled');
    expect(report.output).toBeUndefined();
    expect(report.nodes.op.sub?.nodes.fetched).toMatchObject({ status: 'failed', error: 'cancelled at op.fetched' });
    expect(Object.keys(record)).not.toContain('op.fetched');
    rmSync(dir, { recursive: true, force: true });
  });
});
