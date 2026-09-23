/**
 * The signal a kind hands reaches the run (RFC 0012, step 4): `Serving.fire` passes it to the embedder, the run
 * observes it, and a nested run it cancelled fails its calling node with `<graph>: cancelled`. The example's
 * one effect under get-customer is its GET of the row; a case stands in for it with a handler that aborts.
 */
import { loadTree, Scope } from '@wilanis/core';
import type { Handler, Report } from '@wilanis/engine';
import { beforeAll, describe, expect, it } from 'vitest';
import { Embedder, Served } from '../src/index.js';
import { EXAMPLE, INCLUDES, PLUGINS } from './example-harness.js';

const GET_ROW = '@features/customers/data/get-row.graph.json';

beforeAll(() => {
  // the @auth settings read the signing secret from the environment, so it is set before the tree is loaded
  process.env.CUSTOMERS_JWT_SECRET ??= 'a-secret-of-thirty-two-bytes-or-more!';
});

/** What a listener would read as `env.serving`, over the example whose every effect is `effect`. */
function servingWith(effect: Handler) {
  const load = loadTree(EXAMPLE, PLUGINS, INCLUDES);
  const scope = new Scope(load.registry, load.resolve);
  const emb = new Embedder(scope, load.plugins, { profile: 'live', stubEffects: () => effect, root: load.root });
  return new Served({ load, emb }, () => {}).serving();
}

/** Fire GET /customers/{id} through `serving`, as the http kind would, handing `signal`. */
function getCustomer(serving: ReturnType<typeof servingWith>, signal: AbortSignal): Promise<Report> {
  const trigger = serving.triggers('@http/http.trigger-kind.json').find(one => one.label === 'GET /customers/{id}');
  if (!trigger) throw new Error('the example has no GET /customers/{id}');
  const request = { params: { id: 'c1' }, headers: {}, cookies: {} };
  return serving.fire({ trigger, input: { id: 'c1' }, request, signal });
}

describe('the signal a kind hands to Serving.fire', () => {
  it('cancels a run whose signal aborted before it began: nothing is called', async () => {
    const called: string[] = [];
    const serving = servingWith(async ({ ctx }) => {
      called.push(ctx.nodePath.join('.'));
      return { status: 200 };
    });

    const report = await getCustomer(serving, AbortSignal.abort());

    expect(report.status).toBe('cancelled');
    expect(report.output).toBeUndefined();
    expect(called).toEqual([]);
  });

  it('reaches the handler in flight, and the nested run it cancelled fails its caller as cancelled', async () => {
    const control = new AbortController();
    const signals: (AbortSignal | undefined)[] = [];
    const serving = servingWith(async ({ ctx }) => {
      signals.push(ctx.signal);
      control.abort();
      throw new Error('This operation was aborted');
    });

    const report = await getCustomer(serving, control.signal);

    expect(report.status).toBe('cancelled');
    expect(signals[0]?.aborted).toBe(true);
    // the trigger's operation is the binding's `get`, lowered to its one node `op`, which runs get-row
    expect(report.nodes.op).toMatchObject({ status: 'failed', error: `${GET_ROW}: cancelled` });
    const row = report.nodes.op.sub as Report;
    expect(row.status).toBe('cancelled');
    expect(row.nodes.fetched).toMatchObject({ status: 'failed', error: 'This operation was aborted' });
    expect(row.nodes.outcome.status).toBe('cancelled');
  });
});
