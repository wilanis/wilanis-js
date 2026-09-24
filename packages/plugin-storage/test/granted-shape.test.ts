/**
 * X201 over a shape a plugin grants (RFC 0005): a collection may keep one, whatever layer the plugin wrote it
 * in. The host of `@auth` keeps the guard's sessions as `@auth/SessionRecord.shape.json`, and copying the
 * record into a core shape of its own would make the plugin's layout the host's to keep in step. A feature's
 * own edge shape is still refused, which `rules.test.ts` holds.
 */
import { describe, expect, it } from 'vitest';
import { editing, refusals } from './harness.js';

describe('what a collection may keep, when a plugin grants it', () => {
  it('no X201 for a granted edge shape, and its required field is a key', () => {
    // @storage's own Order is an edge shape, the layer X201 refuses for a feature's shape
    const found = refusals(
      editing('features/customers/data/customers.store.json', doc => {
        doc.collections.customers = { of: '@storage/Order.shape.json', key: 'by' };
      }),
    );
    expect(found.filter(one => one.code === 'X201' || one.code === 'X202')).toEqual([]);
  });
});
