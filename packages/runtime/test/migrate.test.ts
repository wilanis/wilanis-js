import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Applied,
  loadTree,
  type MigrateContext,
  type Plan,
  type PlanStep,
  type PluginModule,
  schemaRef,
  schemaUrl,
} from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { BUILTIN_PLUGINS, migrate } from '../src/index.js';
import { docsDir } from './example-harness.js';

describe('wilanis migrate', () => {
  /**
   * A tree whose one plugin grants a `holds` operation a startup step names, and whose `migrate` member
   * answers the plan the test hands it. `calls` records postLoad, the plan, the apply and the teardown, so a
   * test can say what ran and in what order -- and that the startup step never did.
   */
  const tree = (plan: Plan, opts: { history?: Applied[]; noMigrate?: boolean } = {}) => {
    const calls: string[] = [];
    /** What each call of the plugin's migrate member was given, so a test can read the profile and the flags. */
    const seen: MigrateContext[] = [];
    const fake: PluginModule = {
      root: '@fake',
      docs: docsDir({
        'plugin.json': {
          $schema: schemaRef('plugin'),
          description: 'a plugin that keeps state in the world',
          grants: { ports: ['@fake/server.port.json'] },
        },
        'server.port.json': {
          $schema: schemaRef('port'),
          description: 'the listener this tree may open',
          operations: { listen: { description: 'answer requests until the process stops', holds: true } },
        },
      }),
      handlers: {
        '@fake/server.port.json#listen': async () => {
          calls.push('listening');
          return undefined;
        },
      },
      postLoad: async () => {
        calls.push('postLoad');
        return async () => {
          calls.push('postLoadDown');
        };
      },
      migrate: opts.noMigrate
        ? undefined
        : {
            plan: async ctx => {
              calls.push('plan');
              seen.push(ctx);
              return plan;
            },
            apply: async (ctx, applying) => {
              calls.push(`apply:${applying.targets.map(one => one.connection).join(',')}`);
              seen.push(ctx);
              return [
                {
                  id: 4,
                  appliedAt: '2026-09-11T09:14:02Z',
                  by: 'rfontes@build-1',
                  tree: 'boot',
                  connection: applying.targets[0]?.connection ?? '',
                  targets: applying.targets.flatMap(one => one.steps.map(step => step.target)),
                },
              ];
            },
            history: async () => {
              calls.push('history');
              return opts.history ?? [];
            },
          },
    };
    const dir = mkdtempSync(join(tmpdir(), 'wilanis-migrate-'));
    mkdirSync(join(dir, 'features/boot'), { recursive: true });
    const put = (rel: string, doc: unknown) => writeFileSync(join(dir, rel), JSON.stringify(doc));
    put('project.json', {
      $schema: schemaUrl('project'),
      name: 'boot',
      description: 'a tree with state in the world',
      plugins: [{ use: '@std' }, { use: '@fake' }],
      startup: [{ run: '@fake/server.port.json#listen' }],
    });
    put('features/boot/feature.json', { $schema: schemaRef('feature'), description: 'the boot feature' });
    return { dir, calls, seen, plugins: { ...BUILTIN_PLUGINS, '@fake': fake } };
  };

  const step = (over: Partial<PlanStep> = {}): PlanStep => ({
    do: 'add',
    target: 'entries',
    class: 'additive',
    says: 'note  text, optional',
    ...over,
  });
  const target = (steps: PlanStep[], over: Record<string, unknown> = {}) => ({
    connection: '@connections/entries.connection.json',
    engine: 'postgres, granted by @storage-postgres',
    steps,
    ...over,
  });
  const run = (dir: string, plugins: Record<string, PluginModule>, opts = {}) =>
    migrate(loadTree(dir, plugins), { log: () => {}, ...opts });

  it('runs postLoad before the plan and tears it down after, and runs no startup step', async () => {
    const { dir, calls, plugins } = tree({ targets: [target([step()])] });
    const answer = await run(dir, plugins);
    expect(calls).toEqual(['postLoad', 'plan', 'postLoadDown']);
    // `migrate` never builds Served and never runs a startup step: nothing listened
    expect(calls).not.toContain('listening');
    expect(answer.code).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a plugin with no migrate member is asked for nothing, and its postLoad still runs', async () => {
    const { dir, calls, plugins } = tree({ targets: [] }, { noMigrate: true });
    const answer = await run(dir, plugins);
    expect(calls).toEqual(['postLoad', 'postLoadDown']);
    expect(answer.lines).toContain('nothing to apply');
    expect(answer.code).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('prints the plan in columns, and says nothing was applied', async () => {
    const { dir, plugins } = tree({
      targets: [
        target([
          step({ do: 'rename', says: 'ua → agent', class: 'transformative' }),
          step(),
          step({ do: 'drop', target: 'notes', says: 'collection notes  (17 rows)', class: 'destructive', rows: 17 }),
        ]),
      ],
    });
    const answer = await run(dir, plugins);
    const printed = answer.lines.join('\n');
    expect(answer.lines[0]).toBe(
      'plan for @connections/entries.connection.json  (postgres, granted by @storage-postgres)',
    );
    expect(printed).toMatch(/^ {2}entries$/m);
    expect(printed).toMatch(/^ {4}rename {3}ua → agent {34}transformative$/m);
    expect(printed).toMatch(/needs --allow-destructive @connections\/entries.connection.json\/notes/);
    expect(answer.lines.at(-1)).toBe('2 steps would apply; 1 refused. Nothing was applied: run again with --apply.');
    // one destructive step nobody allowed is a step that did not apply
    expect(answer.code).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('an empty plan says so and exits 0', async () => {
    const { dir, plugins } = tree({ targets: [target([])] });
    const answer = await run(dir, plugins);
    expect(answer.lines).toContain('  up to date');
    expect(answer.lines.at(-1)).toBe('nothing to apply');
    expect(answer.code).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('applies when told, and says which migration recorded it', async () => {
    const { dir, calls, plugins } = tree({ targets: [target([step(), step({ do: 'rename', says: 'ua → agent' })])] });
    const answer = await run(dir, plugins, { apply: true });
    expect(calls).toEqual(['postLoad', 'plan', 'apply:@connections/entries.connection.json', 'postLoadDown']);
    expect(answer.lines.join('\n')).toMatch(/additive {8}applied/);
    expect(answer.lines.at(-1)).toBe(
      '2 steps applied in one transaction; recorded as migration 4 (2026-09-11T09:14:02Z).',
    );
    expect(answer.code).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a destructive step applies once the operator names the connection and the target', async () => {
    const { dir, calls, plugins } = tree({
      targets: [target([step({ do: 'drop', target: 'notes', class: 'destructive', says: 'collection notes' })])],
    });
    const allowed = ['@connections/entries.connection.json/notes'];
    const answer = await run(dir, plugins, { apply: true, allowDestructive: allowed });
    expect(calls).toContain('apply:@connections/entries.connection.json');
    expect(answer.lines.join('\n')).toMatch(/destructive {5}applied/);
    expect(answer.code).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a refused step refuses the whole connection: nothing on it applies', async () => {
    const { dir, calls, plugins } = tree({
      targets: [
        target([
          step(),
          step({
            do: 'unique',
            says: '[url]  (4 rows violate)',
            refused: 'a constraint over rows that break it is a decision about which rows stay',
          }),
        ]),
      ],
    });
    const answer = await run(dir, plugins, { apply: true });
    // a plan is one transaction, so the additive step beside the refused one did not apply either
    expect(calls).not.toContain('apply:@connections/entries.connection.json');
    expect(answer.lines.join('\n')).toMatch(/→ a constraint over rows that break it/);
    expect(answer.code).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a drifted connection plans nothing and exits 1', async () => {
    const { dir, calls, plugins } = tree({
      targets: [target([], { drifted: ['entries.agent is text, required in the database; the record says optional'] })],
    });
    const answer = await run(dir, plugins, { apply: true });
    expect(calls).not.toContain('apply:@connections/entries.connection.json');
    expect(answer.lines.join('\n')).toMatch(/drifted, so nothing is planned here/);
    expect(answer.code).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('targets are ordered by connection path, whatever order the plugin gave them', async () => {
    const { dir, plugins } = tree({
      targets: [
        target([step()], { connection: '@connections/z.connection.json' }),
        target([step()], { connection: '@connections/a.connection.json' }),
      ],
    });
    const answer = await run(dir, plugins);
    expect(answer.plan.targets.map(one => one.connection)).toEqual([
      '@connections/a.connection.json',
      '@connections/z.connection.json',
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('hands every migrate member the profile and the flags the command ran under', async () => {
    const { dir, seen, plugins } = tree({ targets: [target([step()])] });
    await run(dir, plugins, { profile: 'production', adopt: true, allowDestructive: ['a/b'] });
    expect(seen[0].profile).toBe('production');
    expect(seen[0].adopt).toBe(true);
    expect(seen[0].allowDestructive).toEqual(['a/b']);
    expect(seen[0].root).toBe(dir);
    rmSync(dir, { recursive: true, force: true });
  });

  it('--history prints every applied plan and plans nothing', async () => {
    const { dir, calls, plugins } = tree(
      { targets: [target([step()])] },
      {
        history: [
          {
            id: 4,
            appliedAt: '2026-09-11T09:14:02Z',
            by: 'rfontes@build-1',
            tree: 'boot',
            connection: '@connections/entries.connection.json',
            targets: ['entries  rename ua → agent; add note'],
          },
        ],
      },
    );
    const answer = await run(dir, plugins, { history: true });
    expect(calls).toEqual(['postLoad', 'history', 'postLoadDown']);
    expect(calls).not.toContain('plan');
    expect(answer.lines[0]).toBe('migration 4  2026-09-11T09:14:02Z  by rfontes@build-1  tree boot');
    expect(answer.lines[1]).toBe('  entries  rename ua → agent; add note');
    expect(answer.code).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a tree that refuses runs no plugin at all', async () => {
    const { dir, calls, plugins } = tree({ targets: [target([step()])] });
    // a startup step naming an operation no plugin grants: the tree does not check, so migrate never loads it
    writeFileSync(
      join(dir, 'project.json'),
      JSON.stringify({
        $schema: schemaUrl('project'),
        name: 'boot',
        description: 'a tree that refuses',
        plugins: [{ use: '@std' }, { use: '@fake' }],
        startup: [{ run: '@fake/nowhere.port.json#listen' }],
      }),
    );
    const answer = await run(dir, plugins);
    // a plan against documents the checker will not stand behind is a guess: no postLoad, no plan, exit 1
    expect(calls).toEqual([]);
    expect(answer.code).toBe(1);
    expect(answer.plan.targets).toEqual([]);
    expect(answer.lines.join('\n')).toMatch(/refusal\(s\)/);
    rmSync(dir, { recursive: true, force: true });
  });
});
