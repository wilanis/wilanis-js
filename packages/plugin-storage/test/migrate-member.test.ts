/**
 * `@storage`'s `migrate` member, over a fake engine and a real tree (RFC 0017, step 7). What `migrate.test.ts`
 * beside this pins is the five answers an engine gives; what these pin is what the member makes of them: which
 * connections are planned and in what order, which are refused and why, and what reaches an engine's `apply`.
 *
 * The claim worth pinning is that a connection is judged on its own. A plan is one transaction per connection,
 * so a step refused on one must not stop the other from applying -- the operator reads two plans and gets the
 * one they could have.
 */
import { describe, expect, it } from 'vitest';
import type { Declared } from '../src/index.js';
import { applyStores, historyOfStores, planStores } from '../src/index.js';
import { context, declares, ENTRIES, fake, NOTES, RENAMED_SHAPE, said } from './migrating.js';

/** `entries` as the record holds it once a create applied: an id, a url and an optional agent. */
const RECORDED: Declared = {
  key: 'id',
  fields: {
    id: { type: 'string', required: true },
    url: { type: 'string', required: true },
    ua: { type: 'string', required: false },
  },
  unique: [],
  refs: {},
};

describe('what the member plans, connection by connection', () => {
  it('a tree with two connections is planned as two targets, in canonical-path order', async () => {
    const { ctx, register } = context();
    register(fake({}).engine);
    const plan = await planStores(ctx);
    expect(plan.targets.map(one => one.connection)).toEqual([ENTRIES, NOTES]);
    // nothing was ever recorded on either, so each is opened with a create of its own collection
    expect(said(plan.targets[0].steps)).toEqual(['create create collection entries']);
    expect(said(plan.targets[1].steps)).toEqual(['create create collection notes']);
    expect(plan.targets[0].engine).toContain('fake.connection-kind.json');
  });

  it('a connection whose record already says what the tree does is planned nothing at all', async () => {
    const { ctx, register } = context();
    register(fake({ [ENTRIES]: { recorded: { entries: RECORDED }, catalog: { entries: RECORDED } } }).engine);
    const plan = await planStores(ctx);
    expect(plan.targets[0].steps).toEqual([]);
    expect(plan.targets[0].drifted).toBeUndefined();
  });

  it('an engine that keeps nothing between processes is skipped, with the line saying why', async () => {
    const { ctx, register } = context();
    register(fake({}, { keeps: false }).engine);
    const plan = await planStores(ctx);
    expect(plan.targets).toHaveLength(2);
    for (const target of plan.targets) {
      expect(target.skipped).toBe('nothing is kept between processes, so there is nothing to migrate');
      expect(target.steps).toEqual([]);
    }
  });

  it('a table the record has never seen is adopted, not created, and the field steps follow it', async () => {
    const { ctx, register } = context();
    register(fake({ [ENTRIES]: { found: { entries: RECORDED } } }).engine);
    const plan = await planStores(ctx);
    expect(plan.targets[0].steps[0]).toMatchObject({ do: 'adopt', target: 'entries', class: 'additive' });
  });

  it('a count is never taken against a collection this plan creates itself', async () => {
    const { ctx, register } = context({ entries: { entries: declares({ unique: [['url']] }) } });
    const { engine, asked } = fake({});
    register(engine);
    const plan = await planStores(ctx);
    // the unique follows the create, and asking a database to count rows of a table it has not made yet is an
    // error and not zero rows: the fake throws exactly as PostgreSQL would, so a plan that asked would fail here
    expect(said(plan.targets[0].steps)).toEqual(['create create collection entries', 'unique unique   [url]']);
    expect(asked.counted).toEqual([]);
  });
});

describe('what a refused step does to its connection, and to the other one', () => {
  it('a refused step refuses its own connection and leaves the other planned and applied', async () => {
    // `entries` is re-keyed, which no count can make possible; `notes` is untouched and applies
    const { ctx, register } = context({ entries: { entries: declares({ key: 'url' }) } });
    const { engine, asked } = fake({
      [ENTRIES]: { recorded: { entries: RECORDED }, catalog: { entries: RECORDED }, rows: { entries: 3 } },
    });
    register(engine);
    const plan = await planStores(ctx);
    const rekey = plan.targets[0].steps.find(step => step.do === 'rekey');
    expect(rekey?.refused).toContain('re-keying is a new collection');
    // the runtime is what refuses a target; this member applies whichever targets it is handed back
    await applyStores(ctx, { targets: [plan.targets[1]] });
    expect(asked.applied.map(one => one.on)).toEqual([NOTES]);
  });

  it('a destructive step is planned with its class and its cost, for the operator to allow or not', async () => {
    // the record holds a collection the tree no longer declares, and it has rows: dropping it costs them
    const { ctx, register } = context();
    register(
      fake({
        [ENTRIES]: {
          recorded: { entries: RECORDED, gone: RECORDED },
          catalog: { entries: RECORDED, gone: RECORDED },
          rows: { gone: 17 },
        },
      }).engine,
    );
    const plan = await planStores(ctx);
    const drop = plan.targets[0].steps.find(step => step.do === 'drop');
    expect(drop).toMatchObject({ target: 'gone', class: 'destructive', rows: 17 });
    expect(drop?.loses).toBe('every row of gone');
  });

  it('the same step on an empty collection costs nothing, so it is transformative and applies under --apply', async () => {
    const { ctx, register } = context();
    register(
      fake({
        [ENTRIES]: { recorded: { entries: RECORDED, gone: RECORDED }, catalog: { entries: RECORDED, gone: RECORDED } },
      }).engine,
    );
    const plan = await planStores(ctx);
    expect(plan.targets[0].steps.find(step => step.do === 'drop')).toMatchObject({ class: 'transformative' });
  });
});

describe('what reaches an engine when the plan is applied', () => {
  it('apply hands the engine the steps it planned, the record they leave, and who ran them', async () => {
    const { ctx, register } = context();
    const { engine, asked } = fake({});
    register(engine);
    const plan = await planStores(ctx);
    const applied = await applyStores(ctx, plan);
    expect(asked.applied.map(one => one.on)).toEqual([ENTRIES, NOTES]);
    expect(asked.applied[0].steps.map(step => step.do)).toEqual(['create']);
    expect(Object.keys(asked.applied[0].record)).toEqual(['entries']);
    expect(asked.applied[0].applying.tree).toBe('kept');
    expect(applied.map(one => one.connection)).toEqual([ENTRIES, NOTES]);
  });

  it('a target the runtime kept back never reaches an engine at all', async () => {
    const { ctx, register } = context();
    const { engine, asked } = fake({});
    register(engine);
    const plan = await planStores(ctx);
    await applyStores(ctx, { targets: [plan.targets[1]] });
    expect(asked.applied.map(one => one.on)).toEqual([NOTES]);
  });

  it('a connection with nothing to do is applied nothing, and records nothing', async () => {
    const { ctx, register } = context();
    const { engine, asked } = fake({
      [ENTRIES]: { recorded: { entries: RECORDED }, catalog: { entries: RECORDED } },
      [NOTES]: { recorded: { notes: RECORDED }, catalog: { notes: RECORDED } },
    });
    register(engine);
    const plan = await planStores(ctx);
    expect(await applyStores(ctx, plan)).toEqual([]);
    expect(asked.applied).toEqual([]);
  });
});

describe('a record the database has moved out from under', () => {
  it('a collection the catalog disagrees with drifts its connection, and nothing there is planned', async () => {
    const required: Declared = { ...RECORDED, fields: { ...RECORDED.fields, ua: { type: 'string', required: true } } };
    const { ctx, register } = context();
    register(fake({ [ENTRIES]: { recorded: { entries: RECORDED }, catalog: { entries: required } } }).engine);
    const plan = await planStores(ctx);
    expect(plan.targets[0].steps).toEqual([]);
    expect(plan.targets[0].drifted).toEqual([
      'entries.ua is string, required in the database; the record says string, optional',
    ]);
    // the other connection is judged on its own and is planned as it would have been
    expect(said(plan.targets[1].steps)).toEqual(['create create collection notes']);
  });

  it('--adopt takes the catalog as the record and plans from there, so the connection proceeds', async () => {
    const required: Declared = { ...RECORDED, fields: { ...RECORDED.fields, ua: { type: 'string', required: true } } };
    const { ctx, register } = context({}, { adopt: true });
    register(fake({ [ENTRIES]: { recorded: { entries: RECORDED }, catalog: { entries: required } } }).engine);
    const plan = await planStores(ctx);
    expect(plan.targets[0].drifted).toBeUndefined();
    // the collection joins the record from the database as it stands, and the tree's optional `ua` follows
    expect(said(plan.targets[0].steps)).toEqual([
      'adopt adopt collection entries (from the database as it stands)',
      'relax relax ua',
    ]);
  });

  it('a collection the record holds and the database has no table for is drift too', async () => {
    const { ctx, register } = context();
    register(fake({ [ENTRIES]: { recorded: { entries: RECORDED } } }).engine);
    const plan = await planStores(ctx);
    expect(plan.targets[0].drifted).toEqual(['entries is recorded, and the database holds no such collection']);
  });
});

/** The record once a `renamed` has applied: the record calls the field `agent`, as the tree now does. */
const RENAMED: Declared = {
  ...RECORDED,
  fields: {
    id: { type: 'string', required: true },
    url: { type: 'string', required: true },
    agent: { type: 'string', required: false },
  },
};

describe('a mark that has done its work', () => {
  it('a renamed the record has already answered is a note, never a step and never a refusal', async () => {
    const { ctx, register } = context({
      entries: { entries: { of: RENAMED_SHAPE, key: 'id', renamed: { agent: 'ua' } } },
    });
    register(fake({ [ENTRIES]: { recorded: { entries: RENAMED }, catalog: { entries: RENAMED } } }).engine);
    const plan = await planStores(ctx);
    // a tree is deployed to more than one database and the mark has to survive until the last has moved, so
    // it must not refuse: carried in a step it would stop the connection on every run while it is still right
    expect(plan.targets[0].steps).toEqual([]);
    expect(plan.targets[0].notes?.join('\n')).toContain('renamed.agent has been applied');
    expect(plan.targets[0].notes?.join('\n')).toContain('remove "renamed"');
  });

  it('a connection carrying a stale mark still applies every step beside it', async () => {
    // the rename has applied -- the record calls the field `agent` -- and the store has since declared a
    // unique the record has not got. The mark is a note and the unique is the connection's one step
    const { ctx, register } = context({
      entries: { entries: { of: RENAMED_SHAPE, key: 'id', unique: [['url']], renamed: { agent: 'ua' } } },
    });
    const { engine, asked } = fake({
      [ENTRIES]: { recorded: { entries: RENAMED }, catalog: { entries: RENAMED } },
    });
    register(engine);
    const plan = await planStores(ctx);
    const entries = plan.targets[0];
    expect(entries.steps.map(step => step.do)).toEqual(['unique']);
    expect(entries.steps.every(step => !step.refused)).toBe(true);
    expect(entries.notes?.join('\n')).toContain('renamed.agent has been applied');
    await applyStores(ctx, { targets: [entries] });
    expect(asked.applied.map(one => one.on)).toEqual([ENTRIES]);
    expect(asked.applied[0].steps.map(step => step.do)).toEqual(['unique']);
  });
});

describe('a collection an engine keeps under a name of its own', () => {
  it('a mixed-case collection is one collection, whatever spelling the record answers', async () => {
    // this fake folds as PostgreSQL does, so its history answers `auditlog` for a tree declaring `auditLog`.
    // Reading both as collections would leave one undeclared -- and plan a drop of the live table
    const { ctx, register } = context({ entries: { auditLog: declares() } });
    const { engine, asked } = fake({
      [ENTRIES]: { recorded: { auditLog: RECORDED }, catalog: { auditLog: RECORDED } },
    });
    register(engine);
    const plan = await planStores(ctx);
    const entries = plan.targets[0];
    // no step at all: not a create of `auditLog`, and above all not a drop of `auditlog`
    expect(entries.steps).toEqual([]);
    await applyStores(ctx, { targets: [entries] });
    expect(asked.applied).toEqual([]);
  });
});

describe('what the record says was applied', () => {
  it('history answers every connection that keeps one, and none of the connections that keep nothing', async () => {
    const { ctx, register } = context();
    const { engine } = fake({});
    register(engine);
    await applyStores(ctx, await planStores(ctx));
    const history = await historyOfStores(ctx);
    expect(history.map(one => one.connection).sort()).toEqual([ENTRIES, NOTES]);
    const { ctx: other, register: registerOther } = context();
    registerOther(fake({}, { keeps: false }).engine);
    expect(await historyOfStores(other)).toEqual([]);
  });
});
