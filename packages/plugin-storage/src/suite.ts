/**
 * What every engine must answer alike, as cases a package exports and an engine's tests import -- so that
 * "this is an engine" has one meaning, and it is executable. No test framework is named here: a case is a
 * name and a function, and an engine's test file turns each into whatever `it` it has.
 *
 *   import { cases } from '@wilanis/plugin-storage/suite';
 *   for (const one of cases) it(one.name, () => one.run(subject));
 *
 * Each case keeps its records in a collection of its own, so an engine that really persists them can run the
 * whole suite against one database without the cases reaching each other.
 */
import { strict as assert } from 'node:assert';
import type { Type } from '@wilanis/core';
import type { At, Engine, Record_ } from './engine.js';
import { parseWhere } from './where.js';

/** The shape the suite keeps: one required field of each kind the grammar tests, and one optional. */
export const SHAPE: Type = {
  kind: 'object',
  name: 'Entry',
  open: false,
  fields: {
    id: { type: { kind: 'string' }, required: true },
    url: { type: { kind: 'string' }, required: true },
    method: { type: { kind: 'string' }, required: true },
    hits: { type: { kind: 'number' }, required: true },
    ok: { type: { kind: 'boolean' }, required: true },
    ua: { type: { kind: 'string' }, required: false },
  },
};

/** What an engine's own tests hand the suite: the engine, and the connection it was registered for. */
export interface Subject {
  engine: Engine;
  connection: { connection: string; kind: string; settings: Record<string, unknown> };
}

/** One thing every engine must do, by the name it is done under. */
export interface Case {
  name: string;
  run(subject: Subject): Promise<void>;
}

const entry = (id: string, url: string, method: string, rest: Partial<Record_> = {}): Record_ => ({
  id,
  url,
  method,
  hits: 1,
  ok: true,
  ...rest,
});

const SEEDS: Record_[] = [
  entry('a', 'https://one.example/a', 'GET', { hits: 3, ua: 'curl' }),
  entry('b', 'https://two.example/b', 'POST', { hits: 7, ok: false }),
  entry('c', 'http://localhost/c', 'GET', { hits: 5, ua: 'wget' }),
];

const ids = (records: Record_[]) => records.map(record => String(record.id)).sort();
const where = (filter: unknown) => parseWhere(filter, SHAPE);

/** What a case declares beyond the shape: the constraints the engine is to answer for. */
type Declared = Partial<Pick<At, 'unique' | 'refs' | 'referenced'>>;

/** A collection of the subject's connection, named for the case that keeps its records there. */
function at(subject: Subject, name: string, declared: Declared = {}): At {
  return { ...subject.connection, name, shape: SHAPE, key: 'id', unique: [], refs: [], referenced: [], ...declared };
}

/** A collection made, emptied of anything a previous run left, and filled with the seeds. */
async function seeded(
  subject: Subject,
  name: string,
  records: Record_[] = SEEDS,
  declared: Declared = {},
): Promise<At> {
  const where_ = at(subject, name, declared);
  await subject.engine.ensure([where_]);
  for (const record of await subject.engine.find(where_, {})) await subject.engine.remove(where_, record.id);
  for (const record of records) await subject.engine.put(where_, record, true);
  return where_;
}

const found = async (subject: Subject, where_: At, filter: unknown) =>
  ids(await subject.engine.find(where_, { where: where(filter) }));

export const cases: Case[] = [
  {
    name: 'a record put is the record got, field for field',
    async run(subject) {
      const where_ = await seeded(subject, 'put_get', []);
      const written = await subject.engine.put(where_, SEEDS[0], true);
      assert.equal(written.conflict, false);
      assert.deepEqual(written.record, SEEDS[0]);
      assert.deepEqual((await subject.engine.get(where_, 'a')).record, SEEDS[0]);
    },
  },
  {
    name: 'a key nothing is kept under answers record absent, and does not fail',
    async run(subject) {
      const where_ = await seeded(subject, 'get_missing');
      assert.equal((await subject.engine.get(where_, 'nobody')).record, undefined);
    },
  },
  {
    name: 'put replaces by default; with replace false it answers conflict and writes nothing',
    async run(subject) {
      const where_ = await seeded(subject, 'put_replace');
      const over = entry('a', 'https://changed.example/a', 'PUT', { hits: 99 });
      assert.deepEqual((await subject.engine.put(where_, over, true)).record, over);
      const refused = await subject.engine.put(where_, entry('a', 'https://not.example/a', 'DELETE'), false);
      assert.equal(refused.conflict, true);
      assert.equal(refused.record, undefined);
      assert.deepEqual((await subject.engine.get(where_, 'a')).record, over);
    },
  },
  {
    name: 'a find with no filter answers every record of the collection',
    async run(subject) {
      const where_ = await seeded(subject, 'find_all');
      assert.deepEqual(ids(await subject.engine.find(where_, {})), ['a', 'b', 'c']);
    },
  },
  {
    name: 'a bare value matches on equality, and every operator matches what it says',
    async run(subject) {
      const where_ = await seeded(subject, 'find_ops');
      assert.deepEqual(await found(subject, where_, { method: 'GET' }), ['a', 'c']);
      assert.deepEqual(await found(subject, where_, { method: { ne: 'GET' } }), ['b']);
      assert.deepEqual(await found(subject, where_, { hits: { gte: 5 } }), ['b', 'c']);
      assert.deepEqual(await found(subject, where_, { hits: { lt: 5 } }), ['a']);
      assert.deepEqual(await found(subject, where_, { method: { in: ['POST', 'PUT'] } }), ['b']);
      assert.deepEqual(await found(subject, where_, { method: { notIn: ['GET'] } }), ['b']);
      assert.deepEqual(await found(subject, where_, { ua: { has: true } }), ['a', 'c']);
      assert.deepEqual(await found(subject, where_, { ua: { has: false } }), ['b']);
      assert.deepEqual(await found(subject, where_, { url: { contains: 'localhost' } }), ['c']);
      assert.deepEqual(await found(subject, where_, { url: { startsWith: 'https://' } }), ['a', 'b']);
      assert.deepEqual(await found(subject, where_, { ok: false }), ['b']);
    },
  },
  {
    name: 'all, any and not combine filters, and several keys are one all',
    async run(subject) {
      const where_ = await seeded(subject, 'find_combinators');
      assert.deepEqual(await found(subject, where_, { method: 'GET', hits: { gt: 4 } }), ['c']);
      assert.deepEqual(await found(subject, where_, { all: [{ method: 'GET' }, { ua: { has: true } }] }), ['a', 'c']);
      assert.deepEqual(await found(subject, where_, { any: [{ method: 'POST' }, { hits: { lt: 4 } }] }), ['a', 'b']);
      assert.deepEqual(await found(subject, where_, { not: { method: 'GET' } }), ['b']);
    },
  },
  {
    name: 'a find orders by a field, then skips and takes',
    async run(subject) {
      const where_ = await seeded(subject, 'find_order');
      const asc = await subject.engine.find(where_, { order: [{ by: 'hits', dir: 'asc' }] });
      assert.deepEqual(
        asc.map(record => record.hits),
        [3, 5, 7],
      );
      const desc = await subject.engine.find(where_, { order: [{ by: 'hits', dir: 'desc' }] });
      assert.deepEqual(String(desc[0].id), 'b');
      const page = await subject.engine.find(where_, { order: [{ by: 'hits', dir: 'asc' }], limit: 1, offset: 1 });
      assert.deepEqual(ids(page), ['c']);
    },
  },
  {
    name: 'count answers how many match, and carries no record back',
    async run(subject) {
      const where_ = await seeded(subject, 'count');
      assert.equal(await subject.engine.count(where_, undefined), 3);
      assert.equal(await subject.engine.count(where_, where({ method: 'GET' })), 2);
      assert.equal(await subject.engine.count(where_, where({ method: 'NOPE' })), 0);
    },
  },
  {
    name: 'patch changes the fields it names and leaves every other one alone',
    async run(subject) {
      const where_ = await seeded(subject, 'patch');
      const after = await subject.engine.patch(where_, 'a', { hits: 42 });
      assert.equal(after.record?.hits, 42);
      assert.equal(after.record?.url, SEEDS[0].url);
      assert.equal((await subject.engine.get(where_, 'a')).record?.hits, 42);
    },
  },
  {
    name: 'a patch of a key nothing is kept under answers record absent',
    async run(subject) {
      const where_ = await seeded(subject, 'patch_missing');
      assert.equal((await subject.engine.patch(where_, 'nobody', { hits: 1 })).record, undefined);
    },
  },
  {
    name: 'remove answers the record it removed, and the collection no longer holds it',
    async run(subject) {
      const where_ = await seeded(subject, 'remove');
      assert.deepEqual((await subject.engine.remove(where_, 'b')).record, SEEDS[1]);
      assert.equal((await subject.engine.get(where_, 'b')).record, undefined);
      assert.equal(await subject.engine.count(where_, undefined), 2);
    },
  },
  {
    name: 'a remove of a key nothing is kept under answers record absent, and removed false',
    async run(subject) {
      const where_ = await seeded(subject, 'remove_missing');
      const answer = await subject.engine.remove(where_, 'nobody');
      assert.equal(answer.record, undefined);
      assert.equal(answer.removed, false);
    },
  },
  {
    name: 'a remove of a record that is there answers it, and removed true',
    async run(subject) {
      const where_ = await seeded(subject, 'remove_removed');
      const answer = await subject.engine.remove(where_, 'a');
      assert.deepEqual(answer.record, SEEDS[0]);
      assert.equal(answer.removed, true);
    },
  },
  {
    name: 'a put repeating a declared unique answers violated and writes nothing',
    async run(subject) {
      const declared: Declared = { unique: [['url', 'method']] };
      const where_ = await seeded(subject, 'unique_put', SEEDS, declared);
      const repeat = entry('z', 'https://one.example/a', 'GET');
      const answer = await subject.engine.put(where_, repeat, true);
      assert.equal(answer.violated, 'unique [url, method]');
      assert.equal(answer.record, undefined);
      assert.equal((await subject.engine.get(where_, 'z')).record, undefined);
    },
  },
  {
    name: 'a put over a record repeats nothing of its own, and answers no violation',
    async run(subject) {
      const declared: Declared = { unique: [['url']] };
      const where_ = await seeded(subject, 'unique_self', SEEDS, declared);
      const over = entry('a', 'https://one.example/a', 'PUT', { hits: 9 });
      const answer = await subject.engine.put(where_, over, true);
      assert.equal(answer.violated, undefined);
      assert.deepEqual(answer.record, over);
    },
  },
  {
    name: 'a put whose reference names no record answers violated and writes nothing',
    async run(subject) {
      const to = await seeded(subject, 'refs_to');
      const from = at(subject, 'refs_from', { refs: [{ from: 'refs_from', field: 'ua', to: 'refs_to' }] });
      await subject.engine.ensure([from]);
      const answer = await subject.engine.put(from, entry('n', 'https://note', 'GET', { ua: 'nobody' }), true);
      assert.equal(answer.violated, 'refs refs_from.ua -> refs_to');
      assert.equal((await subject.engine.get(from, 'n')).record, undefined);
      assert.equal(await subject.engine.count(to, undefined), 3);
    },
  },
  {
    name: 'a put whose reference names a record that is there is written',
    async run(subject) {
      await seeded(subject, 'refs_ok_to');
      const from = at(subject, 'refs_ok_from', { refs: [{ from: 'refs_ok_from', field: 'ua', to: 'refs_ok_to' }] });
      await subject.engine.ensure([from]);
      const note = entry('n', 'https://note', 'GET', { ua: 'a' });
      assert.deepEqual((await subject.engine.put(from, note, true)).record, note);
    },
  },
  {
    name: 'a remove of a record another still references keeps it, and answers referencedBy',
    async run(subject) {
      const ref = { from: 'held_from', field: 'ua', to: 'held_to' };
      const to = await seeded(subject, 'held_to', SEEDS, { referenced: [ref] });
      const from = at(subject, 'held_from', { refs: [ref] });
      await subject.engine.ensure([from]);
      await subject.engine.put(from, entry('n', 'https://note', 'GET', { ua: 'a' }), true);
      const answer = await subject.engine.remove(to, 'a');
      assert.equal(answer.referencedBy, 'refs held_from.ua -> held_to');
      assert.equal(answer.removed, false);
      assert.deepEqual((await subject.engine.get(to, 'a')).record, SEEDS[0]);
    },
  },
  {
    name: 'a remove of a record nothing references any more goes through',
    async run(subject) {
      const ref = { from: 'freed_from', field: 'ua', to: 'freed_to' };
      const to = await seeded(subject, 'freed_to', SEEDS, { referenced: [ref] });
      const from = at(subject, 'freed_from', { refs: [ref] });
      await subject.engine.ensure([from]);
      await subject.engine.put(from, entry('n', 'https://note', 'GET', { ua: 'a' }), true);
      await subject.engine.remove(from, 'n');
      assert.equal((await subject.engine.remove(to, 'a')).removed, true);
    },
  },
  {
    name: 'newKey answers a key no record has, and a different one every time',
    async run(subject) {
      const where_ = await seeded(subject, 'new_key');
      const keys = [await subject.engine.newKey(where_), await subject.engine.newKey(where_)];
      assert.notEqual(keys[0], keys[1]);
      for (const key of keys) assert.equal((await subject.engine.get(where_, key)).record, undefined);
    },
  },
  {
    name: 'ensure makes a collection that is not there and leaves one that is alone',
    async run(subject) {
      const where_ = await seeded(subject, 'ensure');
      await subject.engine.ensure([where_]);
      assert.equal(await subject.engine.count(where_, undefined), 3);
    },
  },
];
