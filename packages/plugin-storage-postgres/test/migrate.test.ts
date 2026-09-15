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
 * Whether the record and the catalog then agree is `catalog.test.ts`; the connection, the collections and the
 * helpers both drive are `migrating.ts`.
 *
 * Skipped without `WILANIS_TEST_POSTGRES_URL`; see `engine.test.ts` for the container to run it against.
 */
import type { Declared, Step } from '@wilanis/plugin-storage';
import { sql } from 'kysely';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePools } from '../src/pool.js';
import { driving, ENTRIES, engine, planFor, url } from './migrating.js';

// a schema of this suite's own: `catalog.test.ts` drives the same collections, and the two files run at once
const { on, schema, db, clean, apply } = driving('migrate_cases');

afterAll(async () => {
  if (url) await closePools();
});

describe.skipIf(!url)('the record a database keeps of the plans that applied', () => {
  beforeEach(clean);

  it('the record is made on first contact, and a database that has none answers nothing', async () => {
    expect(await engine.recorded(on, 'm_entries')).toBeUndefined();
    const made = await sql<{ n: string }>`
      select count(*) as n from information_schema.tables
      where table_schema = ${schema} and table_name = 'wilanis_migrations'
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
    await sql`insert into ${sql.ref(schema)}.m_entries (id, url, method, ua) values ('1', '/a', 'GET', 'curl')`.execute(
      db(),
    );
    const renamed: Declared = {
      ...ENTRIES,
      fields: { ...ENTRIES.fields, agent: { type: 'string', required: false } },
    };
    delete renamed.fields.ua;
    await apply([{ do: 'rename', target: 'm_entries', at: 'agent', from: 'ua', says: 'rename ua → agent' }], {
      m_entries: renamed,
    });
    const rows = (await sql<{ agent: string }>`select agent from ${sql.ref(schema)}.m_entries`.execute(db())) as {
      rows: { agent: string }[];
    };
    expect(rows.rows[0]?.agent).toBe('curl');
    expect((await engine.recorded(on, 'm_entries'))?.fields.agent).toBeDefined();
  });

  it('an added column with a default fills the rows already there, and holds no default afterwards', async () => {
    await apply([{ do: 'create', target: 'm_entries', says: 'create collection m_entries' }], { m_entries: ENTRIES });
    await sql`insert into ${sql.ref(schema)}.m_entries (id, url, method) values ('1', '/a', 'GET')`.execute(db());
    const withNote: Declared = { ...ENTRIES, fields: { ...ENTRIES.fields, note: { type: 'string', required: true } } };
    await apply([{ do: 'add', target: 'm_entries', at: 'note', default: 'none', says: 'add note  string, required' }], {
      m_entries: withNote,
    });
    const rows = (await sql<{ note: string }>`select note from ${sql.ref(schema)}.m_entries`.execute(db())) as {
      rows: { note: string }[];
    };
    expect(rows.rows[0]?.note).toBe('none');
    const held = (await sql<{ column_default: string | null }>`
      select column_default from information_schema.columns
      where table_schema = ${schema} and table_name = 'm_entries' and column_name = 'note'
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
    await sql`insert into ${sql.ref(schema)}.m_entries (id, url, method) values ('1', '/a', 'GET'), ('2', '/b', 'GET')`.execute(
      db(),
    );
    const step: Step = { do: 'drop', target: 'm_entries', says: 'drop collection m_entries' };
    expect(await engine.rows(on, step)).toBe(2);
  });

  it('a remove counts the rows that hold a value, and a column empty everywhere counts nothing', async () => {
    await sql`insert into ${sql.ref(schema)}.m_entries (id, url, method, ua) values ('1', '/a', 'GET', 'curl'), ('2', '/b', 'GET', null)`.execute(
      db(),
    );
    const step: Step = { do: 'remove', target: 'm_entries', at: 'ua', says: 'remove ua' };
    expect(await engine.rows(on, step)).toBe(1);
  });

  it('a unique counts every row of every group that repeats it, not the rows above the first', async () => {
    await sql`insert into ${sql.ref(schema)}.m_entries (id, url, method) values ('1', '/a', 'GET'), ('2', '/a', 'GET'), ('3', '/a', 'GET'), ('4', '/b', 'GET')`.execute(
      db(),
    );
    const step: Step = { do: 'unique', target: 'm_entries', at: 'url', over: ['url'], says: 'unique   [url]' };
    expect(await engine.rows(on, step)).toBe(3);
  });

  it('a require counts the rows that leave the column empty', async () => {
    await sql`insert into ${sql.ref(schema)}.m_entries (id, url, method, ua) values ('1', '/a', 'GET', 'curl'), ('2', '/b', 'GET', null)`.execute(
      db(),
    );
    const step: Step = { do: 'require', target: 'm_entries', at: 'ua', says: 'require ua' };
    expect(await engine.rows(on, step)).toBe(1);
  });

  it('a retype counts the values no cast would carry, and none where every value reads as the other type', async () => {
    await sql`insert into ${sql.ref(schema)}.m_entries (id, url, method) values ('1', '1', 'GET'), ('2', 'two', 'GET')`.execute(
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
    await sql`insert into ${sql.ref(schema)}.m_entries (id, url, method) values ('1', '/a', 'GET')`.execute(db());
    await sql`insert into ${sql.ref(schema)}.m_notes (id, entryid) values ('a', '1'), ('b', 'gone'), ('c', null)`.execute(
      db(),
    );
    const step: Step = { do: 'ref', target: 'm_notes', at: 'entryId', to: 'm_entries', says: 'ref entryId' };
    expect(await engine.rows(on, step)).toBe(1);
  });
});

describe.skipIf(!url)('one plan, one transaction', () => {
  beforeEach(async () => {
    await clean();
    await apply([{ do: 'create', target: 'm_entries', says: 'create collection m_entries' }], { m_entries: ENTRIES });
    await sql`insert into ${sql.ref(schema)}.m_entries (id, url, method) values ('1', '/a', 'GET'), ('2', '/a', 'GET')`.execute(
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
