/**
 * The counts that decide what a step costs (RFC 0017), on a SQLite file: `4 rows violate` is what the file
 * answers before anything runs, not what the commit says afterwards. Each is one query, shaped by the step, as
 * the postgres engine's are; two are SQLite's own, and each has a case: a `unique` counts rows as a unique index
 * judges them, and a `retype` counts what `casts.ts` says no cast carries, since SQLite's cast never fails.
 */
import type { Step } from '@wilanis/plugin-storage';
import { afterAll, describe, expect, it } from 'vitest';
import { ENTRIES, NOTES, planFor, planning } from './planning.js';

const { engine, fresh, raw, apply, close } = planning('counts');
afterAll(close);

/** A connection whose file holds `entries` and `notes`, and the rows a case inserts into `entries`. */
async function holding(rows: string) {
  const on = fresh();
  await apply(on, planFor({ entries: ENTRIES, notes: NOTES }), { entries: ENTRIES, notes: NOTES });
  if (rows) raw(on).prepare(`insert into entries (id, url, method, code, vip) values ${rows}`).run();
  return on;
}

/** A `retype` of `entries.code` or `entries.vip`, as the planner writes one. */
const retype = (at: string, was: Step['was'], becomes: Step['becomes']): Step => ({
  do: 'retype',
  target: 'entries',
  at,
  was,
  becomes,
  says: `retype ${at}`,
});

describe('the counts that decide what a step costs', () => {
  it('a drop counts every row the collection holds', async () => {
    const on = await holding(`('1', '/a', 'GET', null, null), ('2', '/b', 'GET', null, null)`);
    expect(await engine.rows(on, { do: 'drop', target: 'entries', says: 'drop' })).toBe(2);
  });

  it('a remove counts the rows that hold a value, and a require the rows that leave it empty', async () => {
    const on = await holding(`('1', '/a', 'GET', 'x', null), ('2', '/b', 'GET', null, null)`);
    expect(await engine.rows(on, { do: 'remove', target: 'entries', at: 'code', says: 'remove code' })).toBe(1);
    expect(await engine.rows(on, { do: 'require', target: 'entries', at: 'vip', says: 'require vip' })).toBe(2);
  });

  it('a unique counts every row of every group that repeats it, and a row with an empty field repeats nothing', async () => {
    const on = await holding(
      `('1', '/a', 'GET', 'x', null), ('2', '/b', 'GET', 'x', null), ('3', '/c', 'GET', 'x', null), ('4', '/d', 'GET', 'y', null), ('5', '/e', 'GET', null, null), ('6', '/f', 'GET', null, null)`,
    );
    const step: Step = { do: 'unique', target: 'entries', at: 'code', over: ['code'], says: 'unique [code]' };
    expect(await engine.rows(on, step)).toBe(3);
  });

  it('a unique on a scoped table counts the rows that repeat it within one scope', async () => {
    const on = await holding('');
    const db = raw(on);
    db.prepare(`alter table entries add column tenant TEXT NOT NULL DEFAULT 'a'`).run();
    db.prepare('create index "wl_i_entries_scope" on entries (tenant, id)').run();
    db.prepare(
      `insert into entries (id, url, method, code, tenant) values ('1', '/a', 'GET', 'x', 'a'), ('2', '/b', 'GET', 'x', 'b')`,
    ).run();
    const step: Step = { do: 'unique', target: 'entries', at: 'code', over: ['code'], says: 'unique [code]' };
    expect(await engine.rows(on, step)).toBe(0);
    db.prepare(`insert into entries (id, url, method, code, tenant) values ('3', '/c', 'GET', 'x', 'b')`).run();
    expect(await engine.rows(on, step)).toBe(2);
  });

  it('a retype counts the values no cast carries, and none where every value reads as the other type', async () => {
    const on = await holding(
      `('1', '/a', 'GET', '1', 1), ('2', '/b', 'GET', 'two', 0), ('3', '/c', 'GET', '2.5', null), ('4', '/d', 'GET', null, null)`,
    );
    expect(await engine.rows(on, retype('code', 'string', 'number'))).toBe(1);
    expect(await engine.rows(on, retype('code', 'string', 'json'))).toBe(1);
    expect(await engine.rows(on, retype('code', 'string', 'boolean'))).toBe(2);
    expect(await engine.rows(on, retype('vip', 'boolean', 'string'))).toBe(0);
  });

  it('a pair the engine does not attempt is refused, and counts every value it would lose', async () => {
    const on = await holding(`('1', '/a', 'GET', null, 1), ('2', '/b', 'GET', null, null)`);
    expect(engine.attempts('boolean', 'number')).toBe(false);
    expect(engine.attempts('string', 'number')).toBe(true);
    expect(await engine.rows(on, retype('vip', 'boolean', 'number'))).toBe(1);
  });

  it('a required add counts every row, since each has nothing to put in the column', async () => {
    const on = await holding(`('1', '/a', 'GET', null, null)`);
    const step: Step = { do: 'add', target: 'entries', at: 'note', says: 'add note', loses: 'rows with no note' };
    expect(await engine.rows(on, step)).toBe(1);
  });

  it('a refs counts the rows pointing at no record of the other collection', async () => {
    const on = await holding(`('1', '/a', 'GET', null, null)`);
    const db = raw(on);
    db.pragma('foreign_keys = OFF');
    db.prepare(`insert into notes (id, entryId) values ('a', '1'), ('b', 'gone'), ('c', null)`).run();
    const step: Step = { do: 'ref', target: 'notes', at: 'entryId', to: 'entries', says: 'ref entryId' };
    expect(await engine.rows(on, step)).toBe(1);
  });
});
