/**
 * The five migration members against a real database (RFC 0017): `wilanis_migrations` made on first contact,
 * `inspect` over the catalog, `rows` as one count shaped by the step, `apply` as one transaction, `history`
 * as what applied.
 *
 * The claim worth pinning is the transaction: a step that fails half way leaves the table and the record
 * exactly as they were, which is what makes "one plan, one transaction" a promise the operator can read the
 * plan against. The others are the counts that let a plan be read at all: `4 rows violate` is what the
 * database answers before anything runs, not what `COMMIT` says afterwards.
 *
 * Skipped without `WILANIS_TEST_POSTGRES_URL`; see `engine.test.ts` for the container to run it against.
 */
import type { Applying, Declared, On, Recording, Step } from '@wilanis/plugin-storage';
import { classed, plan } from '@wilanis/plugin-storage';
import { sql } from 'kysely';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgresEngine } from '../src/engine.js';
import { closePools, poolFor } from '../src/pool.js';

const url = process.env.WILANIS_TEST_POSTGRES_URL;
const KIND = '@storage-postgres/postgres.connection-kind.json';
const on: On = { connection: '@connections/migrate.connection.json', kind: KIND, settings: { url } };

const engine = new PostgresEngine({});
const by: Applying = { by: 'rfontes@build-1', tree: 'monitor' };

/** The `entries` collection as the tree declares it: keyed by id, one url per method, an optional agent. */
const ENTRIES: Declared = {
  key: 'id',
  fields: {
    id: { type: 'string', required: true },
    url: { type: 'string', required: true },
    method: { type: 'string', required: true },
    ua: { type: 'string', required: false },
  },
  unique: [['url', 'method']],
  refs: {},
};

/** The `notes` collection: a note of an entry, so it references one and declares no `unique` of its own. */
const NOTES: Declared = {
  key: 'id',
  fields: { id: { type: 'string', required: true }, entryId: { type: 'string', required: false } },
  unique: [],
  refs: { entryId: { collection: 'm_entries', onRemove: 'refuse' } },
};

/** The database this test's connection reaches, for the statements that set a case up. */
const db = () => poolFor(on, {}).db;

/** Drop what a case made, so each one starts from a database that has never seen it. */
async function clean(): Promise<void> {
  for (const table of ['m_notes', 'm_drafts', 'auditlog', 'm_entries', 'wilanis_migrations'])
    await sql`drop table if exists public.${sql.ref(table)} cascade`.execute(db());
}

/** Apply one plan and answer what the record says it was. */
const apply = (steps: Step[], record: Recording) => engine.apply(on, steps, record, by);

/**
 * The steps the planner writes for collections a database has never recorded. Every case that makes a table
 * goes through this rather than through a hand-written `create`, so what a fresh plan actually does is what
 * these cases apply: a create that recorded a guarantee it never made would go unnoticed otherwise.
 */
const planFor = (declared: Record<string, Declared>) => plan({}, declared, {}).steps;

afterAll(async () => {
  if (url) await closePools();
});

describe.skipIf(!url)('the record a database keeps of the plans that applied', () => {
  beforeEach(clean);

  it('the record is made on first contact, and a database that has none answers nothing', async () => {
    expect(await engine.recorded(on, 'm_entries')).toBeUndefined();
    const made = await sql<{ n: string }>`
      select count(*) as n from information_schema.tables
      where table_schema = 'public' and table_name = 'wilanis_migrations'
    `.execute(db());
    expect(Number((made as { rows: { n: string }[] }).rows[0]?.n)).toBe(1);
  });

  it('a create applied is a table, and a record saying what the table now is', async () => {
    const create: Step = { do: 'create', target: 'm_entries', says: 'create collection m_entries' };
    const applied = await apply([create], { m_entries: ENTRIES });
    expect(applied?.targets).toEqual(['m_entries']);
    expect(applied?.by).toBe('rfontes@build-1');
    expect(await engine.recorded(on, 'm_entries')).toEqual(ENTRIES);
  });

  it('inspect reads the catalog back as a declaration: the key, the columns and the constraints', async () => {
    // the plan the planner writes for a collection nothing has recorded, not a create with the guarantee
    // applied after it as a second plan -- a second plan would hide a create that recorded what it never made
    await apply(planFor({ m_entries: ENTRIES }), { m_entries: ENTRIES });
    const found = await engine.inspect(on, 'm_entries');
    expect(found?.key).toBe('id');
    expect(found?.fields.ua).toEqual({ type: 'string', required: false });
    expect(found?.fields.url).toEqual({ type: 'string', required: true });
    expect(found?.unique).toEqual([['url', 'method']]);
  });

  it('a table the catalog has no row for is inspected as nothing at all', async () => {
    expect(await engine.inspect(on, 'm_entries')).toBeUndefined();
  });

  it('a column is renamed and keeps its values, and the record follows', async () => {
    await apply([{ do: 'create', target: 'm_entries', says: 'create collection m_entries' }], { m_entries: ENTRIES });
    await sql`insert into public.m_entries (id, url, method, ua) values ('1', '/a', 'GET', 'curl')`.execute(db());
    const renamed: Declared = {
      ...ENTRIES,
      fields: { ...ENTRIES.fields, agent: { type: 'string', required: false } },
    };
    delete renamed.fields.ua;
    await apply([{ do: 'rename', target: 'm_entries', at: 'agent', from: 'ua', says: 'rename ua → agent' }], {
      m_entries: renamed,
    });
    const rows = (await sql<{ agent: string }>`select agent from public.m_entries`.execute(db())) as {
      rows: { agent: string }[];
    };
    expect(rows.rows[0]?.agent).toBe('curl');
    expect((await engine.recorded(on, 'm_entries'))?.fields.agent).toBeDefined();
  });

  it('an added column with a default fills the rows already there, and holds no default afterwards', async () => {
    await apply([{ do: 'create', target: 'm_entries', says: 'create collection m_entries' }], { m_entries: ENTRIES });
    await sql`insert into public.m_entries (id, url, method) values ('1', '/a', 'GET')`.execute(db());
    const withNote: Declared = { ...ENTRIES, fields: { ...ENTRIES.fields, note: { type: 'string', required: true } } };
    await apply([{ do: 'add', target: 'm_entries', at: 'note', default: 'none', says: 'add note  string, required' }], {
      m_entries: withNote,
    });
    const rows = (await sql<{ note: string }>`select note from public.m_entries`.execute(db())) as {
      rows: { note: string }[];
    };
    expect(rows.rows[0]?.note).toBe('none');
    const held = (await sql<{ column_default: string | null }>`
      select column_default from information_schema.columns
      where table_schema = 'public' and table_name = 'm_entries' and column_name = 'note'
    `.execute(db())) as { rows: { column_default: string | null }[] };
    expect(held.rows[0]?.column_default).toBeNull();
  });
});

describe.skipIf(!url)('the counts that decide what a step costs', () => {
  beforeEach(async () => {
    await clean();
    await apply([{ do: 'create', target: 'm_entries', says: 'create collection m_entries' }], { m_entries: ENTRIES });
  });

  it('a drop counts every row the collection holds', async () => {
    await sql`insert into public.m_entries (id, url, method) values ('1', '/a', 'GET'), ('2', '/b', 'GET')`.execute(
      db(),
    );
    const step: Step = { do: 'drop', target: 'm_entries', says: 'drop collection m_entries' };
    expect(await engine.rows(on, step)).toBe(2);
  });

  it('a remove counts the rows that hold a value, and a column empty everywhere counts nothing', async () => {
    await sql`insert into public.m_entries (id, url, method, ua) values ('1', '/a', 'GET', 'curl'), ('2', '/b', 'GET', null)`.execute(
      db(),
    );
    const step: Step = { do: 'remove', target: 'm_entries', at: 'ua', says: 'remove ua' };
    expect(await engine.rows(on, step)).toBe(1);
  });

  it('a unique counts every row of every group that repeats it, not the rows above the first', async () => {
    await sql`insert into public.m_entries (id, url, method) values ('1', '/a', 'GET'), ('2', '/a', 'GET'), ('3', '/a', 'GET'), ('4', '/b', 'GET')`.execute(
      db(),
    );
    const step: Step = { do: 'unique', target: 'm_entries', at: 'url', over: ['url'], says: 'unique   [url]' };
    expect(await engine.rows(on, step)).toBe(3);
  });

  it('a require counts the rows that leave the column empty', async () => {
    await sql`insert into public.m_entries (id, url, method, ua) values ('1', '/a', 'GET', 'curl'), ('2', '/b', 'GET', null)`.execute(
      db(),
    );
    const step: Step = { do: 'require', target: 'm_entries', at: 'ua', says: 'require ua' };
    expect(await engine.rows(on, step)).toBe(1);
  });

  it('a retype counts the values no cast would carry, and none where every value reads as the other type', async () => {
    await sql`insert into public.m_entries (id, url, method) values ('1', '1', 'GET'), ('2', 'two', 'GET')`.execute(
      db(),
    );
    const step: Step = {
      do: 'retype',
      target: 'm_entries',
      at: 'url',
      was: 'string',
      becomes: 'number',
      says: 'retype url  string → number',
    };
    expect(await engine.rows(on, step)).toBe(1);
    const widening: Step = { ...step, was: 'number', becomes: 'string', says: 'retype url  number → string' };
    expect(await engine.rows(on, widening)).toBe(0);
  });

  it('a refs counts the rows pointing at no record of the other collection', async () => {
    await apply([{ do: 'create', target: 'm_notes', says: 'create collection m_notes' }], {
      m_notes: {
        key: 'id',
        fields: { id: { type: 'string', required: true }, entryId: { type: 'string', required: false } },
        unique: [],
        refs: {},
      },
    });
    await sql`insert into public.m_entries (id, url, method) values ('1', '/a', 'GET')`.execute(db());
    await sql`insert into public.m_notes (id, entryid) values ('a', '1'), ('b', 'gone'), ('c', null)`.execute(db());
    const step: Step = { do: 'ref', target: 'm_notes', at: 'entryId', to: 'm_entries', says: 'ref entryId' };
    expect(await engine.rows(on, step)).toBe(1);
  });
});

describe.skipIf(!url)('one plan, one transaction', () => {
  beforeEach(async () => {
    await clean();
    await apply([{ do: 'create', target: 'm_entries', says: 'create collection m_entries' }], { m_entries: ENTRIES });
    await sql`insert into public.m_entries (id, url, method) values ('1', '/a', 'GET'), ('2', '/a', 'GET')`.execute(
      db(),
    );
  });

  it('a step that fails half way leaves the table and the record exactly as they were', async () => {
    const before = await engine.recorded(on, 'm_entries');
    const steps: Step[] = [
      { do: 'add', target: 'm_entries', at: 'note', says: 'add note  string, optional' },
      // two rows already repeat this url, so the constraint cannot be created and the whole plan rolls back
      { do: 'unique', target: 'm_entries', at: 'url', over: ['url'], says: 'unique   [url]' },
    ];
    const withNote: Declared = { ...ENTRIES, fields: { ...ENTRIES.fields, note: { type: 'string', required: false } } };
    await expect(apply(steps, { m_entries: withNote })).rejects.toThrow();
    const found = await engine.inspect(on, 'm_entries');
    expect(found?.fields.note).toBeUndefined();
    expect(await engine.recorded(on, 'm_entries')).toEqual(before);
  });

  it('history reads back what applied, latest first, with who ran it and what it did', async () => {
    const withNote: Declared = { ...ENTRIES, fields: { ...ENTRIES.fields, note: { type: 'string', required: false } } };
    await apply([{ do: 'add', target: 'm_entries', at: 'note', says: 'add note  string, optional' }], {
      m_entries: withNote,
    });
    const history = await engine.history(on);
    expect(history).toHaveLength(2);
    expect(history[0]?.targets).toEqual(['m_entries']);
    expect(history[0]?.steps?.m_entries).toEqual(['add note  string, optional']);
    expect(history[0]?.by).toBe('rfontes@build-1');
    expect(history[0]?.tree).toBe('monitor');
    expect(history[1]?.steps?.m_entries).toEqual(['create collection m_entries']);
    expect(history[0]?.id).toBeGreaterThan(history[1]?.id ?? 0);
  });

  it('a dropped collection records a null declaration, so it reads as dropped and not as never recorded', async () => {
    await apply([{ do: 'drop', target: 'm_entries', says: 'drop collection m_entries' }], { m_entries: null });
    expect(await engine.recorded(on, 'm_entries')).toBeUndefined();
    expect(await engine.inspect(on, 'm_entries')).toBeUndefined();
    const history = await engine.history(on);
    expect(history[0]?.steps?.m_entries).toEqual(['drop collection m_entries']);
  });

  it('a renamed collection leaves its old name recorded as gone, so the record answers for one name only', async () => {
    await apply(
      [
        {
          do: 'renameCollection',
          target: 'm_drafts',
          from: 'm_entries',
          says: 'rename collection m_entries → m_drafts',
        },
      ],
      { m_drafts: ENTRIES },
    );
    expect(await engine.recorded(on, 'm_drafts')).toEqual(ENTRIES);
    expect(await engine.recorded(on, 'm_entries')).toBeUndefined();
    expect(await engine.inspect(on, 'm_drafts')).toBeDefined();
  });

  it('a plan with nothing to do writes no row at all', async () => {
    const before = (await engine.history(on)).length;
    expect(await apply([], {})).toBeUndefined();
    expect((await engine.history(on)).length).toBe(before);
  });
});

/**
 * The record is what every later plan trusts, so what it says and what the catalog holds have to be the same
 * thing. Each case here applies a plan and then reads both back: a difference between them is a drift no
 * later plan can see, because the next plan compares the record with the tree and never the catalog.
 */
describe.skipIf(!url)('the record and the catalog say the same thing', () => {
  beforeEach(clean);

  it('a fresh create gets the uniques and the refs the record claims, not the columns alone', async () => {
    const declared = { m_entries: ENTRIES, m_notes: NOTES };
    const steps = planFor(declared);
    // the create makes the columns and the key; every guarantee is its own step, and a ref follows the create
    // of the table it points at, which is what an inline constraint could not order
    expect(steps.map(step => `${step.do} ${step.target}`)).toEqual([
      'create m_entries',
      'unique m_entries',
      'create m_notes',
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
    await sql`insert into public.m_entries (id, url, method) values ('1', '/a', 'GET')`.execute(db());
    await expect(
      sql`insert into public.m_entries (id, url, method) values ('2', '/a', 'GET')`.execute(db()),
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
      sql`insert into public.m_entries (id, url, method) values ('1', '/a', 'GET')`.execute(db()),
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
