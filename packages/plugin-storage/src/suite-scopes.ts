/**
 * What every engine must answer about a scope: that a row belongs to the scope it was written under, that no
 * key crosses one, that a key is nevertheless global, that a `unique` holds within a scope and not across it,
 * that a view -- a read with no scope -- sees every row, that a filter and a scope narrow one read together,
 * and that a scope nothing has been written under yet reads as empty.
 *
 * These are the cases the whole of RFC 0015 rests on at run time. The checker proves that every site over a
 * scoped collection carries a scope, and the handlers prove the scope fits the collection's words; that two
 * tenants never see each other's rows is this file, because it is the engine's promise and nothing above the
 * engine can observe it. They are a family of their own, beside the record cases and the transaction ones,
 * for the reason `suite-transactions.ts` is: one file, one thing an engine is asked to be.
 */
import { strict as assert } from 'node:assert';
import { ACME, type Case, entry, foundIn, GLOBEX, ids, scoped, where } from './suite-fixture.js';

/** What a store does with a scope: written, read back within it, and never across it. */
export const scopeCases: Case[] = [
  {
    name: 'a put writes the scope, and only that scope finds the record',
    async run(subject) {
      const where_ = await scoped(subject, 'scope_put');
      await subject.engine.put(where_, entry('a', 'https://one.example/a', 'GET'), { replace: true, scope: ACME });
      assert.deepEqual(await foundIn(subject, where_, ACME), ['a']);
      assert.deepEqual(await foundIn(subject, where_, GLOBEX), []);
      assert.equal(await subject.engine.count(where_, undefined, ACME), 1);
      assert.equal(await subject.engine.count(where_, undefined, GLOBEX), 0);
    },
  },
  {
    name: 'a key does not cross a scope: get, patch and remove of another scope find nothing',
    async run(subject) {
      const where_ = await scoped(subject, 'scope_key');
      const record = entry('a', 'https://one.example/a', 'GET');
      await subject.engine.put(where_, record, { replace: true, scope: ACME });
      assert.equal((await subject.engine.get(where_, 'a', GLOBEX)).record, undefined);
      assert.equal((await subject.engine.patch(where_, 'a', { hits: 42 }, { scope: GLOBEX })).record, undefined);
      const removed = await subject.engine.remove(where_, 'a', GLOBEX);
      assert.equal(removed.record, undefined);
      assert.equal(removed.removed, false);
      assert.deepEqual((await subject.engine.get(where_, 'a', ACME)).record, record);
    },
  },
  {
    name: 'the key is global: a put of a key another scope holds answers conflict and writes nothing',
    async run(subject) {
      const where_ = await scoped(subject, 'scope_global');
      const mine = entry('a', 'https://one.example/a', 'GET');
      await subject.engine.put(where_, mine, { replace: true, scope: ACME });
      const theirs = entry('a', 'https://two.example/a', 'POST');
      const answer = await subject.engine.put(where_, theirs, { replace: true, scope: GLOBEX });
      assert.equal(answer.conflict, true);
      assert.equal(answer.record, undefined);
      assert.deepEqual((await subject.engine.get(where_, 'a', ACME)).record, mine);
      assert.deepEqual(await foundIn(subject, where_, GLOBEX), []);
    },
  },
  {
    name: 'a unique is judged within the scope: taken under one is free under another',
    async run(subject) {
      const where_ = await scoped(subject, 'scope_unique', { unique: [['url', 'method']] });
      const taken = entry('a', 'https://one.example/a', 'GET');
      await subject.engine.put(where_, taken, { replace: true, scope: ACME });
      const elsewhere = entry('b', 'https://one.example/a', 'GET');
      assert.equal((await subject.engine.put(where_, elsewhere, { replace: true, scope: GLOBEX })).violated, undefined);
      const again = entry('c', 'https://one.example/a', 'GET');
      const repeat = await subject.engine.put(where_, again, { replace: true, scope: ACME });
      assert.equal(repeat.violated, 'unique [url, method]');
      assert.equal(repeat.record, undefined);
    },
  },
  {
    name: 'a view sees every row: a read with no scope answers both scopes',
    async run(subject) {
      const where_ = await scoped(subject, 'scope_view');
      await subject.engine.put(where_, entry('a', 'https://one.example/a', 'GET'), { replace: true, scope: ACME });
      await subject.engine.put(where_, entry('b', 'https://two.example/b', 'POST'), { replace: true, scope: GLOBEX });
      assert.deepEqual(await foundIn(subject, where_, undefined), ['a', 'b']);
      assert.equal(await subject.engine.count(where_, undefined, undefined), 2);
      assert.deepEqual((await subject.engine.get(where_, 'b', undefined)).record?.id, 'b');
    },
  },
  {
    name: 'a scope of several columns is compared whole, and one column apart is another scope',
    async run(subject) {
      const where_ = await scoped(subject, 'scope_several');
      const both = { tenant: 'acme', owner: 'ada' };
      await subject.engine.put(where_, entry('a', 'https://one.example/a', 'GET'), { replace: true, scope: both });
      assert.deepEqual(await foundIn(subject, where_, both), ['a']);
      assert.deepEqual(await foundIn(subject, where_, { tenant: 'acme', owner: 'grace' }), []);
      assert.deepEqual(await foundIn(subject, where_, { tenant: 'globex', owner: 'ada' }), []);
    },
  },
  {
    name: 'a filter and a scope narrow one read together: neither the other scope nor the other rows answer',
    async run(subject) {
      const where_ = await scoped(subject, 'scope_filter');
      await subject.engine.put(where_, entry('a', 'https://one.example/a', 'GET'), { replace: true, scope: ACME });
      await subject.engine.put(where_, entry('b', 'https://one.example/b', 'POST'), { replace: true, scope: ACME });
      await subject.engine.put(where_, entry('c', 'https://two.example/c', 'GET'), { replace: true, scope: GLOBEX });
      const get = where({ method: 'GET' });
      assert.deepEqual(ids(await subject.engine.find(where_, { where: get, scope: ACME })), ['a']);
      assert.equal(await subject.engine.count(where_, get, ACME), 1);
      assert.deepEqual(ids(await subject.engine.find(where_, { where: where({ method: 'POST' }), scope: GLOBEX })), []);
      assert.equal(await subject.engine.count(where_, get, undefined), 2);
    },
  },
  {
    name: 'a scoped read before any write answers empty: find, get and count under a scope find nothing',
    async run(subject) {
      const where_ = await scoped(subject, 'scope_unwritten');
      assert.deepEqual(await foundIn(subject, where_, ACME), []);
      assert.equal((await subject.engine.get(where_, 'a', ACME)).record, undefined);
      assert.equal(await subject.engine.count(where_, undefined, ACME), 0);
      assert.equal(await subject.engine.count(where_, where({ method: 'GET' }), ACME), 0);
    },
  },
];
