/**
 * Whether the record and the catalog say the same thing, against a real database (RFC 0017).
 *
 * The record is what every later plan trusts, so what it says and what the catalog holds have to be the same
 * thing. Each case here applies a plan through the planner itself and then reads both back: a difference
 * between them is a drift no later plan can see, because the next plan compares the record with the tree and
 * never the catalog. They are a suite of their own because the question is not what a member answers -- that
 * is `migrate.test.ts` -- but whether two answers agree.
 *
 * Skipped without `WILANIS_TEST_POSTGRES_URL`; see `engine.test.ts` for the container to run it against.
 */
import type { Declared, Step } from '@wilanis/plugin-storage';
import { classed, plan } from '@wilanis/plugin-storage';
import { sql } from 'kysely';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePools } from '../src/pool.js';
import { driving, ENTRIES, engine, NOTES, planFor, url } from './migrating.js';

// a schema of this suite's own: `migrate.test.ts` drives the same collections, and the two files run at once
const { on, schema, db, clean, apply } = driving('catalog_cases');

afterAll(async () => {
  if (url) await closePools();
});

describe.skipIf(!url)('the record and the catalog say the same thing', () => {
  beforeEach(clean);

  it('a fresh create gets the uniques and the refs the record claims, not the columns alone', async () => {
    const declared = { m_entries: ENTRIES, m_notes: NOTES };
    const steps = planFor(declared);
    // the create makes the columns and the key; every guarantee is its own step, and every create comes before
    // any of them, so a ref follows the create of the table it points at whichever order they are declared in
    expect(steps.map(step => `${step.do} ${step.target}`)).toEqual([
      'create m_entries',
      'create m_notes',
      'unique m_entries',
      'ref m_notes',
    ]);
    await apply(steps, declared);

    const recorded = await engine.recorded(on, 'm_entries');
    const found = await engine.inspect(on, 'm_entries');
    expect(found?.unique).toEqual([['url', 'method']]);
    expect(found?.unique).toEqual(recorded?.unique);

    const refs = await engine.inspect(on, 'm_notes');
    expect(refs?.refs.entryid).toEqual({ collection: 'm_entries', onRemove: 'refuse' });

    // and the database holds them: a second row repeating the pair is refused by the constraint itself
    await sql`insert into ${sql.ref(schema)}.m_entries (id, url, method) values ('1', '/a', 'GET')`.execute(db());
    await expect(
      sql`insert into ${sql.ref(schema)}.m_entries (id, url, method) values ('2', '/a', 'GET')`.execute(db()),
    ).rejects.toThrow();
  });

  it('the referencing collection declared first: the ref still applies, against a table that exists', async () => {
    // declaration order is the store's, and nothing says the referencing collection comes second. A plan that
    // wrote `notes`'s constraints straight after its own create would ALTER TABLE ... REFERENCES m_entries
    // inside the transaction two steps before the table is made, and the whole connection would roll back
    const declared = { m_notes: NOTES, m_entries: ENTRIES };
    const steps = planFor(declared);
    expect(steps.map(step => `${step.do} ${step.target}`)).toEqual([
      'create m_notes',
      'create m_entries',
      'ref m_notes',
      'unique m_entries',
    ]);
    await apply(steps, declared);

    const refs = await engine.inspect(on, 'm_notes');
    expect(refs?.refs.entryid).toEqual({ collection: 'm_entries', onRemove: 'refuse' });
    expect(await engine.recorded(on, 'm_notes')).toEqual(NOTES);
    // and the database holds it: a note pointing at no entry is refused by the constraint itself
    await expect(
      sql`insert into ${sql.ref(schema)}.m_notes (id, entryid) values ('1', 'nope')`.execute(db()),
    ).rejects.toThrow();
  });

  it('a required add with no default is NOT NULL, so the catalog says what the record says', async () => {
    await apply(planFor({ m_entries: ENTRIES }), { m_entries: ENTRIES });
    const withNote: Declared = { ...ENTRIES, fields: { ...ENTRIES.fields, note: { type: 'string', required: true } } };
    await apply([{ do: 'add', target: 'm_entries', at: 'note', says: 'add note  string, required' }], {
      m_entries: withNote,
    });
    const recorded = await engine.recorded(on, 'm_entries');
    const found = await engine.inspect(on, 'm_entries');
    expect(recorded?.fields.note).toEqual({ type: 'string', required: true });
    expect(found?.fields.note).toEqual(recorded?.fields.note);
    // the database holds it: a row leaving the column empty is refused
    await expect(
      sql`insert into ${sql.ref(schema)}.m_entries (id, url, method) values ('1', '/a', 'GET')`.execute(db()),
    ).rejects.toThrow();
  });

  it('a collection named with capitals is recorded under the name its table has, and found again', async () => {
    // Postgres folds an unquoted identifier, so the table is `auditlog` whatever the tree spells it; a record
    // written under the tree's spelling would never be found again, and every plan would create it afresh
    await apply(planFor({ auditLog: ENTRIES }), { auditLog: ENTRIES });
    const recorded = await engine.recorded(on, 'auditLog');
    const found = await engine.inspect(on, 'auditLog');
    expect(recorded).toEqual(ENTRIES);
    expect(found?.unique).toEqual(recorded?.unique);
    expect(found?.fields.url).toEqual(recorded?.fields.url);
    // so the next plan against the same tree has nothing left to do
    expect(plan({ auditLog: recorded as Declared }, { auditLog: ENTRIES }, {}).steps).toEqual([]);
  });

  it('a cast this engine will not attempt is refused on an empty table, not classed destructive', async () => {
    await apply(planFor({ m_entries: ENTRIES }), { m_entries: ENTRIES });
    const step: Step = {
      do: 'retype',
      target: 'm_entries',
      at: 'ua',
      was: 'json',
      becomes: 'number',
      says: 'retype ua  json → number',
    };
    // the table is empty, so the count is zero and honestly so: no row stands in the step's way. What refuses
    // it is the pair, which is the engine's own table, and the operator reads `refused` as the Guide table says
    expect(await engine.rows(on, step)).toBe(0);
    const one = classed(step, 0, { attempts: (was, becomes) => engine.attempts(was, becomes) });
    expect(one.class).toBe('refused');
    expect(one.refused).toContain('attempts no cast from json to number');
    // and a pair it does attempt is classed by the count, exactly as it was
    const widening: Step = { ...step, was: 'number', becomes: 'string', says: 'retype ua  number → string' };
    expect(classed(widening, 0, { attempts: (was, becomes) => engine.attempts(was, becomes) }).class).toBe(
      'destructive',
    );
  });
});
