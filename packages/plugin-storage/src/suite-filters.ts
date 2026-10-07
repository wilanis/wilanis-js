/**
 * What a filter answers at the edges of its grammar: a field named in camelCase, a list of no value, a field a
 * record does not hold, and a filter of no test at all. The memory engine's answer is the right one in each:
 * a SQL engine that reads an operator its own way -- `!=` that drops an empty column, `in ()` that the database
 * refuses -- says it the memory engine's way instead, and these cases are where it is held to that.
 *
 * `filterCases` is part of `cases`, so every engine runs it. `emptyWhereCases` is exported beside them rather
 * than folded in: the SQLite and MySQL engines still fault on a filter of no test, and their fix is issue #848,
 * which waits on other open changes to those engines. The memory and postgres engines run both lists. Once
 * #848 lands, `emptyWhereCases` folds into `cases` and this export goes.
 */
import { strict as assert } from 'node:assert';
import type { Type } from '@wilanis/core';
import { type Case, found, ids, SEEDS, SHAPE, seeded, where } from './suite-fixture.js';
import { parseWhere } from './where.js';

/**
 * The suite's shape with one optional field more, named in camelCase: a database that folds a name to lower
 * case must still find it. It is a shape of its own rather than a field of `SHAPE`, since an engine's own tests
 * read `SHAPE` column by column (the MySQL mapping), and one more field there is a change to each of them.
 */
const TRACED: Type =
  SHAPE.kind === 'object'
    ? { ...SHAPE, fields: { ...SHAPE.fields, traceId: { type: { kind: 'string' }, required: false } } }
    : SHAPE;

/** The suite's seeds, two of them holding the camelCase field and one not. */
const TRACES = [{ ...SEEDS[0], traceId: 't-1' }, { ...SEEDS[1], traceId: 't-2' }, SEEDS[2]];

/**
 * What a filter answers over a camelCase field, an empty list and an absent field, in every engine. Where a test
 * of an absent field is false in memory, a `not` over it is true, however deep the `not` sits; SQL answers
 * unknown for that test, and an engine whose `not` kept the unknown would drop the record.
 */
export const filterCases: Case[] = [
  {
    name: 'a field named in camelCase is read, filtered, counted and ordered by as any other field is',
    async run(subject) {
      const where_ = await seeded(subject, 'find_camel', TRACES, { shape: TRACED });
      assert.deepEqual((await subject.engine.get(where_, 'a')).record, TRACES[0]);
      assert.deepEqual(await found(subject, where_, { traceId: 't-1' }), ['a']);
      assert.deepEqual(await found(subject, where_, { traceId: { in: ['t-1', 't-2'] } }), ['a', 'b']);
      assert.deepEqual(await found(subject, where_, { traceId: { ne: 't-1' } }), ['b', 'c']);
      const held = parseWhere({ traceId: { has: true } }, TRACED);
      assert.equal(await subject.engine.count(where_, held), 2);
      const desc = await subject.engine.find(where_, { where: held, order: [{ by: 'traceId', dir: 'desc' }] });
      assert.deepEqual(
        desc.map(record => String(record.id)),
        ['b', 'a'],
      );
    },
  },
  {
    name: 'in over no value matches no record, and notIn over no value matches every record',
    async run(subject) {
      const where_ = await seeded(subject, 'find_empty_list');
      assert.deepEqual(await found(subject, where_, { method: { in: [] } }), []);
      assert.deepEqual(await found(subject, where_, { method: { notIn: [] } }), ['a', 'b', 'c']);
      assert.deepEqual(await found(subject, where_, { ua: { notIn: [] } }), ['a', 'b', 'c']);
      assert.equal(await subject.engine.count(where_, where({ method: { in: [] } })), 0);
      assert.equal(await subject.engine.count(where_, where({ method: { notIn: [] } })), 3);
    },
  },
  {
    name: 'ne and notIn match a record that does not hold the field',
    async run(subject) {
      const where_ = await seeded(subject, 'find_absent');
      assert.deepEqual(await found(subject, where_, { ua: { ne: 'curl' } }), ['b', 'c']);
      assert.deepEqual(await found(subject, where_, { ua: { notIn: ['curl'] } }), ['b', 'c']);
      assert.equal(await subject.engine.count(where_, where({ ua: { ne: 'curl' } })), 2);
    },
  },
  {
    name: 'not over a test of a field a record does not hold keeps that record',
    async run(subject) {
      const where_ = await seeded(subject, 'find_not_absent');
      assert.deepEqual(await found(subject, where_, { not: { ua: 'curl' } }), ['b', 'c']);
      assert.deepEqual(await found(subject, where_, { not: { ua: { in: ['curl', 'wget'] } } }), ['b']);
      assert.deepEqual(await found(subject, where_, { not: { ua: { contains: 'url' } } }), ['b', 'c']);
      assert.deepEqual(await found(subject, where_, { not: { ua: { startsWith: 'cu' } } }), ['b', 'c']);
      assert.deepEqual(await found(subject, where_, { not: { ua: { gt: 'a' } } }), ['b']);
      assert.equal(await subject.engine.count(where_, where({ not: { ua: 'curl' } })), 2);
    },
  },
  {
    name: 'not nested, and not over all and any, keep a record that does not hold the field',
    async run(subject) {
      const where_ = await seeded(subject, 'find_not_nested');
      assert.deepEqual(await found(subject, where_, { not: { not: { ua: 'curl' } } }), ['a']);
      assert.deepEqual(await found(subject, where_, { not: { any: [{ ua: 'wget' }, { method: 'PUT' }] } }), ['a', 'b']);
      assert.deepEqual(await found(subject, where_, { not: { all: [{ ua: 'curl' }, { method: 'GET' }] } }), ['b', 'c']);
      const inside = { not: { all: [{ not: { ua: 'curl' } }, { method: 'GET' }] } };
      assert.deepEqual(await found(subject, where_, inside), ['a', 'b']);
      assert.deepEqual(await found(subject, where_, { any: [{ not: { ua: 'curl' } }, { method: 'GET' }] }), [
        'a',
        'b',
        'c',
      ]);
      assert.deepEqual(await found(subject, where_, { all: [{ not: { ua: 'curl' } }, { method: 'POST' }] }), ['b']);
    },
  },
];

/** What a filter of no test answers, alone and inside a combinator: every record, as no filter does. */
export const emptyWhereCases: Case[] = [
  {
    name: 'a filter of no test matches every record, in a find and in a count',
    async run(subject) {
      const where_ = await seeded(subject, 'find_empty_where');
      assert.deepEqual(ids(await subject.engine.find(where_, { where: where({}) })), ['a', 'b', 'c']);
      assert.deepEqual(await found(subject, where_, { all: [] }), ['a', 'b', 'c']);
      assert.equal(await subject.engine.count(where_, where({})), 3);
    },
  },
  {
    name: 'a filter of no test inside not, any and all means what it means alone',
    async run(subject) {
      const where_ = await seeded(subject, 'find_empty_inner');
      assert.deepEqual(await found(subject, where_, { not: {} }), []);
      assert.deepEqual(await found(subject, where_, { any: [{}, { method: 'POST' }] }), ['a', 'b', 'c']);
      assert.deepEqual(await found(subject, where_, { all: [{}, { method: 'POST' }] }), ['b']);
      assert.equal(await subject.engine.count(where_, where({ not: {} })), 0);
    },
  },
];
