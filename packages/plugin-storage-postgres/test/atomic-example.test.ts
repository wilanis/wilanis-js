/**
 * The example's atomic import against a real database: the half of RFC 0004's end-to-end cases that a
 * copy-on-write view in memory cannot honestly answer. Two transactions on one PostgreSQL connection must
 * not see each other's uncommitted rows, and one rolling back must leave the other's rows whole -- which is
 * the engine's isolation doing the work, not the scope. And a graph the example does not have, planted in a
 * copy: a store write and a publish through the stand-in production puts in for the queue's connection, which
 * must be one transaction on the table beside the customers.
 *
 * It runs only where a database is named, as the rest of this package's cases do: set
 * `WILANIS_TEST_POSTGRES_URL` and it runs, leave it unset and it is skipped. The example itself reads the URL
 * from `CUSTOMERS_DATABASE_URL`, so the case hands its own along under that name and puts back whatever was
 * there, and it prepares the store first the way the tree's own startup step does. Every other operation runs
 * as a caller whose session carries the tenant `acme`, as a trigger past its gate hands it on: the store keeps
 * its customers per tenant, and a run with no context -- a startup step's -- could not reach them (B008).
 *
 * The plugins come from the example through `resolvePlugins`, never from imports here: this package is one
 * engine, and a tree naming seven plugins is no reason for it to depend on the other six.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGraph } from '@wilanis/compiler';
import { loadTree, schemaUrl } from '@wilanis/core';
import { embedderFor, postLoad, resolveIncludes, resolvePlugins } from '@wilanis/runtime';
import { sql } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import { closePools, poolFor } from '../src/pool.js';

const url = process.env.WILANIS_TEST_POSTGRES_URL;
const EXAMPLE = fileURLToPath(new URL('../../../example', import.meta.url));
/** The context a signed-in customer of tenant acme is read from: all the scoped store asks of it is the tenant. */
const ACME = { session: { attributes: { tenant: 'acme' } } };

afterAll(async () => {
  if (url) await closePools();
});

describe.skipIf(!url)('the example, importing into PostgreSQL under one transaction', () => {
  it('keeps the rows of an import that answered and none of one that rolled back, run at once', async () => {
    const was = process.env.CUSTOMERS_DATABASE_URL;
    process.env.CUSTOMERS_DATABASE_URL = url;
    // the plugins and the included tree are resolved from the example itself rather than imported here:
    // a tree needs every plugin it names, and a leaf plugin package has no business depending on its siblings
    const { available } = await resolvePlugins(EXAMPLE);
    const { includes } = resolveIncludes(EXAMPLE);
    const load = loadTree(EXAMPLE, available, includes);
    const emb = embedderFor(load, { profile: 'production' });
    const down = await postLoad(load, emb, () => {});
    const scope = emb.blobs.scope();
    const run = (op: string, input: Record<string, unknown> = {}) =>
      runGraph(emb.operation(`@customers/domain/customer.port.json#${op}`), {
        initial: { in: input, context: ACME },
        env: emb.envFor(scope),
      });
    const upload = (text: string) => scope.put(text, { contentType: 'text/csv', filename: 'customers.csv' });
    const mark = `run-${Date.now()}`;
    try {
      // the tree's own first startup step: the collections the store declares, created once
      const prepared = await emb.startup(
        { run: '@customers/domain/customer.port.json#prepare' },
        { blobs: scope, at: 0 },
      );
      expect(prepared.status).toBe('done');
      const good = run('import', {
        file: await upload(`name,email,tier\nAda,${mark}a@x.example,bronze\nGrace,${mark}b@x.example,silver\n`),
      });
      // the same address twice in one file: unique [email] refuses the second and rolls the first back
      const bad = run('import', {
        file: await upload(`name,email,tier\nZoe,${mark}z@x.example,bronze\nZoe,${mark}z@x.example,bronze\n`),
      });
      const [first, second] = await Promise.all([good, bad]);
      expect(first.status).toBe('done');
      expect(second.status).toBe('failed');
      const kept = (await run('listAll')).output as { email: string }[];
      const mine = kept.filter(row => row.email.startsWith(mark)).map(row => row.email);
      expect(mine.sort()).toEqual([`${mark}a@x.example`, `${mark}b@x.example`]);
    } finally {
      await scope.release();
      await down();
      if (was === undefined) delete process.env.CUSTOMERS_DATABASE_URL;
      else process.env.CUSTOMERS_DATABASE_URL = was;
    }
  });
});

/**
 * The graph #653 is about, planted in a copy of the example: a customer written to the store and a removal of
 * them published to `jobs.connection.json`, which production stands in for the customer database, and a gold
 * customer refused after both calls were made. The two calls name two connections that production reaches as one,
 * so they are one transaction on it: the row and the message are kept together or not at all.
 */
const PLANTED = 'features/customers/data/keep-and-announce-postgres.graph.json';

/** One run node of the planted graph. */
const node = (id: string, run: string, input: Record<string, unknown>) => ({
  type: '@wilanis/node/run.schema.json',
  id,
  label: id,
  run,
  in: input,
});

/** A refusal of the kept customer. */
const refused = (id: string, reason: string, message: string) =>
  node(id, '@std/outcome.port.json#refuse', { reason, message, type: '@customers/domain/Customer.shape.json' });

const KEEP_AND_ANNOUNCE = {
  $schema: schemaUrl('graph'),
  label: 'Keep a customer and announce it',
  description: 'Write the customer and publish a removal of them, as one transaction.',
  atomic: true,
  in: '@customers/domain/Customer.shape.json',
  out: { type: '@customers/domain/Customer.shape.json', from: ['kept', 'repeated', 'declined', 'nothingWritten'] },
  nodes: [
    node('stored', '@storage/store.port.json#put', {
      store: '@customers/data/customers-postgres.store.json',
      collection: 'customers',
      record: '{{in}}',
    }),
    node('published', '@queue/queue.port.json#publish', {
      connection: '@connections/jobs.connection.json',
      queue: 'removals',
      type: '@customers/edge/IdRequest.shape.json',
      message: { id: '{{in.id}}' },
    }),
    {
      type: '@wilanis/node/switch.schema.json',
      id: 'outcome',
      label: 'outcome',
      in: {
        record: '{{stored.record}}',
        violated: '{{stored.violated}}',
        queued: '{{published.id}}',
        tier: '{{in.tier}}',
      },
      rules: [
        { when: 'has(violated)', to: 'repeated' },
        { when: "tier == 'gold'", to: 'declined' },
        { when: 'has(record)', to: 'kept' },
      ],
      else: 'nothingWritten',
    },
    node('kept', '@std/object.port.json#make', {
      value: '{{stored.record}}',
      type: '@customers/domain/Customer.shape.json',
    }),
    refused('repeated', 'conflict', 'a customer already uses {{in.email}}'),
    refused('declined', 'conflict', 'a gold customer is kept elsewhere'),
    refused('nothingWritten', 'upstream', 'the store answered no record for {{in.id}}'),
  ],
};

/** A copy of the example with the graph planted and the postgres binding meeting `keep` with it; the caller removes it. */
function planted(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-stand-in-'));
  const scenarios = join(EXAMPLE, 'scenarios');
  cpSync(EXAMPLE, dir, { recursive: true, filter: path => !path.includes('node_modules') && path !== scenarios });
  writeFileSync(join(dir, PLANTED), JSON.stringify(KEEP_AND_ANNOUNCE));
  const binding = join(dir, 'features/customers/data/customers-postgres.binding.json');
  const doc = JSON.parse(readFileSync(binding, 'utf8'));
  doc.operations.keep = { graph: '@customers/data/keep-and-announce-postgres.graph.json' };
  writeFileSync(binding, JSON.stringify(doc));
  return dir;
}

describe.skipIf(!url)('the example, keeping a customer and publishing their removal in one transaction', () => {
  it('commits the row and the message together, and rolls both back together (#653)', async () => {
    const was = process.env.CUSTOMERS_DATABASE_URL;
    process.env.CUSTOMERS_DATABASE_URL = url;
    const dir = planted();
    const { available } = await resolvePlugins(EXAMPLE);
    const { includes } = resolveIncludes(EXAMPLE);
    const load = loadTree(dir, available, includes);
    const emb = embedderFor(load, { profile: 'production' });
    const down = await postLoad(load, emb, () => {});
    const scope = emb.blobs.scope();
    const run = (op: string, input: Record<string, unknown> = {}) =>
      runGraph(emb.operation(`@customers/domain/customer.port.json#${op}`), {
        initial: { in: input, context: ACME },
        env: emb.envFor(scope),
      });
    const mark = `run-${Date.now()}`;
    // a gold customer carries a note, as the example's invariant asks, so what refuses it is the planted graph
    const person = (tier: string) => ({
      id: `${mark}-${tier}`,
      name: 'Ada',
      email: `${mark}-${tier}@x.example`,
      tier,
      note: 'met',
    });
    const on = { connection: '@connections/customers-postgres.connection.json', kind: '', settings: { url } };
    const { db } = poolFor(on, {});
    const like = `${mark}-%`;
    const announced = async () =>
      (
        await sql<{ id: string }>`select body->>'id' as id from wilanis_queue where body->>'id' like ${like}`.execute(
          db,
        )
      ).rows.map(one => one.id);
    try {
      // the tree's own startup steps under production: the store's collections, then the queue's table
      for (const step of ['@customers/domain/customer.port.json#prepare', '@customers/domain/jobs.port.json#prepare'])
        expect((await emb.startup({ run: step }, { blobs: scope, at: 0 })).status).toBe('done');
      expect((await run('keep', person('bronze'))).status).toBe('done');
      expect((await run('keep', person('gold'))).status).toBe('failed');
      const kept = ((await run('listAll')).output as { id: string }[]).map(one => one.id);
      expect(kept.filter(id => id.startsWith(mark))).toEqual([`${mark}-bronze`]);
      expect(await announced()).toEqual([`${mark}-bronze`]);
    } finally {
      // before `down`, whose teardown destroys the pool this reads through
      await sql`delete from wilanis_queue where body->>'id' like ${like}`.execute(db);
      await scope.release();
      await down();
      rmSync(dir, { recursive: true, force: true });
      if (was === undefined) delete process.env.CUSTOMERS_DATABASE_URL;
      else process.env.CUSTOMERS_DATABASE_URL = was;
    }
  });
});
