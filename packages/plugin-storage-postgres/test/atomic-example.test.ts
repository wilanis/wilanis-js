/**
 * The example's atomic import against a real database: the half of RFC 0004's end-to-end cases that a
 * copy-on-write view in memory cannot honestly answer. Two transactions on one PostgreSQL connection must
 * not see each other's uncommitted rows, and one rolling back must leave the other's rows whole -- which is
 * the engine's isolation doing the work, not the scope.
 *
 * It runs only where a database is named, as the rest of this package's cases do: set
 * `WILANIS_TEST_POSTGRES_URL` and it runs, leave it unset and it is skipped. The example itself reads the URL
 * from `MONITOR_DATABASE_URL`, so the case hands its own along under that name and puts back whatever was
 * there, and it prepares the store first the way the tree's own startup step does.
 *
 * The plugins come from the example through `resolvePlugins`, never from imports here: this package is one
 * engine, and a tree naming seven plugins is no reason for it to depend on the other six.
 */
import { fileURLToPath } from 'node:url';
import { loadTree } from '@wilanis/core';
import { embedderFor, postLoad, resolveIncludes, resolvePlugins } from '@wilanis/runtime';
import { afterAll, describe, expect, it } from 'vitest';
import { closePools } from '../src/pool.js';

const url = process.env.WILANIS_TEST_POSTGRES_URL;
const EXAMPLE = fileURLToPath(new URL('../../../example', import.meta.url));

afterAll(async () => {
  if (url) await closePools();
});

describe.skipIf(!url)('the example, importing into PostgreSQL under one transaction', () => {
  it('keeps the rows of an import that answered and none of one that rolled back, run at once', async () => {
    const was = process.env.MONITOR_DATABASE_URL;
    process.env.MONITOR_DATABASE_URL = url;
    // the plugins and the included tree are resolved from the example itself rather than imported here:
    // a tree needs every plugin it names, and a leaf plugin package has no business depending on its siblings
    const { available } = await resolvePlugins(EXAMPLE);
    const { includes } = resolveIncludes(EXAMPLE);
    const load = loadTree(EXAMPLE, available, includes);
    const emb = embedderFor(load, { profile: 'production' });
    const down = await postLoad(load, emb, () => {});
    const scope = emb.blobs.scope();
    const run = (op: string, input: Record<string, unknown> = {}) =>
      emb.startup({ run: `@monitor/domain/monitor.port.json#${op}`, in: input }, { blobs: scope });
    const upload = (text: string) => scope.put(text, { contentType: 'text/csv', filename: 'entries.csv' });
    const mark = `https://${Date.now()}.example/`;
    try {
      // the tree's own first startup step: the collections the store declares, created once
      expect((await run('prepare')).status).toBe('done');
      const good = run('import', { file: await upload(`url,method\n${mark}a,GET\n${mark}b,POST\n`) });
      // the same call twice in one file: unique [url, method] refuses the second and rolls the first back
      const bad = run('import', { file: await upload(`url,method\n${mark}z,GET\n${mark}z,GET\n`) });
      const [first, second] = await Promise.all([good, bad]);
      expect(first.status).toBe('done');
      expect(second.status).toBe('failed');
      const kept = (await run('listAll')).output as { url: string }[];
      const mine = kept.filter(row => row.url.startsWith(mark)).map(row => row.url);
      expect(mine.sort()).toEqual([`${mark}a`, `${mark}b`]);
    } finally {
      await scope.release();
      await down();
      if (was === undefined) delete process.env.MONITOR_DATABASE_URL;
      else process.env.MONITOR_DATABASE_URL = was;
    }
  });
});
