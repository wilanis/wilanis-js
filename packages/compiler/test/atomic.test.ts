/**
 * The scope an atomic graph's run carries. The compiler has no other test directory -- every checker rule is
 * exercised through the example -- but the scope is a concurrency mechanism rather than a rule, and what it
 * promises (two nodes in one tick share one transaction) is invisible in a tree that passes.
 */
import type { Participant } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { AtomicScope } from '../src/atomic.js';

/** A participant that records what was asked of it, and how many were opened. */
function fake(): { opened: number; open: () => Promise<Participant>; log: string[] } {
  const log: string[] = [];
  const state = {
    opened: 0,
    log,
    open: async () => {
      state.opened += 1;
      return {
        commit: async () => {
          log.push('commit');
        },
        rollback: async () => {
          log.push('rollback');
        },
      };
    },
  };
  return state;
}

describe('AtomicScope', () => {
  it('opens once when two callers join in the same tick', async () => {
    const one = fake();
    const scope = new AtomicScope();

    // What `Run.execute` does: both nodes are ready, so both start before either has awaited.
    const [first, second] = await Promise.all([
      scope.join('@connections/customers.connection.json', one.open),
      scope.join('@connections/customers.connection.json', one.open),
    ]);

    expect(one.opened).toBe(1);
    expect(first).toBe(second);
  });

  it('opens once when the second caller joins after the first has settled into place', async () => {
    const one = fake();
    const scope = new AtomicScope();

    await scope.join('@connections/customers.connection.json', one.open);
    await scope.join('@connections/customers.connection.json', one.open);

    expect(one.opened).toBe(1);
  });

  it('commits what was opened when the run answered', async () => {
    const one = fake();
    const scope = new AtomicScope();

    await scope.join('@connections/customers.connection.json', one.open);
    await scope.settle(true);

    expect(one.log).toEqual(['commit']);
  });

  it('rolls back what was opened when the run did not answer', async () => {
    const one = fake();
    const scope = new AtomicScope();

    await scope.join('@connections/customers.connection.json', one.open);
    await scope.settle(false);

    expect(one.log).toEqual(['rollback']);
  });

  it('settles nothing when no transactional effect ever joined', async () => {
    const scope = new AtomicScope();

    await expect(scope.settle(true)).resolves.toBeUndefined();
  });

  it('faults on a join to a second connection', async () => {
    const one = fake();
    const scope = new AtomicScope();

    await scope.join('@connections/customers.connection.json', one.open);

    await expect(scope.join('@connections/other.connection.json', one.open)).rejects.toThrow(/two connections/);
  });
});
