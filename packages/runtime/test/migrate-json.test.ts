/**
 * `wilanis migrate --json`: the plan, the apply, the history and a refused tree, each as the RFC 0019 envelope,
 * checked against the diagnostics schema. What the command prints as text is `migrate.test.ts`'s.
 */
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadTree, type PluginModule } from '@wilanis/core';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { diagnosticsOf, withMigration } from '../src/diagnostics.js';
import { PROFILED, refuse, run, step, target, tree } from './migrate-harness.js';

const SCHEMA = fileURLToPath(new URL('../schemas/diagnostics.schema.json', import.meta.url));
const valid = new Ajv2020({ allErrors: true }).compile(JSON.parse(readFileSync(SCHEMA, 'utf8')));
const conforms = (envelope: unknown) => (valid(envelope) ? [] : valid.errors);

/** What `wilanis migrate --json` prints over a tree the harness wrote, and the code the process exits with. */
async function json(dir: string, plugins: Record<string, PluginModule>, opts = {}) {
  const answer = await run(dir, plugins, opts);
  const loaded = loadTree(dir, plugins);
  const diag = diagnosticsOf(loaded, { items: answer.refusals }, { command: 'migrate', root: '.' });
  return { envelope: withMigration(diag, answer), code: answer.code };
}

describe('wilanis migrate --json: the plan as RFC 0019 envelope', () => {
  it('a clean plan: every target and step as printed, nothing applied, ok and exit 0', async () => {
    const { dir, plugins } = tree({
      targets: [
        target([step({ do: 'rename', says: 'ua → agent', class: 'transformative', at: 'ua' }), step()], {
          notes: ['was.entry has been applied'],
        }),
        target([], { connection: '@connections/a.connection.json', skipped: 'nothing is kept between processes' }),
      ],
    });
    const { envelope, code } = await json(dir, plugins);
    expect(conforms(envelope)).toEqual([]);
    expect(code).toBe(0);
    expect(envelope).toMatchObject({ format: 1, command: 'migrate', root: '.', ok: true, refusals: [] });
    expect(envelope.profile).toBe('default');
    expect(envelope.applied).toBe(false);
    // sorted as printed: by connection path, steps in the order the plugin declared them
    expect(envelope.targets?.map(one => one.connection)).toEqual([
      '@connections/a.connection.json',
      '@connections/customers.connection.json',
    ]);
    expect(envelope.targets?.[0]).toEqual({
      connection: '@connections/a.connection.json',
      engine: 'postgres, granted by @storage-postgres',
      skipped: 'nothing is kept between processes',
      steps: [],
    });
    expect(envelope.targets?.[1].notes).toEqual(['was.entry has been applied']);
    expect(envelope.targets?.[1].steps).toEqual([
      { do: 'rename', target: 'entries', at: 'ua', class: 'transformative', says: 'ua → agent', applied: false },
      { do: 'add', target: 'entries', class: 'additive', says: 'note  text, optional', applied: false },
    ]);
    expect(envelope.lines?.at(-1)).toBe('2 steps would apply; 0 refused. Nothing was applied: run again with --apply.');
    rmSync(dir, { recursive: true, force: true });
  });

  it('a refused step and a destructive one nobody allowed each say why; ok is false and the exit 1', async () => {
    const { dir, plugins } = tree({
      targets: [
        target([
          step({ do: 'retype', says: 'rows  text → integer', class: 'transformative', refused: 'rows hold text' }),
          step({
            do: 'drop',
            target: 'notes',
            says: 'collection notes',
            class: 'destructive',
            rows: 17,
            loses: '17 rows',
          }),
        ]),
      ],
    });
    const { envelope, code } = await json(dir, plugins, { apply: true });
    expect(conforms(envelope)).toEqual([]);
    expect(code).toBe(1);
    expect(envelope).toMatchObject({ command: 'migrate', ok: false, applied: false });
    expect(envelope.targets?.[0].steps.map(one => [one.refused, one.applied])).toEqual([
      ['rows hold text', false],
      ['needs --allow-destructive @connections/customers.connection.json/notes', false],
    ]);
    expect(envelope.targets?.[0].steps[1]).toMatchObject({ rows: 17, loses: '17 rows' });
    rmSync(dir, { recursive: true, force: true });
  });

  it('a drifted connection is not ok and exits 1, with what drifted', async () => {
    const { dir, plugins } = tree({
      targets: [target([], { drifted: ['entries.agent is required in the database'] })],
    });
    const { envelope, code } = await json(dir, plugins);
    expect(conforms(envelope)).toEqual([]);
    expect(code).toBe(1);
    expect(envelope.ok).toBe(false);
    expect(envelope.targets?.[0].drifted).toEqual(['entries.agent is required in the database']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('--apply: every step of an allowed connection applied, and applied is true', async () => {
    const drop = step({ do: 'drop', target: 'notes', says: 'collection notes', class: 'destructive' });
    const { dir, plugins } = tree({ targets: [target([step(), drop])] }, PROFILED);
    const allowDestructive = ['@connections/customers.connection.json/notes'];
    const { envelope, code } = await json(dir, plugins, { apply: true, allowDestructive, profile: 'production' });
    expect(conforms(envelope)).toEqual([]);
    expect(code).toBe(0);
    expect(envelope).toMatchObject({ command: 'migrate', ok: true, applied: true, profile: 'production' });
    expect(envelope.targets?.[0].steps.every(one => one.applied && one.refused === undefined)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('--history: every migration the record holds, and no plan', async () => {
    const record = {
      id: 4,
      appliedAt: '2026-09-11T09:14:02Z',
      by: 'rfontes@build-1',
      tree: 'boot',
      connection: '@connections/customers.connection.json',
      targets: ['entries  rename ua → agent; add note'],
    };
    const { dir, plugins } = tree({ targets: [target([step()])] }, { history: [record] });
    const { envelope, code } = await json(dir, plugins, { history: true });
    expect(conforms(envelope)).toEqual([]);
    expect(code).toBe(0);
    expect(envelope).toMatchObject({ command: 'migrate', ok: true, migrations: [record] });
    expect(envelope).not.toHaveProperty('targets');
    expect(envelope).not.toHaveProperty('applied');
    rmSync(dir, { recursive: true, force: true });
  });

  it('a refused tree prints the check envelope with command migrate, and exits 1', async () => {
    const { dir, calls, plugins } = tree({ targets: [target([step()])] });
    refuse(dir);
    const { envelope, code } = await json(dir, plugins);
    expect(conforms(envelope)).toEqual([]);
    expect(calls).toEqual([]);
    expect(code).toBe(1);
    expect(envelope).toMatchObject({ command: 'migrate', ok: false });
    expect(envelope.refusals.length).toBeGreaterThan(0);
    // nothing ran, so nothing of migrate's own is added: the shape is the one check prints
    expect(Object.keys(envelope)).toEqual(['format', 'runtime', 'command', 'root', 'ok', 'documents', 'refusals']);
    rmSync(dir, { recursive: true, force: true });
  });
});
