import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { schemaUrl } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { run, step, target, tree } from './migrate-harness.js';

describe('wilanis migrate: what it plans and prints', () => {
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
      'plan for @connections/customers.connection.json  (postgres, granted by @storage-postgres)',
    );
    expect(printed).toMatch(/^ {2}entries$/m);
    expect(printed).toMatch(/^ {4}rename {3}ua → agent {34}transformative$/m);
    expect(printed).toMatch(/needs --allow-destructive @connections\/customers.connection.json\/notes/);
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

  it('a drifted connection plans nothing and exits 1', async () => {
    const { dir, calls, plugins } = tree({
      targets: [target([], { drifted: ['entries.agent is text, required in the database; the record says optional'] })],
    });
    const answer = await run(dir, plugins, { apply: true });
    expect(calls).not.toContain('apply:@connections/customers.connection.json');
    expect(answer.lines.join('\n')).toMatch(/drifted, so nothing is planned here/);
    expect(answer.code).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a skipped connection is not a failure: it says why and exits 0', async () => {
    // an engine that keeps nothing between processes is skipped on every run, so a tree holding one could
    // never exit 0 if a skip counted against it. Only a refused step or a drifted connection exits 1.
    const { dir, calls, plugins } = tree({
      targets: [target([], { skipped: 'nothing is kept between processes, so there is nothing to migrate' })],
    });
    const answer = await run(dir, plugins, { apply: true });
    expect(calls).not.toContain('apply:@connections/customers.connection.json');
    expect(answer.lines.join('\n')).toMatch(/skipped: nothing is kept between processes/);
    expect(answer.lines.at(-1)).toBe('nothing to apply');
    expect(answer.code).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("a target's notes are printed and judged by nothing: they neither refuse nor stop a step applying", async () => {
    // a plugin with something to say about the tree -- a mark that has done its work -- has no step to say it
    // with, and a line that judged would refuse a connection nothing is wrong with
    const said = 'renamed.agent has been applied -- remove "renamed" from the entries collection';
    const { dir, calls, plugins } = tree({ targets: [target([step()], { notes: [said] })] });
    const answer = await run(dir, plugins, { apply: true });
    expect(answer.lines.join('\n')).toContain(`note: ${said}`);
    expect(calls).toContain('apply:@connections/customers.connection.json');
    expect(answer.code).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a note on a connection with nothing else to do still prints, under `up to date`', async () => {
    const { dir, plugins } = tree({ targets: [target([], { notes: ['was.entry has been applied'] })] });
    const answer = await run(dir, plugins);
    expect(answer.lines.join('\n')).toMatch(/up to date\n {2}note: was\.entry has been applied/);
    expect(answer.code).toBe(0);
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
            connection: '@connections/customers.connection.json',
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
