/**
 * A customer is changed whole or not at all (RFC 0035, issue #489). `update-customer` loads the customer, lays
 * the change over them with `#merge` and hands the result to `keep`, so the invariant *A customer is reachable*
 * is judged on the customer the graph is about to write, before anything is written. Moving a customer to gold
 * without a note is refused as `invariant`, and the customer read back afterwards is the one that was there:
 * before the rewrite the patch committed first and the guard refused after, leaving a row every later read
 * refused.
 *
 * The tree is the example served over its own port and the calls go over HTTP, on both engines: the memory
 * store under `local`, and PostgreSQL under `production` where `WILANIS_TEST_POSTGRES_URL` names a database,
 * skipped otherwise as the postgres engine's own cases are.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import { loadTree } from '@wilanis/core';
import { hashPassword } from '@wilanis/plugin-auth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { start } from '../src/index.js';
import { EXAMPLE, INCLUDES, PLUGINS } from './example-harness.js';

const url = process.env.WILANIS_TEST_POSTGRES_URL;

/** One engine the example keeps its customers in: the profile that chooses it and who signs in there. */
interface Engine {
  profile: string;
  port: number;
  who: { username: string; password: string };
}

/** The example, its server on a port of its own, without what a copy must not carry. */
function copyServing(port: number): string {
  const copy = mkdtempSync(join(tmpdir(), 'wilanis-whole-'));
  cpSync(EXAMPLE, copy, {
    recursive: true,
    filter: path => !path.includes('node_modules') && !path.includes('.wilanis'),
  });
  const at = join(copy, 'project.json');
  const project = JSON.parse(readFileSync(at, 'utf8'));
  project.plugins.find((plugin: { use: string }) => plugin.use === '@http').settings.port = port;
  writeFileSync(at, JSON.stringify(project));
  return copy;
}

/** The cases, run against one engine. */
function updating(engine: Engine) {
  let dir: string;
  let stop: () => Promise<void>;
  let token: string;
  const mark = `whole-${Date.now()}`;

  /** One request to the served tree, as the registrar: the status and the JSON body. */
  const call = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`http://localhost:${engine.port}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    });
    return { status: response.status, body: await response.json() };
  };
  const put = (id: string, body: Record<string, unknown>) =>
    call(`/customers/${id}`, { method: 'PUT', body: JSON.stringify(body) });

  beforeAll(async () => {
    dir = copyServing(engine.port);
    const load = loadTree(dir, PLUGINS, INCLUDES);
    expect(checkTree(load).items).toEqual([]);
    ({ stop } = await start(load, { log: () => {}, profile: engine.profile }));
    const signedIn = await call('/api/v1/auth-employees', { method: 'POST', body: JSON.stringify(engine.who) });
    token = signedIn.body.accessToken;
  });

  // stopping runs the plugins' teardowns, the postgres engine's closing of its pools among them
  afterAll(async () => {
    await stop?.();
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a move to gold without a note as invariant, and the customer read back is unchanged', async () => {
    const registered = await call('/customers', {
      method: 'POST',
      body: JSON.stringify({ name: 'Ada', email: `${mark}-ada@one.example`, tier: 'silver' }),
    });
    expect(registered.status).toBe(201);
    const { id } = registered.body;
    const before = await call(`/customers/${id}`);
    expect(before.body.tier).toBe('silver');

    const moved = await put(id, { name: 'Ada', email: `${mark}-ada@one.example`, tier: 'gold' });
    expect(moved.status).toBe(500);
    expect(moved.body.reason).toBe('invariant');

    expect(await call(`/customers/${id}`)).toEqual(before);
  });

  it('keeps a move to gold that says why, and a later change that sends no note keeps the one there', async () => {
    const registered = await call('/customers', {
      method: 'POST',
      body: JSON.stringify({ name: 'Bo', email: `${mark}-bo@one.example`, tier: 'bronze' }),
    });
    const { id } = registered.body;
    const gold = await put(id, { name: 'Bo', email: `${mark}-bo@one.example`, tier: 'gold', note: 'the flagship' });
    expect(gold.status).toBe(200);
    expect(gold.body).toMatchObject({ id, tier: 'gold' });
    const renamed = await put(id, { name: 'Bo Two', email: `${mark}-bo@one.example`, tier: 'gold' });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ id, name: 'Bo Two', tier: 'gold' });
  });
}

beforeAll(() => {
  process.env.CUSTOMERS_JWT_SECRET = 'a-secret-of-thirty-two-bytes-or-more!';
  // every connection's secrets are substituted whatever the profile; only production dials this one
  process.env.CUSTOMERS_DATABASE_URL = url ?? 'postgres://customers:customers@localhost:5432/customers';
  process.env.CUSTOMERS_OPERATOR_PASSWORD_HASH = hashPassword('operator-pass');
});

// spaced apart per vitest worker, as the other served-example cases are, so two files never ask for one port
const PORT = 8310 + Number(process.env.VITEST_POOL_ID ?? 0) * 16;

describe('updating a customer kept in memory', () => {
  updating({ profile: 'local', port: PORT, who: { username: 'bo', password: 'bo-pass' } });
});

describe.skipIf(!url)('updating a customer kept in PostgreSQL', () => {
  updating({ profile: 'production', port: PORT + 1, who: { username: 'operator', password: 'operator-pass' } });
});
