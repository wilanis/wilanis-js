/**
 * A write that repeats a `unique` the store declares is a conflict with what is kept, not a fault of the
 * upstream. `customers.store.json` says `unique: [["email"]]`; `put` honours it and hands back `violated`
 * naming the constraint, and `store-and-latest` routes on that to refuse as `conflict`, which the two write
 * routes map to 409. Before the branch existed the same import read as `502 upstream`, saying the store had
 * broken when it had done exactly what the document asked (issue #484).
 *
 * The tree is the example served under `local`, over its own port, and the calls go over HTTP: the status is
 * the route's and the message is the graph's, so both are read where the caller reads them. The store is the
 * memory engine's, so nothing here outlives the process.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import { loadTree } from '@wilanis/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { start } from '../src/index.js';
import { EXAMPLE, INCLUDES, PLUGINS } from './example-harness.js';

// spaced apart per vitest worker, since test files run in parallel and a fixed port is one two of them can
// ask for at once: the second gets EADDRINUSE and the whole file fails on the hook that was starting a server
const PORT = 8300 + (Number(process.env.VITEST_POOL_ID ?? 0) % 32) * 16;
let dir: string;
let stop: () => Promise<void>;
let token: string;

/** The example, its server on a port of its own, without what a copy must not carry. */
function localCopy(): string {
  const copy = mkdtempSync(join(tmpdir(), 'wilanis-unique-'));
  cpSync(EXAMPLE, copy, {
    recursive: true,
    filter: path => !path.includes('node_modules') && !path.includes('.wilanis'),
  });
  const at = join(copy, 'project.json');
  const project = JSON.parse(readFileSync(at, 'utf8'));
  project.plugins.find((plugin: { use: string }) => plugin.use === '@http').settings.port = PORT;
  writeFileSync(at, JSON.stringify(project));
  return copy;
}

/** A response as a case reads it: the status and the JSON body. */
const answered = async (response: Response) => ({ status: response.status, body: await response.json() });

/** One request to the served tree, as the registrar. */
const call = (path: string, init: RequestInit & { type?: string } = {}) =>
  fetch(`http://localhost:${PORT}${path}`, {
    ...init,
    headers: { 'content-type': init.type ?? 'application/json', authorization: `Bearer ${token}` },
  }).then(answered);

/** POST /customers.csv with these rows under the header the route reads. */
const imported = (rows: string[]) =>
  call('/customers.csv', { method: 'POST', type: 'text/csv', body: `name,email,tier\n${rows.join('\n')}\n` });

/** The addresses the store holds, read through the tree's own route. */
const kept = async () =>
  (await call('/customers')).body.map((customer: { email: string }) => customer.email).sort() as string[];

beforeAll(async () => {
  process.env.CUSTOMERS_JWT_SECRET = 'a-secret-of-thirty-two-bytes-or-more!';
  // every connection's secrets are substituted whatever the profile; nothing here dials this one
  process.env.CUSTOMERS_DATABASE_URL = 'postgres://customers:customers@localhost:5432/customers';
  dir = localCopy();
  const load = loadTree(dir, PLUGINS, INCLUDES);
  expect(checkTree(load).items).toEqual([]);
  ({ stop } = await start(load, { log: () => {}, profile: 'local' }));
  const signedIn = await call('/api/v1/auth-employees', {
    method: 'POST',
    body: JSON.stringify({ username: 'bo', password: 'bo-pass' }),
  });
  token = signedIn.body.accessToken;
});

afterAll(async () => {
  await stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('registering a customer the store already keeps', () => {
  it('a single row is registered and answers 201, as before', async () => {
    const answer = await imported(['Ada,ada@one.example,bronze']);
    expect(answer.status).toBe(201);
    expect(answer.body).toEqual([{ id: expect.any(String), name: 'Ada', email: 'ada@one.example', tier: 'bronze' }]);
  });

  it('two rows of one email answer 409 as conflict, naming the unique they repeat, and register nothing', async () => {
    const answer = await imported(['Bo,bo@twice.example,silver', 'Bo again,bo@twice.example,gold']);
    expect(answer).toEqual({
      status: 409,
      body: {
        reason: 'conflict',
        message: 'a customer already uses bo@twice.example (unique [email])',
      },
    });
    // the import is one transaction: the first row went with the second, and the earlier import stayed
    expect(await kept()).toEqual(['ada@one.example']);
  });

  it('another address is another customer, and is registered', async () => {
    const answer = await imported(['Cy,cy@one.example,silver']);
    expect(answer.status).toBe(201);
    expect(await kept()).toEqual(['ada@one.example', 'cy@one.example']);
  });

  it('POST /customers of an address already kept is the same conflict, since one graph is behind both routes', async () => {
    const answer = await call('/customers', {
      method: 'POST',
      body: JSON.stringify({ name: 'Ada again', email: 'ada@one.example', tier: 'bronze' }),
    });
    expect(answer).toEqual({
      status: 409,
      body: { reason: 'conflict', message: 'a customer already uses ada@one.example (unique [email])' },
    });
  });
});
