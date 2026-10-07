/**
 * `@storage/storage.port.json#ensure` over the planner, on a SQLite file (RFC 0017, step 5, on this engine): what
 * a startup step's `ensure` does is plan the store against the record and the catalog, apply the plan where
 * every step is additive, and refuse `drift` where one is not. The work is @storage's `ensureStore`, which the
 * port's handler calls; these cases call it with this engine, as a started tree does.
 *
 * Every refusal `Engine.ensure` makes (`constraints.test.ts`) is a refusal here too, now in the planner's words:
 * a column of another type, a required column with no default over rows, a `unique` the rows repeat (#826), a
 * column the shape no longer has. Two things `Engine.ensure` refused only because SQLite's `ALTER TABLE` cannot
 * do them -- a required column with no default on an empty table, a reference over a column the table already
 * has -- are additive by RFC 0017's table, and the planner applies them by remaking the table.
 */
import { type Type, TypeResolver } from '@wilanis/core';
import { type At, type Declares, driftOf, ensureStore, type On } from '@wilanis/plugin-storage';
import { afterAll, describe, expect, it } from 'vitest';
import { planning } from './planning.js';

const { engine, fresh, raw, snapshot, close } = planning('ensure');
afterAll(close);

const types = new TypeResolver(() => undefined);
/** A shape of the fields a case names, each a string unless it says otherwise; `?` marks one optional. */
function shape(fields: Record<string, string>): Type {
  const entries = Object.entries(fields).map(([name, type]) => [
    name.replace('?', ''),
    { type, ...(name.endsWith('?') ? { required: false } : {}) },
  ]);
  return types.inline({ fields: Object.fromEntries(entries) });
}

const ENTRY = shape({ id: 'string', url: 'string', 'hits?': 'number', 'vip?': 'boolean', 'tags?': 'string[]' });
const NOTE = shape({ id: 'string', 'entryId?': 'string' });

/** A store over one connection, as `storeFor` lowers one off the tree, with the shapes its collections name. */
function store(on: On, collections: Record<string, Declares>, shapes: Record<string, Type>) {
  const connection = { connection: on.connection, kind: on.kind, settings: on.settings };
  return { on: connection, declaring: { connection: on.connection, collections }, shapeOf: (of: string) => shapes[of] };
}

/** Prepare a store as a startup step does, and answer what was made. */
const ensure = (lowered: ReturnType<typeof store>, log: string[] = []) =>
  ensureStore(engine, lowered, { serving: { root: '/trees/entries', log: (line: string) => log.push(line) } });

const ENTRIES: Declares = { of: 'Entry', key: 'id', unique: [['url']] };
const NOTES: Declares = { of: 'Note', key: 'id', refs: { entryId: { collection: 'entries' } } };
const SHAPES = { Entry: ENTRY, Note: NOTE };

/** A collection as `Engine.ensure` is handed one, for a file an earlier ensure built before the planner. */
const at = (on: On, name: string, of: Type, what: Partial<At> = {}): At => ({
  ...on,
  name,
  shape: of,
  key: 'id',
  unique: [],
  refs: [],
  referenced: [],
  defaults: {},
  ...what,
});

describe('ensure over the planner', () => {
  it('prepares an empty file and records it, the catalog then agreeing with the record, and a second run makes nothing', async () => {
    const on = fresh();
    const lowered = store(on, { entries: ENTRIES, notes: NOTES }, SHAPES);
    expect(await ensure(lowered)).toEqual({ collections: 2, columns: 0, constraints: 2 });
    expect(await ensure(lowered)).toEqual({ collections: 0, columns: 0, constraints: 0 });
    expect(await engine.history(on)).toHaveLength(1);
    for (const name of ['entries', 'notes']) {
      const recorded = await engine.recorded(on, name);
      expect(recorded).toBeDefined();
      expect(driftOf(name, recorded ?? ENTRIES, await engine.inspect(on, name))).toEqual([]);
    }
  });

  it('adopts a table an earlier ensure built, its scope columns kept as a scope, and says so', async () => {
    const on = fresh();
    const kept = at(on, 'entries', ENTRY, { unique: [['url']] });
    await engine.ensure([kept]);
    await engine.put(kept, { id: '1', url: '/a' }, { replace: true, scope: { tenant: 't' } });
    const log: string[] = [];
    expect((await ensure(store(on, { entries: ENTRIES }, SHAPES), log)).collections).toBe(1);
    expect(log.join('\n')).toMatch(/adopt collection entries/);
    const recorded = await engine.recorded(on, 'entries');
    expect(Object.keys(recorded?.fields ?? {})).toEqual(['id', 'url', 'hits', 'vip', 'tags']);
    expect(driftOf('entries', recorded ?? ({} as never), await engine.inspect(on, 'entries'))).toEqual([]);
  });

  it('applies what is additive: an optional field, a required one with a default, a unique no row repeats', async () => {
    const on = fresh();
    await ensure(store(on, { entries: ENTRIES }, SHAPES));
    raw(on).prepare(`insert into entries (id, url) values ('1', '/a'), ('2', '/b')`).run();
    const grown = shape({
      id: 'string',
      url: 'string',
      'hits?': 'number',
      'vip?': 'boolean',
      'tags?': 'string[]',
      'ua?': 'string',
      tier: 'string',
    });
    const declared: Declares = { ...ENTRIES, unique: [['url'], ['ua']], defaults: { tier: 'bronze' } };
    expect(await ensure(store(on, { entries: declared }, { Entry: grown }))).toEqual({
      collections: 0,
      columns: 2,
      constraints: 1,
    });
    expect(raw(on).prepare('select tier from entries order by id').all()).toEqual([
      { tier: 'bronze' },
      { tier: 'bronze' },
    ]);
  });

  it('adds a required field with no default to an empty table, which SQLite takes only by remaking it', async () => {
    const on = fresh();
    await ensure(store(on, { entries: ENTRIES }, SHAPES));
    const grown = shape({
      id: 'string',
      url: 'string',
      'hits?': 'number',
      'vip?': 'boolean',
      'tags?': 'string[]',
      tier: 'string',
    });
    expect((await ensure(store(on, { entries: ENTRIES }, { Entry: grown }))).columns).toBe(1);
    expect(
      raw(on).prepare(`select "notnull" as n from pragma_table_info('entries') where name = 'tier'`).get(),
    ).toEqual({ n: 1 });
  });

  it('adds a reference over a column the table already has, by remaking it, and the reference holds', async () => {
    const on = fresh();
    await ensure(store(on, { entries: ENTRIES, notes: { of: 'Note', key: 'id' } }, SHAPES));
    expect((await ensure(store(on, { entries: ENTRIES, notes: NOTES }, SHAPES))).constraints).toBe(1);
    expect(() => raw(on).prepare(`insert into notes (id, entryId) values ('n', 'nobody')`).run()).toThrow(
      /FOREIGN KEY/,
    );
  });
});

describe('what ensure refuses, as drift, leaving the file and the record as they were', () => {
  /** A file prepared under the first shape and holding two rows, then prepared under the second, which must refuse. */
  async function refuses(now: { shape: Type; declares?: Partial<Declares> }, said: RegExp) {
    const on = fresh();
    await ensure(store(on, { entries: ENTRIES }, SHAPES));
    raw(on).prepare(`insert into entries (id, url, hits) values ('1', '/a', 1), ('2', '/b', 2)`).run();
    const before = snapshot(on);
    const lowered = store(on, { entries: { ...ENTRIES, ...now.declares } }, { Entry: now.shape });
    await expect(ensure(lowered)).rejects.toThrow(said);
    expect(snapshot(on)).toEqual(before);
  }

  it('a column of another type', () =>
    refuses(
      { shape: shape({ id: 'string', url: 'string', 'hits?': 'string', 'vip?': 'boolean', 'tags?': 'string[]' }) },
      /^drift:[\s\S]*retype hits {2}number → string {2}\(destructive\)/,
    ));

  it('a required column with no default, over rows', () =>
    refuses(
      {
        shape: shape({
          id: 'string',
          url: 'string',
          'hits?': 'number',
          'vip?': 'boolean',
          'tags?': 'string[]',
          tier: 'string',
        }),
      },
      /^drift:[\s\S]*add tier {2}string, required {2}\(destructive\)/,
    ));

  it('a unique the rows already repeat (#826); one over a field every row leaves empty is no refusal', async () => {
    const on = fresh();
    await ensure(store(on, { entries: ENTRIES }, SHAPES));
    raw(on).prepare(`insert into entries (id, url, hits) values ('1', '/a', 1), ('2', '/b', 1)`).run();
    const before = snapshot(on);
    const repeated = store(on, { entries: { ...ENTRIES, unique: [['url'], ['hits']] } }, SHAPES);
    await expect(ensure(repeated)).rejects.toThrow(
      /^drift:[\s\S]*unique {3}\[hits\] {2}\(refused\) -- 2 row\(s\) repeat/,
    );
    expect(snapshot(on)).toEqual(before);
    const empty = store(on, { entries: { ...ENTRIES, unique: [['url'], ['vip']] } }, SHAPES);
    expect((await ensure(empty)).constraints).toBe(1);
  });

  it('a column the shape no longer has, holding values', () =>
    refuses(
      { shape: shape({ id: 'string', url: 'string', 'vip?': 'boolean', 'tags?': 'string[]' }) },
      /^drift:[\s\S]*remove hits {2}\(destructive\)/,
    ));
});
