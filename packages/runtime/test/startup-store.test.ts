import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import { loadTree, type PluginModule, schemaRef, schemaUrl } from '@wilanis/core';
import storage, {
  type Applied,
  type Declared,
  type Engine,
  engines,
  type On,
  type Step,
} from '@wilanis/plugin-storage';
import { describe, expect, it } from 'vitest';
import { BUILTIN_PLUGINS, start } from '../src/index.js';
import { docsDir } from './example-harness.js';

/**
 * A `drift` stops the start. RFC 0003 draws the line that makes this worth its own test: a constraint a graph
 * could route on is answered as a flag, but drift is not a graph's outcome at all -- `ensure` refuses to
 * change what is already there, and the tree stops rather than serving over a database that is not what the
 * store declares. The port never opens, the way it never opens over an unreachable one.
 *
 * Since RFC 0017 step 5 the judgement is the planner's: `ensure` asks the engine what it has recorded and what
 * its catalog holds, plans the difference, counts and classes it, and applies only a plan that is additive
 * throughout. So the engine here answers the migration half of the contract, and each case says what the
 * record holds -- which is the one thing that decides whether the tree starts.
 */
describe('a startup step that prepares a store', () => {
  const Kind = '@drifty/drifty.connection-kind.json';
  const Store = '@features/keep/data/entries.store.json';

  /** What the fake engine's record holds for a collection, how many rows it has, and what a plan did to it. */
  interface Keeps {
    recorded?: Record<string, Declared>;
    rows?: number;
    applied: Step[][];
    /** every collection `rows` was asked to count in, so a case can say what was never asked about */
    counted?: string[];
  }

  /**
   * An engine whose record is whatever the case says it is, whose catalog is empty, and which applies a plan
   * by noting it. It keeps nothing: what is under test is what `ensure` makes of the five answers, not how any
   * one engine keeps records.
   *
   * `rows` throws for a collection the record has never seen, the way a real database does: there is no table
   * to count in, and asking is an error rather than an answer of zero. A fake that answers zero regardless
   * hides the one fault a fresh database has -- `ensure` counting rows for the guarantees that follow its own
   * `create` -- so this one refuses to be that fake.
   */
  const engineThat = (keeps: Keeps): Engine =>
    ({
      async recorded(_on: On, collection: string) {
        return keeps.recorded?.[collection];
      },
      async inspect() {
        return undefined;
      },
      async rows(_on: On, step: Step) {
        keeps.counted?.push(step.target);
        if (!keeps.recorded?.[step.target]) throw new Error(`relation "${step.target}" does not exist`);
        return keeps.rows ?? 0;
      },
      async apply(_on: On, steps: Step[]): Promise<Applied> {
        keeps.applied.push(steps);
        return {
          id: keeps.applied.length,
          appliedAt: '2026-09-16T00:00:00.000Z',
          by: 'a test',
          tree: 'keeper',
          connection: '@connections/records.connection.json',
          targets: [...new Set(steps.map(step => step.target))],
        };
      },
      async history() {
        return [];
      },
      attempts() {
        return true;
      },
    }) as unknown as Engine;

  /** A tree whose first startup step prepares a store through a domain port, and whose second listens. */
  const tree = (keeps: Keeps, collection: Record<string, unknown> = {}) => {
    const calls: string[] = [];
    const drifty: PluginModule = {
      root: '@drifty',
      docs: docsDir({
        'plugin.json': {
          $schema: schemaRef('plugin'),
          description: 'an engine that keeps nothing, so a test can say what ensure did',
          grants: { connectionKinds: [Kind] },
        },
        'drifty.connection-kind.json': {
          $schema: schemaRef('connection-kind'),
          description: 'a connection reaching an engine that exists only while a test runs',
          settings: { fields: {} },
          storage: true,
        },
      }),
      handlers: {},
      async postLoad(ctx) {
        engines(ctx.env).register(ctx.scope.canon(Kind), engineThat(keeps));
      },
    };
    const server: PluginModule = {
      root: '@listener',
      docs: docsDir({
        'plugin.json': {
          $schema: schemaRef('plugin'),
          description: 'the listener this tree may open',
          grants: { ports: ['@listener/server.port.json'] },
        },
        'server.port.json': {
          $schema: schemaRef('port'),
          description: 'the listener this tree may open',
          operations: { listen: { description: 'answer requests until the process stops', holds: true } },
        },
      }),
      handlers: {
        '@listener/server.port.json#listen': async ({ ctx }: any) => {
          calls.push('listening');
          ctx.env.hold({ label: 'fake listener', stop: async () => {} });
          return undefined;
        },
      },
    };

    const dir = mkdtempSync(join(tmpdir(), 'wilanis-drift-'));
    mkdirSync(join(dir, 'features/keep/domain'), { recursive: true });
    mkdirSync(join(dir, 'features/keep/data'), { recursive: true });
    mkdirSync(join(dir, 'connections'), { recursive: true });
    const put = (rel: string, doc: unknown) => writeFileSync(join(dir, rel), JSON.stringify(doc));

    put('project.json', {
      $schema: schemaUrl('project'),
      name: 'keeper',
      description: 'a tree that prepares its store before it serves',
      plugins: [{ use: '@std' }, { use: '@storage' }, { use: '@drifty' }, { use: '@listener' }],
      startup: [
        { run: '@features/keep/domain/keeping.port.json#prepare', required: true },
        { run: '@listener/server.port.json#listen' },
      ],
    });
    put('connections/records.connection.json', {
      $schema: schemaRef('connection'),
      description: 'where the records live',
      kind: Kind,
      settings: {},
    });
    put('features/keep/feature.json', {
      $schema: schemaRef('feature'),
      description: 'what the tree keeps',
      effects: ['@storage/storage.port.json#ensure'],
    });
    put('features/keep/domain/Entry.shape.json', {
      $schema: schemaRef('shape'),
      description: 'one observed call',
      layer: 'core',
      fields: { id: { type: 'string' }, url: { type: 'string' } },
    });
    put('features/keep/domain/Made.shape.json', {
      $schema: schemaRef('shape'),
      description: 'what preparing the store made',
      layer: 'core',
      fields: { collections: { type: 'number' }, columns: { type: 'number' }, constraints: { type: 'number' } },
    });
    put('features/keep/domain/keeping.port.json', {
      $schema: schemaRef('port'),
      description: 'what the tree needs of its storage before it serves',
      operations: {
        prepare: {
          description: 'Make the store ready to answer, once, before anything is served.',
          returns: '@features/keep/domain/Made.shape.json',
        },
      },
    });
    put('features/keep/data/entries.store.json', {
      $schema: schemaRef('store'),
      description: 'the entries kept so far',
      connection: '@connections/records.connection.json',
      collections: { entries: { of: '@features/keep/domain/Entry.shape.json', key: 'id', ...collection } },
    });
    put('features/keep/data/keeping.binding.json', {
      $schema: schemaRef('binding'),
      description: 'prepare delegates to the storage port',
      port: '@features/keep/domain/keeping.port.json',
      operations: { prepare: { run: '@storage/storage.port.json#ensure', in: { store: Store } } },
    });

    const plugins = { ...BUILTIN_PLUGINS, '@storage': storage, '@drifty': drifty, '@listener': server };
    return { dir, calls, plugins };
  };

  /** A record that holds the collection as the shape declares it: nothing to plan, so nothing to apply. */
  const asDeclared: Record<string, Declared> = {
    entries: {
      key: 'id',
      fields: { id: { type: 'string', required: true }, url: { type: 'string', required: true } },
      unique: [],
      refs: {},
    },
  };

  it('a drift stops the start, and the port never opens', async () => {
    // the record holds `url` as a number and the shape says a string, so the plan is a `retype` -- destructive
    // by the Guide table, and nothing a startup step will do on its own
    const keeps: Keeps = {
      recorded: {
        entries: {
          ...asDeclared.entries,
          fields: { ...asDeclared.entries.fields, url: { type: 'number', required: true } },
        },
      },
      applied: [],
    };
    const { dir, calls, plugins } = tree(keeps);
    const loaded = loadTree(dir, plugins);
    expect(checkTree(loaded).format()).toBe('');
    await expect(start(loaded, { log: () => {} })).rejects.toThrow(/drift: the store declares changes/);
    expect(keeps.applied).toEqual([]);
    expect(calls).not.toContain('listening');
    rmSync(dir, { recursive: true, force: true });
  });

  it('a record behind the shape stops the start, with the step lines and the hint', async () => {
    // the record holds a `href` the shape no longer declares and a `url` it now does. Without a `renamed`
    // mark saying the one became the other, that is an `add` and a `remove` over a table of 4 rows, and both
    // cost data: the added column is required with nothing to put in it, and the removed one holds values.
    // Destructive is `wilanis migrate`'s to apply under an operator's eye and never a startup step's, so what
    // the refusal has to carry is the steps, one per line, and the command that would apply them.
    //
    // The same record with `"renamed": { "url": "href" }` on the collection plans one `rename` instead:
    // transformative, so it is refused here too, and by the same lines. That mark is #234's to add to the
    // schema, and the loader drops a store document carrying one until it lands.
    const keeps: Keeps = {
      recorded: {
        entries: {
          key: 'id',
          fields: { id: { type: 'string', required: true }, href: { type: 'string', required: true } },
          unique: [],
          refs: {},
        },
      },
      rows: 4,
      applied: [],
    };
    const { dir, calls, plugins } = tree(keeps);
    const loaded = loadTree(dir, plugins);
    expect(checkTree(loaded).format()).toBe('');
    const failed = await start(loaded, { log: () => {} }).catch((error: Error) => error.message);
    expect(failed).toMatch(/drift: the store declares changes this startup step will not make/);
    // required with no default, and 4 rows already there with nothing to put in it: the rows are what it costs
    expect(failed).toMatch(/add url {2}string, required {2}\(destructive\)/);
    expect(failed).toMatch(/remove href {2}\(destructive\)/);
    // the hint names the tree's own directory, read off `env.serving`: a handler has no `env.root` to read,
    // so a hint that named one would print `wilanis migrate .` wherever the operator happened to be standing
    expect(failed).toContain(`hint: run wilanis migrate ${dir} --profile `);
    expect(failed).toMatch(/to see the whole plan and apply it/);
    expect(keeps.applied).toEqual([]);
    expect(calls).not.toContain('listening');
    rmSync(dir, { recursive: true, force: true });
  });

  it('a store that is ready lets the tree serve, and nothing is applied to it', async () => {
    const keeps: Keeps = { recorded: asDeclared, applied: [] };
    const { dir, calls, plugins } = tree(keeps);
    const loaded = loadTree(dir, plugins);
    const { stop } = await start(loaded, { log: () => {} });
    expect(keeps.applied).toEqual([]);
    expect(calls).toContain('listening');
    await stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a store the record has never seen is created, and what that made is counted', async () => {
    const keeps: Keeps = { applied: [] };
    const { dir, calls, plugins } = tree(keeps);
    const loaded = loadTree(dir, plugins);
    const { stop } = await start(loaded, { log: () => {} });
    expect(keeps.applied.map(steps => steps.map(step => step.says))).toEqual([['create collection entries']]);
    expect(calls).toContain('listening');
    await stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a fresh database is never asked to count rows in a table the same plan is about to create', async () => {
    // the fault this pins: a collection the record has never seen plans a `create`, and the guarantees the
    // store declares follow it as steps of their own. A `unique` is a step the Guide table classes by a count,
    // so asking the engine for one here asks a database to count rows in a table that does not exist yet --
    // which is not zero, it is `relation "entries" does not exist`, and the whole start fails on a database
    // that had nothing wrong with it. The engine above throws exactly as PostgreSQL does, so this case fails
    // loudly if `ensure` ever asks again.
    const keeps: Keeps = { applied: [], counted: [] };
    const { dir, calls, plugins } = tree(keeps, { unique: [['url']] });
    const loaded = loadTree(dir, plugins);
    expect(checkTree(loaded).format()).toBe('');
    const { stop } = await start(loaded, { log: () => {} });
    expect(keeps.counted).toEqual([]);
    expect(keeps.applied.map(steps => steps.map(step => step.says))).toEqual([
      ['create collection entries', 'unique   [url]'],
    ]);
    expect(calls).toContain('listening');
    await stop();
    rmSync(dir, { recursive: true, force: true });
  });
});
