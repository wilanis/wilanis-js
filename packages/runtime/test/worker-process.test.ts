/**
 * A removal published by an instance that listens is done by a process that only works the queue (RFC 0009,
 * step 11). Two copies of the example are started, as two processes would be: one under `production`, behind its
 * own port, and one under `production-worker`, which opens none. The caller signs in on the listener, registers
 * a customer and queues its removal; the worker's log says the message was acknowledged, and the listener no
 * longer finds the customer.
 *
 * It runs everywhere over memory: the copies point production's database at the memory engine and keep the
 * queue on the in-process broker, and both processes register one `MemoryEngine` and one `MemoryBroker`, which is
 * what one database is to them. Where `WILANIS_TEST_POSTGRES_URL` names a database the copies run untouched,
 * each with its own pool, and the queue is the table the listener publishes to and the worker is woken by.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import { loadTree, type PluginModule } from '@wilanis/core';
import { hashPassword } from '@wilanis/plugin-auth';
import { brokers } from '@wilanis/plugin-queue';
import queueMemory, { MemoryBroker, KIND as QUEUE_KIND } from '@wilanis/plugin-queue-memory';
import { engines } from '@wilanis/plugin-storage';
import storageMemory, { MemoryEngine } from '@wilanis/plugin-storage-memory';
import { afterEach, describe, expect, it } from 'vitest';
import { start } from '../src/index.js';
import { EXAMPLE, INCLUDES, PLUGINS } from './example-harness.js';

// one port per vitest worker, on a residue mod 16 no other harness uses (8), so parallel files never race
const PORT = 8328 + Number(process.env.VITEST_POOL_ID ?? 0) * 16;
const PASSWORD = 'operator-pass';
const url = process.env.WILANIS_TEST_POSTGRES_URL;
const JOBS = '@connections/jobs.connection.json';

type Edit = (doc: any) => void;

/** A copy of the example with its server on `PORT`, exporting no traces, with any further edits; the caller removes it. */
function copyOf(edits: Record<string, Edit>): string {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-worker-'));
  cpSync(EXAMPLE, dir, {
    recursive: true,
    filter: path => !path.includes('node_modules') && !path.includes('.wilanis'),
  });
  const edit = (relative: string, change: Edit) => {
    const path = join(dir, relative);
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    change(doc);
    writeFileSync(path, JSON.stringify(doc));
  };
  edit('project.json', project => {
    project.plugins.find((plugin: { use: string }) => plugin.use === '@http').settings.port = PORT;
    project.startup = project.startup.filter((step: { run: string }) => step.run !== '@otel/exporter.port.json#export');
  });
  for (const [relative, change] of Object.entries(edits)) edit(relative, change);
  return dir;
}

/**
 * Production's database as the memory engine, as `shared-state.test.ts` has it: a memory store is no broker, so
 * the jobs connection stays the in-process broker rather than standing for it, and the scheduler's lease goes,
 * since the memory kind keeps none.
 */
const OVER_MEMORY: Record<string, Edit> = {
  'connections/customers-postgres.connection.json': connection => {
    connection.kind = '@storage-memory/memory.connection-kind.json';
    connection.settings = {};
  },
  'project.json': project => {
    delete project.secrets.customersDatabase;
    for (const step of project.startup) if (step.in?.lease) step.in = undefined;
    for (const profile of Object.values(project.profiles) as { connections?: Record<string, string> }[])
      delete profile.connections?.[JOBS];
  },
};

/** The two memory plugins, each registering the one engine or broker both processes share rather than one each. */
function sharing(engine: MemoryEngine, broker: MemoryBroker): Record<string, PluginModule> {
  return {
    '@storage-memory': {
      ...storageMemory,
      async postLoad(ctx) {
        engines(ctx.env).register(ctx.scope.canon('@storage-memory/memory.connection-kind.json'), engine);
      },
    },
    '@queue-memory': {
      ...queueMemory,
      async postLoad(ctx) {
        brokers(ctx.env).register(ctx.scope.canon(QUEUE_KIND), broker);
      },
    },
  };
}

const dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The listener under production and the worker under production-worker; answers what the worker logs. */
async function listenerAndWorker(edits: Record<string, Edit>, plugins: Record<string, PluginModule>, database: string) {
  const env = {
    CUSTOMERS_JWT_SECRET: 'a-secret-of-thirty-two-bytes-or-more!',
    CUSTOMERS_DATABASE_URL: database,
    CUSTOMERS_OPERATOR_PASSWORD_HASH: hashPassword(PASSWORD),
  };
  const worked: string[] = [];
  for (const [profile, log] of [
    ['production', () => {}],
    ['production-worker', (line: string) => worked.push(line)],
  ] as const) {
    const dir = copyOf(edits);
    dirs.push(dir);
    const load = loadTree(dir, plugins, INCLUDES);
    expect(checkTree(load).items).toEqual([]);
    const { stop } = await start(load, { log, profile, env });
    stops.push(stop);
  }
  return worked;
}

/** One call to the listener, with a token when the case presents one; each closes its connection. */
async function call(path: string, init: RequestInit & { token?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', connection: 'close' };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  const answer = await fetch(`http://localhost:${PORT}${path}`, { ...init, headers });
  return { status: answer.status, body: (await answer.json().catch(() => undefined)) as any };
}

/** Wait until the worker has logged a line that says so, or give up after a few seconds. */
async function logged(lines: string[], says: (line: string) => boolean): Promise<string | undefined> {
  for (let tries = 0; tries < 100; tries++) {
    const found = lines.find(says);
    if (found) return found;
    await new Promise(done => setTimeout(done, 50));
  }
  return undefined;
}

/** Queue a removal on the listener and see the worker do it. */
async function removedOffTheListener(worked: string[]) {
  expect(worked.some(line => line.startsWith('queue: consuming removals on @connections/jobs.connection.json'))).toBe(
    true,
  );
  const signedIn = await call('/api/v1/auth-employees', {
    method: 'POST',
    body: JSON.stringify({ username: 'operator', password: PASSWORD }),
  });
  const token = signedIn.body.accessToken;
  const email = `worker-${Date.now()}@one.example`;
  const registered = await call('/customers', {
    method: 'POST',
    token,
    body: JSON.stringify({ name: 'Ada', email, tier: 'silver' }),
  });
  expect(registered.status).toBe(201);
  const { id } = registered.body;
  const queued = await call(`/customers/${id}/removal`, { method: 'POST', token });
  expect(queued.status).toBe(202);
  const acked = await logged(worked, line => line.startsWith('queue removals') && line.includes('→ ack'));
  expect(acked).toContain('@customers/domain/customer.port.json#remove done');
  expect((await call(`/customers/${id}`, { token })).status).toBe(404);
}

describe('a removal queued by the listener, done by the worker', () => {
  it('over one memory store and one in-process broker', async () => {
    const worked = await listenerAndWorker(
      OVER_MEMORY,
      { ...PLUGINS, ...sharing(new MemoryEngine(), new MemoryBroker()) },
      'unused',
    );
    await removedOffTheListener(worked);
  });

  it.skipIf(!url)('over PostgreSQL: the queue is the table both processes reach', async () => {
    await removedOffTheListener(await listenerAndWorker({}, PLUGINS, String(url)));
  });
});
