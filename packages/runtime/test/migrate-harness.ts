/**
 * The fake plugin `wilanis migrate`'s tests plan against: a tree whose one plugin keeps state in the world
 * and answers whatever plan a test hands it. Shared by `migrate.test.ts` (what is planned and printed) and
 * `migrate-apply.test.ts` (what is applied and recorded).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Applied,
  loadTree,
  type MigrateContext,
  type Plan,
  type PlanStep,
  type PlanTarget,
  type PluginModule,
  schemaRef,
  schemaUrl,
} from '@wilanis/core';
import { BUILTIN_PLUGINS, migrate } from '../src/index.js';
import { docsDir } from './example-harness.js';

/** The fake plugin itself: it records every call against it, and its migrate member answers the given plan. */
function plugin(plan: Plan, calls: string[], seen: MigrateContext[], opts: Options): PluginModule {
  return {
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
    migrate: opts.noMigrate ? undefined : member(plan, calls, seen, opts),
  };
}

/** The migrate member: plan, apply and history, each saying it ran and what it was given. */
function member(plan: Plan, calls: string[], seen: MigrateContext[], opts: Options) {
  return {
    plan: async (ctx: MigrateContext) => {
      calls.push('plan');
      seen.push(ctx);
      return plan;
    },
    // each connection applies in its own transaction and so records its own migration, as the real
    // contract does: an engine that applied two connections answers two Applied, not one
    apply: async (ctx: MigrateContext, applying: Plan) => {
      calls.push(`apply:${applying.targets.map(one => one.connection).join(',')}`);
      seen.push(ctx);
      return applying.targets.map((one, at) => ({
        id: 4 + at,
        appliedAt: '2026-09-11T09:14:02Z',
        by: 'rfontes@build-1',
        tree: 'boot',
        connection: one.connection,
        targets: one.steps.map(step => step.target),
      }));
    },
    history: async (ctx: MigrateContext) => {
      calls.push('history');
      seen.push(ctx);
      return opts.history ?? [];
    },
  };
}

/** What a test may vary about the tree: the record its plugin keeps, whether it migrates at all, and its profiles. */
interface Options {
  history?: Applied[];
  noMigrate?: boolean;
  /** The profiles project.json declares, by name, `true` on the one marked default; none unless given. */
  profiles?: Record<string, boolean>;
}

/** The profiles a test named, as project.json declares them: nothing to bind, since the tree has no domain port. */
const profilesOf = (named: Record<string, boolean>) =>
  Object.fromEntries(
    Object.entries(named).map(([name, marked]) => [
      name,
      { description: `the ${name} place`, ...(marked ? { default: true } : {}), bindings: {} },
    ]),
  );

/**
 * A tree whose one plugin grants a `holds` operation a startup step names, and whose `migrate` member
 * answers the plan the test hands it. `calls` records postLoad, the plan, the apply and the teardown, so a
 * test can say what ran and in what order -- and that the startup step never did.
 */
export function tree(plan: Plan, opts: Options = {}) {
  const calls: string[] = [];
  /** What each call of the plugin's migrate member was given, so a test can read the profile and the flags. */
  const seen: MigrateContext[] = [];
  const fake = plugin(plan, calls, seen, opts);
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-migrate-'));
  mkdirSync(join(dir, 'features/boot'), { recursive: true });
  const put = (rel: string, doc: unknown) => writeFileSync(join(dir, rel), JSON.stringify(doc));
  put('project.json', {
    $schema: schemaUrl('project'),
    name: 'boot',
    description: 'a tree with state in the world',
    plugins: [{ use: '@std' }, { use: '@fake' }],
    startup: [{ run: '@fake/server.port.json#listen' }],
    ...(opts.profiles ? { profiles: profilesOf(opts.profiles) } : {}),
  });
  put('features/boot/feature.json', { $schema: schemaRef('feature'), description: 'the boot feature' });
  return { dir, calls, seen, plugins: { ...BUILTIN_PLUGINS, '@fake': fake } };
}

/** One step of a plan, additive over `entries` unless the test says otherwise. */
export const step = (over: Partial<PlanStep> = {}): PlanStep => ({
  do: 'add',
  target: 'entries',
  class: 'additive',
  says: 'note  text, optional',
  ...over,
});

/** One connection's plan, against the entries connection unless the test says otherwise. */
export const target = (steps: PlanStep[], over: Partial<PlanTarget> = {}): PlanTarget => ({
  connection: '@connections/customers.connection.json',
  engine: 'postgres, granted by @storage-postgres',
  steps,
  ...over,
});

/** Run the command over a tree the harness wrote, saying nothing to the terminal. */
export const run = (dir: string, plugins: Record<string, PluginModule>, opts = {}) =>
  migrate(loadTree(dir, plugins), { log: () => {}, ...opts });
