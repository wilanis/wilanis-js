/**
 * `wilanis migrate` end to end against a real database (RFC 0017, step 7): the whole path from a store
 * document to an `ALTER TABLE` and back, through the command, the contract, `@storage`'s `migrate` member, the
 * one planner and this engine.
 *
 * What the suites beside this pin is each part alone -- `migrate.test.ts` the five members, `catalog.test.ts`
 * that the record and the catalog agree. What this pins is that the parts join: a plan an operator reads is
 * the plan that applies, a destructive step waits for the flag that names it, a hand-altered table stops the
 * whole connection until `--adopt`, and `--history` reads back what the database itself recorded.
 *
 * Skipped without `WILANIS_TEST_POSTGRES_URL`; see `engine.test.ts` for the container to run it against. The
 * database must be PostgreSQL 16 or later, as the rest of this package's cases need.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadTree, type PluginModule, schemaRef } from '@wilanis/core';
import storage from '@wilanis/plugin-storage';
import { BUILTIN_PLUGINS, type MigrateOptions, migrate } from '@wilanis/runtime';
import { sql } from 'kysely';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from '../src/index.js';
import { closePools } from '../src/pool.js';
import { driving, url } from './migrating.js';

// a schema of this suite's own: every file here drives the same collection names, and they run at once
const { schema, db, clean } = driving('command_cases');

const SECRET = 'WILANIS_TEST_COMMAND_URL';
const CONNECTION = '@connections/records.connection.json';
const PLUGINS: Record<string, PluginModule> = {
  ...BUILTIN_PLUGINS,
  '@storage': storage,
  '@storage-postgres': postgres,
};

afterAll(async () => {
  if (url) await closePools();
});

/** One collection as the store declares it, with whatever marks a case adds. */
type Declares = { of: string; key: string; unique?: string[][]; renamed?: Record<string, string> };

/** What a case varies about the tree: the fields the shape has, and what the store says about the collection. */
interface Tree {
  fields: Record<string, { type: string; required?: boolean }>;
  collection?: Partial<Declares>;
  /** the collection's name, where a case is about the name itself; absent: `c_entries` */
  name?: string;
}

/** The collection a case declares, which is `c_entries` unless the case is about what a name is spelled like. */
const named = (tree: Tree) => tree.name ?? 'c_entries';

/** A tree of one store over one PostgreSQL connection, written where the command can load it. */
function write(tree: Tree): string {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-pg-command-'));
  const docs: Record<string, unknown> = {
    'project.json': {
      $schema: schemaRef('project'),
      name: 'kept',
      description: 'a tree keeping one collection in PostgreSQL',
      plugins: [{ use: '@std' }, { use: '@storage' }, { use: '@storage-postgres' }],
      secrets: { database: SECRET },
    },
    'connections/records.connection.json': {
      $schema: schemaRef('connection'),
      description: 'the database these records live in',
      kind: '@storage-postgres/postgres.connection-kind.json',
      settings: { url: '{{secrets.database}}', schema },
    },
    'features/customers/feature.json': { $schema: schemaRef('feature'), description: 'what the monitor keeps' },
    'features/customers/domain/Customer.shape.json': {
      $schema: schemaRef('shape'),
      description: 'one observed call',
      layer: 'core',
      fields: tree.fields,
    },
    'features/customers/data/customers.store.json': {
      $schema: schemaRef('store'),
      description: 'the entries kept so far',
      connection: CONNECTION,
      collections: {
        [named(tree)]: { of: '@features/customers/domain/Customer.shape.json', key: 'id', ...tree.collection },
      },
    },
  };
  for (const [relative, doc] of Object.entries(docs)) {
    const path = join(dir, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(doc));
  }
  return dir;
}

/** The fields the tree starts from: an id, a url and an optional user agent. */
const FIELDS = {
  id: { type: 'string' },
  url: { type: 'string' },
  ua: { type: 'string', required: false },
};

/** Run the command over a tree written for the case, saying nothing to the terminal. */
async function run(tree: Tree, opts: MigrateOptions = {}) {
  const was = process.env[SECRET];
  process.env[SECRET] = url;
  try {
    return await migrate(loadTree(write(tree), PLUGINS), { log: () => {}, ...opts });
  } finally {
    if (was === undefined) delete process.env[SECRET];
    else process.env[SECRET] = was;
  }
}

/** Every column the database holds for the collection, by name, so a case reads what actually happened. */
async function columns(): Promise<Record<string, { type: string; nullable: string }>> {
  const answer = (await sql<{ column_name: string; data_type: string; is_nullable: string }>`
    select column_name, data_type, is_nullable from information_schema.columns
    where table_schema = ${schema} and table_name = 'c_entries'
  `.execute(db())) as { rows: { column_name: string; data_type: string; is_nullable: string }[] };
  return Object.fromEntries(
    answer.rows.map(row => [row.column_name, { type: row.data_type, nullable: row.is_nullable }]),
  );
}

describe.skipIf(!url)('wilanis migrate, from a store document to a table and back', () => {
  beforeEach(clean);

  it('a fresh database is planned a create, and --apply makes the table and records the migration', async () => {
    const planned = await run({ fields: FIELDS });
    expect(planned.code).toBe(0);
    expect(planned.plan.targets[0].steps.map(step => step.do)).toEqual(['create']);
    expect(planned.applied).toEqual([]);
    expect(await columns()).toEqual({});

    const applied = await run({ fields: FIELDS }, { apply: true });
    expect(applied.code).toBe(0);
    expect(Object.keys(await columns()).sort()).toEqual(['id', 'ua', 'url']);
    expect(applied.applied[0]).toMatchObject({ connection: CONNECTION, targets: ['c_entries'] });
    expect(applied.lines.join('\n')).toContain('recorded as migration');
  });

  it('a shape that gained a field is planned one add, and a second run has nothing left to do', async () => {
    await run({ fields: FIELDS }, { apply: true });
    const gained = { fields: { ...FIELDS, note: { type: 'string', required: false } } };
    const applied = await run(gained, { apply: true });
    expect(applied.plan.targets[0].steps.map(step => `${step.do} ${step.at}`)).toEqual(['add note']);
    expect((await columns()).note).toEqual({ type: 'text', nullable: 'YES' });

    const again = await run(gained);
    expect(again.plan.targets[0].steps).toEqual([]);
    expect(again.lines.join('\n')).toContain('nothing to apply');
  });

  it('a dropped column waits for the flag that names the connection and the collection', async () => {
    await run({ fields: FIELDS }, { apply: true });
    await sql`insert into ${sql.ref(schema)}.c_entries (id, url, ua) values ('1', '/a', 'curl')`.execute(db());
    const gone = { fields: { id: FIELDS.id, url: FIELDS.url } };

    // the column holds a value in a row, so removing it is destructive and the operator has to say so
    const refused = await run(gone, { apply: true });
    expect(refused.code).toBe(1);
    expect(refused.plan.targets[0].steps[0]).toMatchObject({ do: 'remove', at: 'ua', class: 'destructive' });
    expect(refused.lines.join('\n')).toContain(`needs --allow-destructive ${CONNECTION}/c_entries`);
    expect(refused.applied).toEqual([]);
    expect((await columns()).ua).toBeDefined();

    // the flag names the pair, since two connections of one tree may each hold a collection of one name
    const wrong = await run(gone, { apply: true, allowDestructive: ['c_entries'] });
    expect(wrong.code).toBe(1);
    expect((await columns()).ua).toBeDefined();

    const allowed = await run(gone, { apply: true, allowDestructive: [`${CONNECTION}/c_entries`] });
    expect(allowed.code).toBe(0);
    expect((await columns()).ua).toBeUndefined();
  });

  it('a table altered by hand drifts the connection until --adopt takes the database as the record', async () => {
    await run({ fields: FIELDS }, { apply: true });
    await sql`alter table ${sql.ref(schema)}.c_entries alter column ua set not null`.execute(db());

    const drifted = await run({ fields: FIELDS });
    expect(drifted.code).toBe(1);
    expect(drifted.plan.targets[0].steps).toEqual([]);
    expect(drifted.plan.targets[0].drifted?.join('\n')).toContain('c_entries.ua is string, required in the database');

    // --adopt is the operator saying the database is right and the record is behind: the plan proceeds from
    // what the table actually holds, and the tree's own optional `ua` is what it then relaxes back to
    const adopted = await run({ fields: FIELDS }, { adopt: true, apply: true });
    expect(adopted.code).toBe(0);
    expect(adopted.plan.targets[0].steps.map(step => step.do)).toEqual(['adopt', 'relax']);
    expect((await columns()).ua).toEqual({ type: 'text', nullable: 'YES' });
  });

  it('--history reads back every plan the database itself recorded, latest first', async () => {
    await run({ fields: FIELDS }, { apply: true });
    await run({ fields: { ...FIELDS, note: { type: 'string', required: false } } }, { apply: true });

    const history = await run({ fields: { ...FIELDS, note: { type: 'string', required: false } } }, { history: true });
    expect(history.code).toBe(0);
    expect(history.applied).toHaveLength(2);
    expect(history.applied[0].id).toBeGreaterThan(history.applied[1].id);
    expect(history.applied[0].targets).toEqual(['c_entries']);
    expect(history.lines.join('\n')).toContain('migration');
    // a history is what applied, never what a plan would do: no target is planned and nothing is applied
    expect(history.plan.targets).toEqual([]);
  });

  it('a renamed mark renames the column, keeps the values, and says so once the record has answered it', async () => {
    await run({ fields: FIELDS }, { apply: true });
    await sql`insert into ${sql.ref(schema)}.c_entries (id, url, ua) values ('1', '/a', 'curl')`.execute(db());
    const renamed: Tree = {
      fields: { id: FIELDS.id, url: FIELDS.url, agent: { type: 'string', required: false } },
      collection: { renamed: { agent: 'ua' } },
    };

    const applied = await run(renamed, { apply: true });
    expect(applied.plan.targets[0].steps[0]).toMatchObject({ do: 'rename', at: 'agent', class: 'transformative' });
    const kept = (await sql<{ agent: string }>`select agent from ${sql.ref(schema)}.c_entries`.execute(db())) as {
      rows: { agent: string }[];
    };
    expect(kept.rows[0]?.agent).toBe('curl');

    // the record now calls it `agent`, so the mark has done its work and the plan says which edit clears it
    const after = await run(renamed);
    expect(after.plan.targets[0].steps).toEqual([]);
    expect(after.plan.targets[0].notes?.join('\n')).toContain('renamed.agent has been applied');
    expect(after.lines.join('\n')).toContain('remove "renamed"');
    // and it judges nothing: the mark has to survive until the last database has moved, so a run that finds
    // one is a run with nothing to do and not a run that refused
    expect(after.code).toBe(0);
    expect(after.lines.join('\n')).toContain('nothing to apply');
  });

  it('a stale mark leaves every step beside it applying, and the command still exits 0', async () => {
    await run({ fields: FIELDS }, { apply: true });
    const renamed: Tree = {
      fields: { id: FIELDS.id, url: FIELDS.url, agent: { type: 'string', required: false } },
      collection: { renamed: { agent: 'ua' } },
    };
    await run(renamed, { apply: true });

    // the mark has applied and the shape has since gained a field: the note rides beside the add, and the
    // add applies. Carried in a step's `refused` the note would refuse the connection and nothing would
    const gained: Tree = {
      fields: { ...renamed.fields, note: { type: 'string', required: false } },
      collection: renamed.collection,
    };
    const applied = await run(gained, { apply: true });
    expect(applied.code).toBe(0);
    expect(applied.plan.targets[0].steps.map(step => `${step.do} ${step.at}`)).toEqual(['add note']);
    expect(applied.plan.targets[0].notes?.join('\n')).toContain('renamed.agent has been applied');
    expect(applied.applied).toHaveLength(1);
    expect((await columns()).note).toBeDefined();
  });

  it('a collection PostgreSQL folds is one collection: a second plan drops nothing', async () => {
    // Postgres keeps `c_auditLog` as `c_auditlog` and its record answers that name, so a plan reading the
    // record's spelling beside the tree's would call one of them undeclared -- and drop the live table
    const mixed: Tree = { fields: FIELDS, name: 'c_auditLog' };
    const first = await run(mixed, { apply: true });
    expect(first.code).toBe(0);
    expect(first.plan.targets[0].steps.map(step => step.do)).toEqual(['create']);

    const again = await run(mixed);
    expect(again.code).toBe(0);
    expect(again.plan.targets[0].steps).toEqual([]);
    const held = (await sql<{ n: string }>`
      select count(*) as n from information_schema.tables
      where table_schema = ${schema} and table_name = 'c_auditlog'
    `.execute(db())) as { rows: { n: string }[] };
    expect(Number(held.rows[0]?.n)).toBe(1);
  });
});
