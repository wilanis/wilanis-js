/**
 * The limits an http route keeps (RFC 0012): a run past its deadline is cancelled and answered 504, a body past its
 * bound is answered 413 before a codec has finished with it, an upstream's answer past the connection's bound fails
 * the request node, and X004 refuses a limit that could never be met. The example is copied with the limits written
 * in, served on a port of its own against a fake upstream that can stop answering.
 */
import { rmSync } from 'node:fs';
import { checkTree } from '@wilanis/compiler';
import { loadTree } from '@wilanis/core';
import auth from '@wilanis/plugin-auth';
import blobs from '@wilanis/plugin-blob';
import otel from '@wilanis/plugin-otel';
import reload from '@wilanis/plugin-reload';
import schedule from '@wilanis/plugin-schedule';
import storage from '@wilanis/plugin-storage';
import memory from '@wilanis/plugin-storage-memory';
import postgres from '@wilanis/plugin-storage-postgres';
import { BUILTIN_PLUGINS, start } from '@wilanis/runtime';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import http from '../src/index.js';
import {
  caller,
  type Edit,
  fakeUpstream,
  firstRow,
  httpSettings,
  INCLUDES,
  listening,
  localCopy,
  SECRET,
  signInAsRegistrar,
  UPSTREAM,
  type Upstream,
} from './harness.js';

const BACK = UPSTREAM + 2;
const PORT = UPSTREAM + 3;
const EDGE = 'features/customers/edge';
const PLUGINS = {
  ...BUILTIN_PLUGINS,
  '@http': http,
  '@blob': blobs,
  '@reload': reload,
  '@auth': auth,
  '@schedule': schedule,
  '@storage': storage,
  '@storage-memory': memory,
  '@storage-postgres': postgres,
  '@otel': otel,
};

const upstream: Upstream = { rows: [firstRow()], inFlight: { now: 0, peak: 0 } };
const server = fakeUpstream(upstream);
const logs: string[] = [];
const dirs: string[] = [];
let stopUpstream: () => Promise<void>;
let stop: () => Promise<void>;
let token = '';
const call = caller(() => token, PORT);
/** The one log line for a request, found by what it asked and answered. */
const lineFor = (asked: string, status: number) =>
  logs.filter(line => line.startsWith(`${asked} → ${status} (`)).at(-1) ?? '';

/**
 * The example with limits: every route has 500 ms and 4 KB from the plugin's settings, GET /customers/{id} 50 ms of
 * its own, the CSV upload 64 bytes of its own, a batch removal two ids at most, and the customer API's answers 600
 * bytes at most.
 */
function withLimits(edit: Edit) {
  edit('project.json', project => {
    Object.assign(httpSettings(project), { port: PORT, deadlineMs: 500, maxBodyBytes: 4096 });
  });
  edit(`${EDGE}/get-customer.trigger.json`, trigger => {
    trigger.settings.deadlineMs = 50;
  });
  edit(`${EDGE}/import-customers.trigger.json`, trigger => {
    trigger.settings.maxBodyBytes = 64;
  });
  edit(`${EDGE}/DeleteRequest.shape.json`, shape => {
    shape.fields.ids.maxItems = 2;
  });
  edit('connections/customers-api.connection.json', connection => {
    connection.settings.baseUrl = `http://localhost:${BACK}/api/v1`;
    connection.settings.maxBodyBytes = 600;
  });
}

/** A copy of the example, edited, and loaded with every plugin handed in. */
function loaded(edits: (edit: Edit) => void) {
  const dir = localCopy(edits);
  dirs.push(dir);
  return loadTree(dir, PLUGINS, INCLUDES);
}

/** A body sent as a stream, so it carries no content-length and the bound has to count it as it arrives. */
const streamed = (text: string) =>
  ({
    body: new ReadableStream({
      start(control) {
        control.enqueue(new TextEncoder().encode(text));
        control.close();
      },
    }),
    duplex: 'half',
  }) as unknown as RequestInit;

beforeAll(async () => {
  stopUpstream = await listening(server, BACK);
  process.env.CUSTOMERS_JWT_SECRET = SECRET;
  process.env.CUSTOMERS_DATABASE_URL = 'postgres://customers:customers@localhost:5432/customers';
  const load = loaded(withLimits);
  expect(checkTree(load).items).toEqual([]);
  ({ stop } = await start(load, { log: line => logs.push(line), profile: 'live' }));
  token = await signInAsRegistrar(PORT);
});

afterEach(() => {
  upstream.hold = false;
  server.closeAllConnections();
});

afterAll(async () => {
  await stop();
  await stopUpstream();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('a deadline', () => {
  it("the route's own: GET /customers/{id} against an upstream that stopped answering is 504 after 50 ms", async () => {
    upstream.hold = true;
    const startedAt = Date.now();
    const answer = await call('GET', '/customers/1', undefined, true);
    // well under the plugin's 500 ms and the connection's 10 s: the route's deadline is the deadline
    expect(Date.now() - startedAt).toBeLessThan(450);
    expect(answer.status).toBe(504);
    expect(answer.body).toEqual({ error: 'cancelled: the deadline passed' });
    expect(lineFor('GET /customers/1', 504)).toMatch(/customer\.port\.json#get cancelled\)$/);
  });

  it("the plugin's, for a route that writes none: GET /customers is 504 after 500 ms", async () => {
    upstream.hold = true;
    const startedAt = Date.now();
    const answer = await call('GET', '/customers', undefined, true);
    const took = Date.now() - startedAt;
    expect(took).toBeGreaterThanOrEqual(450);
    expect(took).toBeLessThan(5000);
    expect(answer.status).toBe(504);
    expect(answer.body).toEqual({ error: 'cancelled: the deadline passed' });
  });

  it('a run that answers inside its deadline is answered as ever', async () => {
    const answer = await call('GET', '/customers/1', undefined, true);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ id: '1', name: 'Ada' });
  });
});

describe('a body past its bound', () => {
  const tooBig = { name: 'x'.repeat(5000), email: 'big@x.example', tier: 'bronze' };

  it('a JSON body that says it weighs more than 4 KB is 413 unread, and nothing is registered', async () => {
    const before = upstream.rows.length;
    const answer = await call('POST', '/customers', tooBig, true);
    expect(answer.status).toBe(413);
    expect(answer.body).toEqual({ error: 'body exceeds 4096 bytes' });
    expect(upstream.rows).toHaveLength(before);
    // refused at the edge: no run was fired, so the line names none
    expect(lineFor('POST /customers', 413)).toMatch(/\(\d+ms, body exceeds 4096 bytes\)$/);
  });

  it('a JSON body streamed with no length is cut once it passes 4 KB, 413, and nothing is registered', async () => {
    const before = upstream.rows.length;
    const answer = await fetch(`http://localhost:${PORT}/customers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      ...streamed(JSON.stringify(tooBig)),
    });
    expect(answer.status).toBe(413);
    expect(await answer.json()).toEqual({ error: 'body exceeds 4096 bytes' });
    expect(upstream.rows).toHaveLength(before);
  });

  it("a CSV upload past the route's own 64 bytes is 413 before the blob codec has stored it", async () => {
    const before = upstream.rows.length;
    const csv = `name,email,tier\n${Array.from({ length: 5 }, (_, at) => `Row ${at},row-${at}@x.example,bronze`).join('\n')}\n`;
    const answer = await fetch(`http://localhost:${PORT}/customers.csv`, {
      method: 'POST',
      headers: { 'content-type': 'text/csv', authorization: `Bearer ${token}` },
      ...streamed(csv),
    });
    expect(answer.status).toBe(413);
    expect(await answer.json()).toEqual({ error: 'body exceeds 64 bytes' });
    expect(upstream.rows).toHaveLength(before);
  });

  it('a body under the bound is read as ever', async () => {
    const answer = await call('POST', '/customers', { name: 'Bo', email: 'bo@b.example', tier: 'silver' }, true);
    expect(answer.status).toBe(201);
  });
});

describe("an upstream's answer past the connection's bound", () => {
  it('fails the request node as a fault: 500, and the line says the answer body exceeds 600 bytes', async () => {
    upstream.rows.push({ ...firstRow(), id: 'big', name: 'y'.repeat(1024) });
    try {
      const answer = await call('GET', '/customers/big', undefined, true);
      expect(answer.status).toBe(500);
      expect(answer.body).toEqual({ error: 'fault', run: expect.any(String) });
      expect(lineFor('GET /customers/big', 500)).toContain('answer body exceeds 600 bytes');
    } finally {
      upstream.rows.pop();
    }
  });
});

describe('a list past its maxItems', () => {
  it('DELETE /customers with three ids against maxItems 2 is 400, and nothing is removed', async () => {
    const before = upstream.rows.length;
    const answer = await call('DELETE', '/customers', { ids: ['1', '2', '3'] }, true);
    expect(answer.status).toBe(400);
    expect(answer.body.error).toContain('$.ids: at most 2 items');
    expect(upstream.rows).toHaveLength(before);
  });
});

describe('X004', () => {
  it('refuses a deadline or a bound that is not a whole number of 1 or more, wherever it is written', () => {
    const load = loaded(edit => {
      edit(`${EDGE}/get-customer.trigger.json`, trigger => {
        trigger.settings.deadlineMs = 0;
      });
      edit('project.json', project => {
        httpSettings(project).maxBodyBytes = -1;
      });
      edit('connections/customers-api.connection.json', connection => {
        connection.settings.maxBodyBytes = 1.5;
      });
    });
    const refused = checkTree(load).items.filter(item => item.code === 'X004');
    expect(refused.map(item => [item.file, item.at])).toEqual(
      expect.arrayContaining([
        ['@features/customers/edge/get-customer.trigger.json', 'settings/deadlineMs'],
        ['@project.json', 'plugins/@http/settings/maxBodyBytes'],
        ['@connections/customers-api.connection.json', 'settings/maxBodyBytes'],
      ]),
    );
    expect(refused).toHaveLength(3);
    expect(refused[0].hint).toBe('set it to 1 or more, or drop it for no limit');
  });
});
