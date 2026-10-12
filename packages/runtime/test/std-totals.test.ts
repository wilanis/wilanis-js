/**
 * `@std/list.port.json#totals` (RFC 0039): one total per distinct value of a string field, in the order each key
 * first appears, with how many elements have it and the sum of a number field over them. The handler is called
 * as the engine calls it; where the embedder resolves types, the answer is judged as `@std/Total.shape.json[]`.
 */
import { loadTree, Scope } from '@wilanis/core';
import type { RunContext } from '@wilanis/engine';
import { describe, expect, it } from 'vitest';
import { std } from '../src/index.js';
import { EXAMPLE, INCLUDES, PLUGINS } from './example-harness.js';

const totals = std.handlers['@std/list.port.json#totals'];

/** Total a list through the handler, with the embedder's env given or none. */
const total = (input: Record<string, unknown>, env: Record<string, unknown> = {}) =>
  totals({ in: input, ctx: { env } as unknown as RunContext });

const ORDERS = [
  { tier: 'gold', total: 5, buyer: { region: 'north' } },
  { tier: 'silver', total: 2, buyer: { region: 'south' } },
  { tier: 'gold', total: 1, buyer: { region: 'north' } },
  { tier: 'bronze', total: 4, buyer: { region: 'north' } },
  { tier: 'silver', total: 3, buyer: { region: 'south' } },
];

describe('@std/list.port.json#totals', () => {
  it('groups in the order each key first appears, counting and summing per key', async () => {
    expect(await total({ list: ORDERS, by: 'tier', sum: 'total' })).toEqual([
      { key: 'gold', count: 2, sum: 6 },
      { key: 'silver', count: 2, sum: 5 },
      { key: 'bronze', count: 1, sum: 4 },
    ]);
  });

  it('reads a dotted path within the element', async () => {
    expect(await total({ list: ORDERS, by: 'buyer.region', sum: 'total' })).toEqual([
      { key: 'north', count: 3, sum: 10 },
      { key: 'south', count: 2, sum: 5 },
    ]);
  });

  it('answers 0 for every sum without sum', async () => {
    expect(await total({ list: ORDERS, by: 'tier' })).toEqual([
      { key: 'gold', count: 2, sum: 0 },
      { key: 'silver', count: 2, sum: 0 },
      { key: 'bronze', count: 1, sum: 0 },
    ]);
  });

  it('answers [] for an empty list', async () => {
    expect(await total({ list: [], by: 'tier', sum: 'total' })).toEqual([]);
  });

  it('faults on a key that is not a string, naming the element', async () => {
    await expect(total({ list: [ORDERS[0], { tier: 7, total: 1 }], by: 'tier' })).rejects.toThrow(
      "totals: element 1 has no string at 'tier'",
    );
    await expect(total({ list: [{ total: 1 }], by: 'tier' })).rejects.toThrow("element 0 has no string at 'tier'");
  });

  it('faults on a number that is not a number', async () => {
    await expect(total({ list: [{ tier: 'gold', total: '5' }], by: 'tier', sum: 'total' })).rejects.toThrow(
      "totals: element 0 has no number at 'total'",
    );
  });

  it('answers what @std/Total.shape.json[] declares, judged where the embedder resolves types', async () => {
    const load = loadTree(EXAMPLE, PLUGINS, INCLUDES);
    const scope = new Scope(load.registry, load.resolve);
    const resolveType = (ref: string) => scope.types.spec(ref);
    expect(await total({ list: ORDERS, by: 'tier' }, { resolveType })).toHaveLength(3);
  });
});
