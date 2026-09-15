/**
 * The five members RFC 0017 adds to `Engine`, and the *Guide* table that classes a step once they have
 * answered. Every case here is over a fake engine whose `recorded`, `inspect` and `rows` are tables the test
 * fills, which is what the RFC's plan for this step assumes: the contract is what is pinned, not any one
 * engine's answers to it.
 *
 * What the classing has to get right is the difference a count makes: the same step is additive on an empty
 * table and destructive or refused on a full one, and that difference is the whole reason a plan is printed
 * before it runs.
 */
import { type Type, TypeResolver } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import type { Applied, Applying, Engine, On, Recording } from '../src/index.js';
import { type Declared, declaredOf, plan, type Step } from '../src/plan.js';
import { classed, counts } from '../src/plan-class.js';

const types = new TypeResolver(() => undefined);

const CONNECTION = '@connections/entries.connection.json';
const KIND = '@fake/fake.connection-kind.json';
const on: On = { connection: CONNECTION, kind: KIND, settings: {} };

/** The example's `Entry`: an id, a url, a method, and an optional user agent. */
const ENTRY: Type = types.inline({
  fields: {
    id: { type: 'string' },
    url: { type: 'string' },
    method: { type: 'string' },
    ua: { type: 'string', required: false },
  },
});

const ENTRIES: Declared = declaredOf({ of: '@x/Entry.shape.json', key: 'id', unique: [['url', 'method']] }, ENTRY);

/** What the fake engine was asked, so a test can say a count was taken and what for. */
interface Asked {
  rows: Step[];
  applied: { steps: Step[]; record: Recording; applying: Applying }[];
}

/**
 * An engine whose record, catalog and counts are whatever the case says they are. It keeps nothing and does
 * nothing: what is under test is the shape of the five answers and what the classing makes of them.
 */
function fake(answers: { recorded?: Record<string, Declared>; found?: Record<string, Declared>; rows?: number }) {
  const asked: Asked = { rows: [], applied: [] };
  const engine: Pick<Engine, 'recorded' | 'inspect' | 'rows' | 'apply' | 'history'> = {
    async recorded(_on, collection) {
      return answers.recorded?.[collection];
    },
    async inspect(_on, collection) {
      return answers.found?.[collection];
    },
    async rows(_on, step) {
      asked.rows.push(step);
      return answers.rows ?? 0;
    },
    async apply(where, steps, record, applying): Promise<Applied> {
      asked.applied.push({ steps, record, applying });
      return {
        id: asked.applied.length,
        appliedAt: '2026-09-11T09:14:02.000Z',
        by: applying.by,
        tree: applying.tree,
        connection: where.connection,
        targets: Object.keys(record),
      };
    },
    async history() {
      return [];
    },
  };
  return { engine, asked };
}

/** The steps a plan answers, counted by the engine and classed by the *Guide* table. */
async function planned(
  engine: Pick<Engine, 'recorded' | 'inspect' | 'rows'>,
  steps: Step[],
): Promise<{ says: string; class: string; rows: number; refused?: string }[]> {
  const out = [];
  for (const step of steps) {
    const rows = counts(step) ? await engine.rows(on, step) : 0;
    const one = classed(step, rows);
    out.push({ says: one.step.says, class: one.class, rows: one.rows, refused: one.refused });
  }
  return out;
}

describe('the five members an engine answers about the record it keeps', () => {
  it('a connection that never recorded a collection answers nothing, for the record and for the catalog', async () => {
    const { engine } = fake({});
    expect(await engine.recorded(on, 'entries')).toBeUndefined();
    expect(await engine.inspect(on, 'entries')).toBeUndefined();
  });

  it('the record answers what was last applied, and the catalog what the database actually holds', async () => {
    const { engine } = fake({ recorded: { entries: ENTRIES }, found: { notes: ENTRIES } });
    expect(await engine.recorded(on, 'entries')).toEqual(ENTRIES);
    expect(await engine.recorded(on, 'notes')).toBeUndefined();
    expect(await engine.inspect(on, 'notes')).toEqual(ENTRIES);
  });

  it('apply is given only the steps it is to run, the record to write, and who is running it', async () => {
    const { engine, asked } = fake({});
    const steps: Step[] = [{ do: 'add', target: 'entries', at: 'note', says: 'add note  string, optional' }];
    const record: Recording = { entries: ENTRIES, notes: null };
    const applying: Applying = { by: 'rfontes@build-1', tree: 'monitor' };
    const answer = await engine.apply(on, steps, record, applying);
    expect(asked.applied).toHaveLength(1);
    expect(asked.applied[0]?.steps).toEqual(steps);
    expect(asked.applied[0]?.record).toEqual(record);
    expect(answer).toMatchObject({ id: 1, by: 'rfontes@build-1', tree: 'monitor', connection: CONNECTION });
    expect(answer?.targets).toEqual(['entries', 'notes']);
  });

  it('a connection nothing ever applied to has no history', async () => {
    const { engine } = fake({});
    expect(await engine.history(on)).toEqual([]);
  });
});

describe('what a count makes of a step: the Guide table', () => {
  it('a create and an adopt cost nothing on any database, so neither is ever counted', async () => {
    const { engine, asked } = fake({ rows: 4000 });
    const created = plan({}, { entries: ENTRIES }, {}).steps;
    // the create is followed by the guarantees the collection declares, each its own step; the create itself
    // is additive whatever the database holds, and is never the step a count is taken for
    expect((await planned(engine, created))[0]).toEqual({
      says: 'create collection entries',
      class: 'additive',
      rows: 0,
      refused: undefined,
    });
    const adopted = plan({}, { entries: ENTRIES }, {}, { entries: ENTRIES }).steps;
    expect(await planned(engine, adopted)).toEqual([
      {
        says: 'adopt collection entries (from the database as it stands)',
        class: 'additive',
        rows: 0,
        refused: undefined,
      },
    ]);
    // no count was ever asked for a create or an adopt: a table this plan makes, or takes as it stands, costs nothing
    expect(asked.rows.map(step => step.do)).not.toContain('create');
    expect(asked.rows.map(step => step.do)).not.toContain('adopt');
  });

  it('a dropped collection is transformative at zero rows and destructive above', async () => {
    const empty = fake({ rows: 0 });
    const full = fake({ rows: 17 });
    const steps = plan({ notes: ENTRIES }, {}, {}).steps;
    expect(await planned(empty.engine, steps)).toEqual([
      { says: 'drop collection notes', class: 'transformative', rows: 0, refused: undefined },
    ]);
    expect(await planned(full.engine, steps)).toEqual([
      { says: 'drop collection notes', class: 'destructive', rows: 17, refused: undefined },
    ]);
  });

  it('a unique is additive where no row repeats it, and refused with the count where some do', async () => {
    const step: Step = { do: 'unique', target: 'entries', at: 'url', over: ['url'], says: 'unique   [url]' };
    expect(classed(step, 0).class).toBe('additive');
    const refused = classed(step, 4);
    expect(refused.class).toBe('refused');
    expect(refused.refused).toContain('4 row(s) repeat [url]');
    expect(refused.refused).toContain('one-off graph fired by a command-line trigger');
  });

  it('a refs is additive where nothing dangles, and refused with the count where something does', async () => {
    const step: Step = { do: 'ref', target: 'notes', at: 'entryId', to: 'entries', says: 'ref      entryId → entries' };
    expect(classed(step, 0).class).toBe('additive');
    expect(classed(step, 2).refused).toContain('2 row(s) point at no entries');
  });

  it('a field made required is additive at zero empty rows, destructive above, and additive with a default', () => {
    const step: Step = { do: 'require', target: 'entries', at: 'ua', says: 'require ua', loses: 'rows with no ua' };
    expect(classed(step, 0).class).toBe('additive');
    expect(classed(step, 240).class).toBe('destructive');
    expect(classed({ ...step, default: 'unknown' }, 240).class).toBe('additive');
    // a default answers for every empty row, so there is nothing to count at all
    expect(counts({ ...step, default: 'unknown' })).toBe(false);
  });

  it('an added optional column is additive at any count, and a required one with no default is not', () => {
    const optional: Step = { do: 'add', target: 'entries', at: 'note', says: 'add note  string, optional' };
    expect(counts(optional)).toBe(false);
    expect(classed(optional, 0).class).toBe('additive');
    const required: Step = { ...optional, says: 'add note  string, required', loses: 'rows with no note' };
    expect(counts(required)).toBe(true);
    expect(classed(required, 0).class).toBe('additive');
    expect(classed(required, 240).class).toBe('destructive');
  });

  it('a removed column is transformative where it is empty everywhere and destructive where it holds a value', () => {
    const step: Step = { do: 'remove', target: 'entries', at: 'ua', says: 'remove ua', loses: 'values of ua' };
    expect(classed(step, 0).class).toBe('transformative');
    expect(classed(step, 240).class).toBe('destructive');
  });

  it('a retype is destructive where every value casts, and refused with the count where some will not', () => {
    const step: Step = {
      do: 'retype',
      target: 'entries',
      at: 'method',
      was: 'string',
      becomes: 'number',
      says: 'retype method  string → number',
    };
    expect(classed(step, 0).class).toBe('destructive');
    const refused = classed(step, 3);
    expect(refused.class).toBe('refused');
    expect(refused.refused).toContain('3 row(s) hold a string in method');
  });

  it('a rename, a relax and a dropped guarantee cost no data, so none of them is ever counted', () => {
    const steps: Step[] = [
      { do: 'rename', target: 'entries', at: 'agent', from: 'ua', says: 'rename ua → agent' },
      { do: 'renameCollection', target: 'drafts', from: 'notes', says: 'rename collection notes → drafts' },
      { do: 'relax', target: 'entries', at: 'ua', says: 'relax ua' },
      { do: 'ununique', target: 'entries', at: 'url', over: ['url'], says: 'ununique [url]' },
      { do: 'unref', target: 'notes', at: 'entryId', to: 'entries', says: 'unref    entryId → entries' },
    ];
    for (const step of steps) {
      expect(counts(step)).toBe(false);
      expect(classed(step, 0).class).toBe('transformative');
    }
  });

  it('a step the planner refused stays refused whatever the count says, and keeps its own hint', () => {
    const steps = plan({ entries: ENTRIES }, { entries: { ...ENTRIES, key: 'slug' } }, {}).steps;
    const rekey = steps.find(one => one.do === 'rekey');
    expect(rekey).toBeDefined();
    expect(counts(rekey as Step)).toBe(false);
    const one = classed(rekey as Step, 0);
    expect(one.class).toBe('refused');
    expect(one.refused).toContain('re-keying is a new collection');
  });
});
