/**
 * Sign in on one instance, stay signed in on another (RFC 0005, step 7). Under `production` the example binds
 * `@auth/state.port.json` to `auth-storage.binding.json`, so the guard's sessions are records of
 * `auth.store.json` rather than files of one process. Two instances of the tree are started here, each its own
 * embedder behind its own port, and a caller moves between them: signed in on one, writing their session on
 * the other, refreshing and signing out wherever the next request lands. Only a store both instances read makes
 * that work; with the laptop's file binding each process would see sessions only it had written.
 *
 * It runs everywhere over memory: the copies point production's database connection at the memory engine,
 * and both instances register one `MemoryEngine`, which is what one database behind a load balancer is to
 * them. Where `WILANIS_TEST_POSTGRES_URL` names a database the same calls run against it untouched, each
 * instance with its own engine, as two processes would be.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import { loadTree, type PluginModule } from '@wilanis/core';
import { hashPassword } from '@wilanis/plugin-auth';
import { engines } from '@wilanis/plugin-storage';
import memory, { MemoryEngine } from '@wilanis/plugin-storage-memory';
import { afterEach, describe, expect, it } from 'vitest';
import { start } from '../src/index.js';
import { EXAMPLE, INCLUDES, PLUGINS } from './example-harness.js';

// two ports per vitest worker, on residues mod 16 no other harness uses (0 and 1), so parallel files never race
const BAND = Number(process.env.VITEST_POOL_ID ?? 0) * 16;
const PORTS = [8400 + BAND, 8401 + BAND];
const PASSWORD = 'operator-pass';
const url = process.env.WILANIS_TEST_POSTGRES_URL;

type Edit = (doc: any) => void;

/**
 * A copy of the example serving on its own port, with any further edits; the caller removes it. It exports no
 * traces: no collector runs here, and an exporter retrying one that refuses holds each stop for seconds.
 */
function copyServing(port: number, edits: Record<string, Edit>): string {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-shared-'));
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
    project.plugins.find((plugin: { use: string }) => plugin.use === '@http').settings.port = port;
    project.startup = project.startup.filter((step: { run: string }) => step.run !== '@otel/exporter.port.json#export');
  });
  for (const [relative, change] of Object.entries(edits)) edit(relative, change);
  return dir;
}

/** Production's database as the memory engine, since a stand-in may not change a connection's kind (C018). */
const OVER_MEMORY: Record<string, Edit> = {
  'connections/customers-postgres.connection.json': connection => {
    connection.kind = '@storage-memory/memory.connection-kind.json';
    connection.settings = {};
  },
  'project.json': project => {
    delete project.secrets.customersDatabase;
  },
};

/** The memory engine's plugin, registering the one engine both instances share rather than one each. */
function sharing(engine: MemoryEngine): PluginModule {
  return {
    ...memory,
    async postLoad(ctx) {
      engines(ctx.env).register(ctx.scope.canon('@storage-memory/memory.connection-kind.json'), engine);
    },
  };
}

const dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Two instances of the example under production, each on its own port, over whatever the case shares. */
async function twoInstances(edits: Record<string, Edit>, plugins: Record<string, PluginModule>, database: string) {
  const env = {
    CUSTOMERS_JWT_SECRET: 'a-secret-of-thirty-two-bytes-or-more!',
    CUSTOMERS_DATABASE_URL: database,
    CUSTOMERS_OPERATOR_PASSWORD_HASH: hashPassword(PASSWORD),
  };
  for (const port of PORTS) {
    const dir = copyServing(port, edits);
    dirs.push(dir);
    const load = loadTree(dir, plugins, INCLUDES);
    expect(checkTree(load).items).toEqual([]);
    const { stop } = await start(load, { log: () => {}, profile: 'production', env });
    stops.push(stop);
  }
}

/**
 * One call to the instance on `port`, with a token when the case presents one. Each closes its connection, as
 * a caller behind a load balancer does not hold one to an instance: a kept-alive socket would hold each
 * server's close open for its idle timeout, and two of them outlast the hook that stops them.
 */
async function call(port: number, path: string, init: RequestInit & { token?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', connection: 'close' };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  const answer = await fetch(`http://localhost:${port}${path}`, { ...init, headers });
  return { status: answer.status, body: (await answer.json().catch(() => undefined)) as any };
}

/** The caller's journey across the two instances: every step lands on the other one from the step before. */
async function movesBetween([one, other]: number[]) {
  const signedIn = await call(one, '/api/v1/auth-employees', {
    method: 'POST',
    body: JSON.stringify({ username: 'operator', password: PASSWORD }),
  });
  expect(signedIn.status).toBe(200);
  const { accessToken, refreshToken } = signedIn.body;
  // the session one instance wrote at sign-in is the session the other reads and writes
  const put = await call(other, '/api/v1/me/preferences', {
    method: 'PUT',
    token: accessToken,
    body: JSON.stringify({ theme: 'dark' }),
  });
  expect(put).toEqual({ status: 200, body: { displayName: 'Operator', theme: 'dark' } });
  expect((await call(one, '/api/v1/me/preferences', { token: accessToken })).body).toEqual({
    displayName: 'Operator',
    theme: 'dark',
  });
  // a refresh on the other reads the session by the sid its token carries, and spends the old token for both
  const refreshing = (port: number, token: string) =>
    call(port, '/api/v1/token/refresh', { method: 'POST', body: JSON.stringify({ refreshToken: token }) });
  const renewed = await refreshing(other, refreshToken);
  expect(renewed.status).toBe(200);
  const spent = await refreshing(one, refreshToken);
  expect([spent.status, spent.body.reason]).toEqual([401, 'invalid_refresh']);
  // signing out on one ends the session the other would have read
  const out = await call(one, '/api/v1/sign-out', { method: 'POST', token: renewed.body.accessToken });
  expect(out).toEqual({ status: 200, body: { ended: true } });
  const after = await call(other, '/api/v1/me/preferences', { token: renewed.body.accessToken });
  expect([after.status, after.body.reason]).toEqual([401, 'invalid_credential']);
}

describe("production's guard memory, shared by two instances", () => {
  it('over one memory store: signed in on one instance, recognised by the other, and signed out of both', async () => {
    const engine = new MemoryEngine();
    await twoInstances(OVER_MEMORY, { ...PLUGINS, '@storage-memory': sharing(engine) }, 'unused');
    await movesBetween(PORTS);
  });

  it.skipIf(!url)('over PostgreSQL: the same journey, each instance with its own engine', async () => {
    await twoInstances({}, PLUGINS, String(url));
    await movesBetween(PORTS);
  });
});
