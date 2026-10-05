/**
 * The SQLite this engine runs is the one better-sqlite3 bundles, so its version is the package's own and is
 * checked here rather than at start: 3.35 is the first with `RETURNING`, which `put`, `patch` and `remove`
 * answer through, and with `DROP COLUMN`, which the planner's steps will need. A dependency bump that brought
 * an older library would fail this before it failed a write.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import { Handles } from '../src/index.js';

const scratch = mkdtempSync(join(tmpdir(), 'wilanis-sqlite-version-'));
const handles = new Handles(scratch, {});
afterAll(async () => {
  await handles.close();
  rmSync(scratch, { recursive: true, force: true });
});

/** A version as numbers, so 3.100 compares above 3.35 rather than below it. */
const parts = (version: string) => version.split('.').map(Number);

describe('the bundled SQLite', () => {
  it('is 3.35 or later', async () => {
    const db = handles.for({
      connection: '@connections/version.connection.json',
      kind: '@storage-sqlite/sqlite.connection-kind.json',
      settings: { file: 'version.sqlite' },
    });
    const { rows } = await sql<{ version: string }>`select sqlite_version() as version`.execute(db);
    const [major, minor] = parts(rows[0].version);
    expect(major > 3 || (major === 3 && minor >= 35), `SQLite ${rows[0].version}`).toBe(true);
  });
});
