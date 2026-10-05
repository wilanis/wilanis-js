/**
 * What every engine must answer alike about a transaction: that committing keeps what was written, that
 * rolling back keeps none of it -- the changes and the removals as much as the additions -- and that a
 * transaction reads back its own writes before it ends. This is the half of "this is an engine" that an
 * atomic graph rests on (RFC 0004): a graph declares that its effects move together, and these cases are
 * what the engines underneath it are held to.
 *
 * A write a constraint refuses is answered `violated` (or, for a remove, `referencedBy`) and the transaction
 * goes on: the graph routes on the answer, and whatever it writes next commits with the rest. That is what the
 * memory engine has always done, and what a database that aborts a transaction on a constraint error has to
 * be made to do -- the last three cases are where the two are held alike.
 */
import { strict as assert } from 'node:assert';
import { at, began, type Case, entry, ids, SEEDS, seeded } from './suite-fixture.js';

/** The record a case writes after a refused one, to show the transaction still takes writes. */
const AFTER = entry('y', 'https://after.example/y', 'GET');

/** The transaction cases, joined to the record cases as `cases` in `suite.ts`. */
export const transactionCases: Case[] = [
  {
    name: 'a transaction committed keeps every write it made',
    async run(subject) {
      const where_ = await seeded(subject, 'trx_commit', []);
      const trx = await began(subject, where_);
      await trx.engine.put(where_, SEEDS[0], { replace: true });
      await trx.engine.put(where_, SEEDS[1], { replace: true });
      await trx.commit();
      assert.deepEqual(ids(await subject.engine.find(where_, {})), ['a', 'b']);
    },
  },
  {
    name: 'a transaction rolled back keeps none of them',
    async run(subject) {
      const where_ = await seeded(subject, 'trx_rollback', []);
      const trx = await began(subject, where_);
      await trx.engine.put(where_, SEEDS[0], { replace: true });
      await trx.engine.put(where_, SEEDS[1], { replace: true });
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
      await trx.engine.put(where_, SEEDS[0], { replace: true });
      assert.deepEqual((await trx.engine.get(where_, 'a')).record, SEEDS[0]);
      assert.equal(await trx.engine.count(where_, undefined), 1);
      await trx.rollback();
    },
  },
  {
    name: 'a put a unique refuses inside a transaction answers violated, and a later write still commits',
    async run(subject) {
      const where_ = await seeded(subject, 'trx_violated_put', SEEDS, { unique: [['url', 'method']] });
      const trx = await began(subject, where_);
      const repeat = entry('z', 'https://one.example/a', 'GET');
      assert.equal((await trx.engine.put(where_, repeat, { replace: true })).violated, 'unique [url, method]');
      assert.deepEqual((await trx.engine.put(where_, AFTER, { replace: true })).record, AFTER);
      await trx.commit();
      assert.deepEqual(ids(await subject.engine.find(where_, {})), ['a', 'b', 'c', 'y']);
    },
  },
  {
    name: 'a patch a unique refuses inside a transaction answers violated, and a later write still commits',
    async run(subject) {
      const where_ = await seeded(subject, 'trx_violated_patch', SEEDS, { unique: [['url', 'method']] });
      const trx = await began(subject, where_);
      const answer = await trx.engine.patch(where_, 'c', { url: 'https://one.example/a' });
      assert.equal(answer.violated, 'unique [url, method]');
      assert.deepEqual((await trx.engine.put(where_, AFTER, { replace: true })).record, AFTER);
      await trx.commit();
      assert.deepEqual(ids(await subject.engine.find(where_, {})), ['a', 'b', 'c', 'y']);
      assert.deepEqual((await subject.engine.get(where_, 'c')).record, SEEDS[2]);
    },
  },
  {
    name: 'a remove a reference keeps inside a transaction answers referencedBy, and a later write still commits',
    async run(subject) {
      const ref = { from: 'trx_held_from', field: 'ua', to: 'trx_held_to' };
      const to = await seeded(subject, 'trx_held_to', SEEDS, { referenced: [ref] });
      const from = at(subject, 'trx_held_from', { refs: [ref] });
      await subject.engine.ensure([from]);
      await subject.engine.put(from, entry('n', 'https://note', 'GET', { ua: 'a' }), { replace: true });
      const trx = await began(subject, to);
      const answer = await trx.engine.remove(to, 'a');
      assert.equal(answer.referencedBy, 'refs trx_held_from.ua -> trx_held_to');
      assert.deepEqual(answer.record, SEEDS[0]);
      assert.deepEqual((await trx.engine.put(to, AFTER, { replace: true })).record, AFTER);
      await trx.commit();
      assert.deepEqual(ids(await subject.engine.find(to, {})), ['a', 'b', 'c', 'y']);
    },
  },
];
