/**
 * A write that repeats a `unique` the store declares is a conflict with what is kept, not a fault of the
 * upstream. `customers.store.json` says `unique: [["url", "method"]]`; `put` honours it and hands back
 * `violated` naming the constraint, and `store-and-latest` routes on that to refuse as `conflict`, which the
 * two write routes map to 409. Before the branch existed the same import read as `502 upstream`, saying the
 * store had broken when it had done exactly what the document asked (issue #484).
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

const PORT = 8097;
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

/** One request to the served tree, as the recorder. */
const call = (path: string, init: RequestInit & { type?: string } = {}) =>
  fetch(`http://localhost:${PORT}${path}`, {
    ...init,
    headers: { 'content-type': init.type ?? 'application/json', authorization: `Bearer ${token}` },
  }).then(answered);

/** POST /monitor.csv with these rows under the header the route reads. */
const imported = (rows: string[]) =>
  call('/monitor.csv', { method: 'POST', type: 'text/csv', body: `url,method\n${rows.join('\n')}\n` });

/** The urls the store holds, read through the tree's own route. */
const kept = async () => (await call('/monitor')).body.map((entry: { url: string }) => entry.url).sort() as string[];

beforeAll(async () => {
  process.env.MONITOR_JWT_SECRET = 'a-secret-of-thirty-two-bytes-or-more!';
  // every connection's secrets are substituted whatever the profile; nothing here dials this one
  process.env.MONITOR_DATABASE_URL = 'postgres://monitor:monitor@localhost:5432/monitor';
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

describe('importing a call the store already records', () => {
  it('a single row is recorded and answers 201, as before', async () => {
    const answer = await imported(['https://one.example/,GET']);
    expect(answer.status).toBe(201);
    expect(answer.body).toEqual([
      { id: expect.any(String), url: 'https://one.example/', method: 'GET', agent: 'wilanis-example/0.1.0' },
    ]);
  });

  it('two rows of one (url, method) answer 409 as conflict, naming the unique they repeat, and record nothing', async () => {
    const answer = await imported(['https://twice.example/,GET', 'https://twice.example/,GET']);
    expect(answer).toEqual({
      status: 409,
      body: {
        reason: 'conflict',
        message: 'an entry already records GET https://twice.example/ (unique [url, method])',
      },
    });
    // the import is one transaction: the first row went with the second, and the earlier import stayed
    expect(await kept()).toEqual(['https://one.example/']);
  });

  it('the same url under another method is another call, and is recorded', async () => {
    const answer = await imported(['https://one.example/,POST']);
    expect(answer.status).toBe(201);
    expect(await kept()).toEqual(['https://one.example/', 'https://one.example/']);
  });

  it('POST /monitor of a call already recorded is the same conflict, since one graph is behind both routes', async () => {
    const answer = await call('/monitor', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://one.example/', method: 'GET' }),
    });
    expect(answer).toEqual({
      status: 409,
      body: { reason: 'conflict', message: 'an entry already records GET https://one.example/ (unique [url, method])' },
    });
  });
});
