import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { run, step, target, tree } from './migrate-harness.js';

describe('wilanis migrate: what it applies and records', () => {
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

  it('a skipped connection beside one that applies still exits 0', async () => {
    const { dir, plugins } = tree({
      targets: [
        target([], { connection: '@connections/a.connection.json', skipped: 'nothing is kept between processes' }),
        target([step()], { connection: '@connections/b.connection.json' }),
      ],
    });
    const answer = await run(dir, plugins, { apply: true });
    expect(answer.code).toBe(0);
    // the skip is not a refusal, so the summary counts no connection against the one that applied
    expect(answer.lines.at(-1)).toBe(
      '1 steps applied in one transaction; recorded as migration 4 (2026-09-11T09:14:02Z).',
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it('two connections that apply each name their own migration', async () => {
    // each connection is its own transaction and so its own id: naming only the first would hide the second
    const { dir, plugins } = tree({
      targets: [
        target([step()], { connection: '@connections/a.connection.json' }),
        target([step()], { connection: '@connections/b.connection.json' }),
      ],
    });
    const answer = await run(dir, plugins, { apply: true });
    expect(answer.lines.at(-1)).toBe(
      '2 steps applied in 2 transactions, one per connection; recorded as migration 4 on @connections/a.connection.json (2026-09-11T09:14:02Z), migration 5 on @connections/b.connection.json (2026-09-11T09:14:02Z).',
    );
    expect(answer.applied.map(one => one.id)).toEqual([4, 5]);
    expect(answer.code).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a connection that applied beside one that refused says so, and the record of the first stands', async () => {
    const { dir, plugins } = tree({
      targets: [
        target([step()], { connection: '@connections/a.connection.json' }),
        target([step({ do: 'drop', target: 'notes', class: 'destructive', says: 'collection notes' })], {
          connection: '@connections/b.connection.json',
        }),
      ],
    });
    const answer = await run(dir, plugins, { apply: true });
    // the first is written whatever the second did, and the operator has to be told both
    expect(answer.lines.at(-1)).toMatch(/^2 connections: 1 applied, 1 refused\. /);
    expect(answer.lines.at(-1)).toMatch(/recorded as migration 4 \(2026-09-11T09:14:02Z\)\.$/);
    expect(answer.applied.map(one => one.connection)).toEqual(['@connections/a.connection.json']);
    expect(answer.code).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });
});
