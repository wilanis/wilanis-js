/**
 * What every engine must answer alike about a transaction: that committing keeps what was written, that
 * rolling back keeps none of it -- the changes and the removals as much as the additions -- and that a
 * transaction reads back its own writes before it ends. This is the half of "this is an engine" that an
 * atomic graph rests on (RFC 0004): a graph declares that its effects move together, and these cases are
 * what the engines underneath it are held to.
 */
import { strict as assert } from 'node:assert';
import { began, type Case, ids, SEEDS, seeded } from './suite-fixture.js';

/** The transaction cases, joined to the record cases as `cases` in `suite.ts`. */
export const transactionCases: Case[] = [
  {
    name: 'a transaction committed keeps every write it made',
    async run(subject) {
      const where_ = await seeded(subject, 'trx_commit', []);
      const trx = await began(subject, where_);
      await trx.engine.put(where_, SEEDS[0], true);
      await trx.engine.put(where_, SEEDS[1], true);
      await trx.commit();
      assert.deepEqual(ids(await subject.engine.find(where_, {})), ['a', 'b']);
    },
  },
  {
    name: 'a transaction rolled back keeps none of them',
    async run(subject) {
      const where_ = await seeded(subject, 'trx_rollback', []);
      const trx = await began(subject, where_);
      await trx.engine.put(where_, SEEDS[0], true);
      await trx.engine.put(where_, SEEDS[1], true);
      await trx.rollback();
      assert.deepEqual(ids(await subject.engine.find(where_, {})), []);
    },
  },
  {
    name: 'a rollback puts back what the transaction changed and removed, not only what it added',
    async run(subject) {
      const where_ = await seeded(subject, 'trx_undo');
      const trx = await began(subject, where_);
      await trx.engine.patch(where_, 'a', { url: 'https://changed.example/a' });
      await trx.engine.remove(where_, 'b');
      await trx.rollback();
      assert.deepEqual(ids(await subject.engine.find(where_, {})), ['a', 'b', 'c']);
      assert.deepEqual((await subject.engine.get(where_, 'a')).record, SEEDS[0]);
    },
  },
  {
    name: 'what a transaction has written, it reads back itself',
    async run(subject) {
      const where_ = await seeded(subject, 'trx_reads', []);
      const trx = await began(subject, where_);
      await trx.engine.put(where_, SEEDS[0], true);
      assert.deepEqual((await trx.engine.get(where_, 'a')).record, SEEDS[0]);
      assert.equal(await trx.engine.count(where_, undefined), 1);
      await trx.rollback();
    },
  },
];
