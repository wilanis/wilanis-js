/**
 * RFC 0017's planner on a SQLite file, unconditionally and with no service (RFC 0022, step 6): the record made on
 * first contact, `inspect` reading back what a plan made, a `retype` that remakes the table, and -- the claim
 * worth pinning -- one plan, one transaction. The kind says `transactionalDdl: true`, and these cases are what
 * makes that a fact rather than a word: a plan that fails half way, even after a table was dropped and made
 * again, leaves the file and its `wilanis_migrations` record exactly as they were.
 *
 * The counts are `planner-counts.test.ts`, and the port's `ensure` over the planner is `planner-ensure.test.ts`.
 */
import { type Declared, driftOf, type Step } from '@wilanis/plugin-storage';
import { afterAll, describe, expect, it } from 'vitest';
import { ENTRIES, NOTES, planFor, planning } from './planning.js';

const { engine, fresh, raw, snapshot, apply, close } = planning('planner');
afterAll(close);

/** A connection whose file holds `entries` and `notes`, made by the plan the planner writes for them. */
async function made() {
  const on = fresh();
  await apply(on, planFor({ entries: ENTRIES, notes: NOTES }), { entries: ENTRIES, notes: NOTES });
  return on;
}

/** `entries` as the tree declares it after one field changed. */
const withField = (field: string, declared: Declared['fields'][string]): Declared => ({
  ...ENTRIES,
  fields: { ...ENTRIES.fields, [field]: declared },
});

/** A `retype` step, as the planner writes one. */
const retype = (at: string, was: 'string' | 'number', becomes: 'string' | 'number'): Step => ({
  do: 'retype',
  target: 'entries',
  at,
  was,
  becomes,
  says: `retype ${at}  ${was} → ${becomes}`,
});

describe('the record a file keeps of the plans that applied', () => {
  it('is made on first contact, and a file that has none answers nothing', async () => {
    const on = fresh();
    expect(await engine.recorded(on, 'entries')).toBeUndefined();
    const tables = raw(on).prepare(`select name from sqlite_master where name = 'wilanis_migrations'`).all();
    expect(tables).toHaveLength(1);
  });

  it('holds what a plan made, and the catalog reads the file back as exactly that', async () => {
    const on = await made();
    expect(await engine.recorded(on, 'entries')).toEqual(ENTRIES);
    expect(await engine.inspect(on, 'entries')).toEqual(ENTRIES);
    expect(await engine.inspect(on, 'notes')).toEqual(NOTES);
    expect(driftOf('notes', NOTES, await engine.inspect(on, 'notes'))).toEqual([]);
  });

  it('answers nothing for a table the file does not hold', async () => {
    expect(await engine.inspect(await made(), 'drafts')).toBeUndefined();
  });

  it('renames a column and keeps its values, and the record follows', async () => {
    const on = await made();
    raw(on).prepare(`insert into entries (id, url, method, code) values ('1', '/a', 'GET', 'x')`).run();
    const renamed: Declared = { ...ENTRIES, fields: { ...ENTRIES.fields, label: { type: 'string', required: false } } };
    delete renamed.fields.code;
    await apply(on, [{ do: 'rename', target: 'entries', at: 'label', from: 'code', says: 'rename code → label' }], {
      entries: renamed,
    });
    expect(raw(on).prepare('select label from entries').get()).toEqual({ label: 'x' });
    expect(await engine.inspect(on, 'entries')).toEqual(renamed);
  });

  it('reads back history latest first, and a dropped or renamed collection as gone', async () => {
    const on = await made();
    await apply(on, [{ do: 'drop', target: 'notes', says: 'drop collection notes' }], { notes: null });
    const step: Step = {
      do: 'renameCollection',
      target: 'calls',
      from: 'entries',
      says: 'rename collection entries → calls',
    };
    await apply(on, [step], { calls: ENTRIES });
    const history = await engine.history(on);
    expect(history.map(one => one.id)).toEqual([3, 2, 1]);
    expect(history[0]?.steps).toEqual({ calls: ['rename collection entries → calls'], entries: [] });
    expect(history[1]?.steps).toEqual({ notes: ['drop collection notes'] });
    expect(await engine.recorded(on, 'notes')).toBeUndefined();
    expect(await engine.recorded(on, 'entries')).toBeUndefined();
    expect(await engine.inspect(on, 'calls')).toEqual(ENTRIES);
  });

  it('writes no row for a plan with nothing to do', async () => {
    const on = await made();
    expect(await apply(on, [], {})).toBeUndefined();
    expect(await engine.history(on)).toHaveLength(1);
  });
});

describe('a step SQLite takes only by remaking the table', () => {
  it('a retype carries every value, and keeps the other columns, the unique and the references to the table', async () => {
    const on = await made();
    const db = raw(on);
    db.prepare(`insert into entries (id, url, method, code, vip) values ('1', '/a', 'GET', '42', 1)`).run();
    db.prepare(`insert into notes (id, entryId) values ('n', '1')`).run();
    const now = withField('code', { type: 'number', required: false });
    await apply(on, [retype('code', 'string', 'number')], { entries: now });
    expect(db.prepare('select code, typeof(code) as t, vip from entries').get()).toEqual({
      code: 42,
      t: 'real',
      vip: 1,
    });
    expect(await engine.inspect(on, 'entries')).toEqual(now);
    expect(await engine.recorded(on, 'entries')).toEqual(now);
    expect(() => db.prepare(`insert into entries (id, url, method) values ('2', '/a', 'GET')`).run()).toThrow(/UNIQUE/);
    expect(() => db.prepare(`delete from entries where id = '1'`).run()).toThrow(/FOREIGN KEY/);
  });

  it('a number becomes text as JavaScript writes it, and a text that reads as JSON becomes JSON', async () => {
    const on = await made();
    const db = raw(on);
    db.prepare(`insert into entries (id, url, method, code, hits) values ('1', '/a', 'GET', '{"a":1}', 3)`).run();
    const now: Declared = withField('hits', { type: 'string', required: false });
    now.fields.code = { type: 'json', required: false };
    const steps: Step[] = [
      retype('hits', 'number', 'string'),
      { ...retype('code', 'string', 'string'), becomes: 'json' },
    ];
    await apply(on, steps, { entries: now });
    expect(db.prepare('select hits, code from entries').get()).toEqual({ hits: '3', code: '{"a":1}' });
    expect(await engine.inspect(on, 'entries')).toEqual(now);
  });

  it('require fills what is empty with the default, relax lets it be empty again, remove takes the column', async () => {
    const on = await made();
    const db = raw(on);
    db.prepare(`insert into entries (id, url, method) values ('1', '/a', 'GET')`).run();
    const required = withField('code', { type: 'string', required: true });
    await apply(on, [{ do: 'require', target: 'entries', at: 'code', default: 'none', says: 'require code' }], {
      entries: required,
    });
    expect(db.prepare('select code from entries').get()).toEqual({ code: 'none' });
    expect(await engine.inspect(on, 'entries')).toEqual(required);
    await apply(on, [{ do: 'relax', target: 'entries', at: 'code', says: 'relax code' }], { entries: ENTRIES });
    expect(await engine.inspect(on, 'entries')).toEqual(ENTRIES);
    const without: Declared = { ...ENTRIES, fields: { ...ENTRIES.fields } };
    delete without.fields.code;
    await apply(on, [{ do: 'remove', target: 'entries', at: 'code', says: 'remove code' }], { entries: without });
    expect(await engine.inspect(on, 'entries')).toEqual(without);
  });

  it('a reference is added over a column the table already has, and dropped again', async () => {
    const on = await made();
    const loose: Declared = { ...NOTES, refs: {} };
    await apply(on, [{ do: 'unref', target: 'notes', at: 'entryId', to: 'entries', says: 'unref entryId' }], {
      notes: loose,
    });
    raw(on).prepare(`insert into notes (id, entryId) values ('n', 'nobody')`).run();
    expect(await engine.inspect(on, 'notes')).toEqual(loose);
    raw(on).prepare(`delete from notes`).run();
    await apply(on, [{ do: 'ref', target: 'notes', at: 'entryId', to: 'entries', says: 'ref entryId' }], {
      notes: NOTES,
    });
    expect(await engine.inspect(on, 'notes')).toEqual(NOTES);
    expect(() => raw(on).prepare(`insert into notes (id, entryId) values ('m', 'nobody')`).run()).toThrow(
      /FOREIGN KEY/,
    );
  });
});

describe('one plan, one transaction', () => {
  it('a step that fails half way leaves the table and the record exactly as they were', async () => {
    const on = await made();
    raw(on).prepare(`insert into entries (id, url, method) values ('1', '/a', 'GET'), ('2', '/a', 'POST')`).run();
    const before = snapshot(on);
    const steps: Step[] = [
      { do: 'add', target: 'entries', at: 'note', says: 'add note  string, optional' },
      // two rows already repeat this url, so the index cannot be made and the whole plan rolls back
      { do: 'unique', target: 'entries', at: 'url', over: ['url'], says: 'unique   [url]' },
    ];
    await expect(apply(on, steps, { entries: withField('note', { type: 'string', required: false }) })).rejects.toThrow(
      /UNIQUE/,
    );
    expect(snapshot(on)).toEqual(before);
    expect(await engine.recorded(on, 'entries')).toEqual(ENTRIES);
  });

  it('a step that fails after a table was dropped and made again leaves the file as it was', async () => {
    const on = await made();
    raw(on)
      .prepare(`insert into entries (id, url, method, code) values ('1', '/a', 'GET', '7'), ('2', '/a', 'POST', '8')`)
      .run();
    raw(on).prepare(`insert into notes (id, entryId) values ('n', '1')`).run();
    const before = snapshot(on);
    const steps: Step[] = [
      retype('code', 'string', 'number'),
      { do: 'unique', target: 'entries', at: 'url', over: ['url'], says: 'unique   [url]' },
    ];
    await expect(
      apply(on, steps, { entries: withField('code', { type: 'number', required: false }) }),
    ).rejects.toThrow();
    expect(snapshot(on)).toEqual(before);
    expect(await engine.recorded(on, 'entries')).toEqual(ENTRIES);
  });

  it('a value no cast carries fails the plan inside it, rather than turning into a 0', async () => {
    const on = await made();
    raw(on).prepare(`insert into entries (id, url, method, code) values ('1', '/a', 'GET', 'two')`).run();
    const before = snapshot(on);
    await expect(
      apply(on, [retype('code', 'string', 'number')], {
        entries: withField('code', { type: 'number', required: false }),
      }),
    ).rejects.toThrow(/1 row\(s\) hold a string no cast carries to number/);
    expect(snapshot(on)).toEqual(before);
  });

  it('a reference the rows break fails the plan at the check before the commit', async () => {
    const on = await made();
    const loose: Declared = { ...NOTES, refs: {} };
    await apply(on, [{ do: 'unref', target: 'notes', at: 'entryId', to: 'entries', says: 'unref entryId' }], {
      notes: loose,
    });
    raw(on).prepare(`insert into notes (id, entryId) values ('n', 'nobody')`).run();
    const before = snapshot(on);
    const step: Step = { do: 'ref', target: 'notes', at: 'entryId', to: 'entries', says: 'ref entryId' };
    await expect(apply(on, [step], { notes: NOTES })).rejects.toThrow(
      /1 row\(s\) name a record their reference does not hold/,
    );
    expect(snapshot(on)).toEqual(before);
    expect(await engine.recorded(on, 'notes')).toEqual(loose);
  });
});
