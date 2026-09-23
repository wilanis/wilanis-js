import { rmSync } from 'node:fs';
import { checkTree } from '@wilanis/compiler';
import { loadTree } from '@wilanis/core';
import auth from '@wilanis/plugin-auth';
import blobs from '@wilanis/plugin-blob';
import otel from '@wilanis/plugin-otel';
import reload from '@wilanis/plugin-reload';
import s3 from '@wilanis/plugin-s3';
import schedule from '@wilanis/plugin-schedule';
import storage from '@wilanis/plugin-storage';
import memory from '@wilanis/plugin-storage-memory';
import postgres from '@wilanis/plugin-storage-postgres';
import { BUILTIN_PLUGINS, start } from '@wilanis/runtime';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http, { encode } from '../src/index.js';
import { outcomeWords } from '../src/said.js';
import {
  caller,
  fakeUpstream,
  firstRow,
  INCLUDES,
  type InFlight,
  listening,
  localCopy,
  SECRET,
  signInAsRegistrar,
  UPSTREAM,
} from './harness.js';

let stopUpstream: () => Promise<void>;
let stop: () => Promise<void>;
let token = '';
let dir: string;
const rows: Record<string, unknown>[] = [firstRow()];
const logs: string[] = [];
/** The ids of every fire the server told its observers of, as the trace carries them. */
const runs: string[] = [];
/** The one log line for a request, found by what it asked and answered. */
const lineFor = (asked: string, status: number) =>
  logs.filter(line => line.startsWith(`${asked} → ${status} (`)).at(-1) ?? '';
/** How many DELETEs the upstream is serving right now, and the most it ever served at once. */
const inFlight: InFlight = { now: 0, peak: 0 };
const call = caller(() => token);

beforeAll(async () => {
  stopUpstream = await listening(fakeUpstream({ rows, inFlight }), UPSTREAM);
  process.env.CUSTOMERS_JWT_SECRET = SECRET;
  // every connection's secrets are substituted whatever the profile, and the example now has one over a
  // database; nothing here dials it, so any well-formed URL will do
  process.env.CUSTOMERS_DATABASE_URL = 'postgres://customers:customers@localhost:5432/customers';
  dir = localCopy();
  // a copy outside the workspace cannot resolve plugins[].from through node_modules, so the plugins are handed in
  const load = loadTree(
    dir,
    {
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
      '@s3': s3,
    },
    INCLUDES,
  );
  expect(checkTree(load).items).toEqual([]);
  ({ stop } = await start(load, {
    log: line => logs.push(line),
    profile: 'live',
    observe: trace => runs.push(String(trace.attributes['wilanis.run.id'])),
  }));
  token = await signInAsRegistrar();
});

afterAll(async () => {
  await stop();
  await stopUpstream();
  rmSync(dir, { recursive: true, force: true });
});

describe('http trigger kind against a mockapi-shaped upstream', () => {
  it('lists everything, pruned to the edge shape', async () => {
    const answer = await call('GET', '/customers', undefined, true);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual([{ id: '1', name: 'Ada', email: 'ada@a.example', tier: 'bronze', active: true }]);
  });
  it('narrows by tier through the declared statement', async () => {
    const answer = await call('GET', '/customers?tier=gold', undefined, true);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual([]);
  });
  it('400 on a query value outside the enum', async () => {
    expect((await call('GET', '/customers?tier=bogus', undefined, true)).status).toBe(400);
  });
  it('401 as anonymous on a read too: listing the customers takes a signed-in caller', async () => {
    const answer = await call('GET', '/customers');
    expect(answer.status).toBe(401);
    expect(answer.body.reason).toBe('anonymous');
  });
  it('401 as anonymous without a token on a gated route: the policy refused, and the route maps the reason', async () => {
    const answer = await call('POST', '/customers', { name: 'Bo', email: 'bo@b.example', tier: 'silver' });
    expect(answer.status).toBe(401);
    expect(answer.body).toEqual({ reason: 'anonymous', message: 'sign in first: no token was presented' });
  });
  it('registers with the registrar the domain chose, answers 201', async () => {
    const answer = await call('POST', '/customers', { name: 'Bo', email: 'bo@b.example', tier: 'silver' }, true);
    expect(answer.status).toBe(201);
    expect(answer.body).toEqual({ id: '2', name: 'Bo', email: 'bo@b.example', tier: 'silver', active: true });
  });
  it('400 on an undeclared body field (closed edge shape)', async () => {
    expect(
      (await call('POST', '/customers', { name: 'Cy', email: 'cy@c.example', tier: 'bronze', sneaky: 1 }, true)).status,
    ).toBe(400);
  });
  it('404 for a route no trigger declares, and the edge says so on its line though no run was fired', async () => {
    expect((await call('GET', '/nope')).status).toBe(404);
    expect(lineFor('GET /nope', 404)).toMatch(/^GET \/nope → 404 \(\d+ms, no trigger\)$/);
  });
  it('logs a policy ending the run as the gate word it said, and an edge refusal as what the caller can fix', async () => {
    await call('POST', '/customers', { name: 'Bo', email: 'bo@b.example', tier: 'silver' });
    expect(lineFor('POST /customers', 401)).toContain('denied: anonymous');
    await call('POST', '/customers', { name: 'Cy', email: 'cy@c.example', tier: 'bronze', sneaky: 1 }, true);
    expect(lineFor('POST /customers', 400)).toContain('body does not conform');
  });
  it('deletes a batch of ids: one DELETE each, paced by the connection throttle, answered once all are gone', async () => {
    for (const id of [3, 4, 5, 6, 7])
      rows.push({ id: String(id), name: `Person ${id}`, email: `p${id}@x.example`, tier: 'bronze', active: true });
    inFlight.peak = 0;
    const answer = await call('DELETE', '/customers', { ids: ['3', '4', '5', '6', '7'] }, true);
    expect(answer.status).toBe(200);
    // the answer is every deleted customer, in the order asked, pruned to the edge shape
    expect(answer.body).toEqual(
      [3, 4, 5, 6, 7].map(id => ({
        id: String(id),
        name: `Person ${id}`,
        email: `p${id}@x.example`,
        tier: 'bronze',
        active: true,
      })),
    );
    // and by the time it arrived, the upstream had none of them left
    expect(rows.map(row => row.id)).toEqual(['1', '2']);
    // five requests were issued, never more than two at once
    expect(inFlight.peak).toBe(2);
  });
  it('refuses the whole batch as missing when one id does not exist, after every deletion settled', async () => {
    rows.push({ id: '8', name: 'Person 8', email: 'p8@x.example', tier: 'bronze' });
    const answer = await call('DELETE', '/customers', { ids: ['8', 'nope'] }, true);
    // the element's refusal is the map's, and the map's is the route's: the reason travels up as it is
    expect(answer.status).toBe(404);
    expect(answer.body).toEqual({ reason: 'missing', message: 'no customer nope' });
    expect(rows.map(row => row.id)).toEqual(['1', '2']);
  });
  it('answers a declared refusal with the status the route maps its reason to, and the reason and message as the body', async () => {
    const answer = await call('GET', '/customers/zzz', undefined, true);
    expect(answer.status).toBe(404);
    expect(answer.body).toEqual({ reason: 'missing', message: 'no customer zzz' });
    // the line says the outcome in the trace's words, not the report's status
    expect(lineFor('GET /customers/zzz', 404)).toMatch(/customer\.port\.json#get refused: missing\)$/);
  });
  it('a refusal whose reason the route does not map is a fault, not a silent status', () => {
    const trigger = {
      kind: '@http/http.trigger-kind.json',
      settings: { route: '/x', method: 'GET', response: { refusals: { missing: 404 } } },
      fire: { run: 'p#op' },
    } as any;
    const refused = {
      graph: 'g',
      status: 'failed' as const,
      nodes: { n: { status: 'failed' as const, error: 'nope', reason: 'conflict' } },
      startedAt: 0,
      endedAt: 0,
    };
    // answered as a fault: the message the author wrote for a reason the route never mapped is not said either
    expect(encode(trigger, refused, 'r1')).toEqual({ status: 500, body: { error: 'fault', run: 'r1' } });
    expect(encode(trigger, { ...refused, nodes: { n: { ...refused.nodes.n, reason: 'missing' } } })).toEqual({
      status: 404,
      body: { reason: 'missing', message: 'nope' },
    });
    // a fault is a 500 that names the run and says nothing of where or why it broke
    expect(encode(trigger, { ...refused, nodes: { n: { status: 'failed' as const, error: 'boom' } } }, 'r2')).toEqual({
      status: 500,
      body: { error: 'fault', run: 'r2' },
    });
    // a run blocked on a root nothing supplied is a wiring hole, answered the same way
    expect(encode(trigger, { ...refused, status: 'blocked', nodes: {}, needs: ['in.id'] } as any, 'r3')).toEqual({
      status: 500,
      body: { error: 'fault', run: 'r3' },
    });
    // where no run was heard, the fault is still a fault
    expect(encode(trigger, { ...refused, nodes: { n: { status: 'failed' as const, error: 'boom' } } })).toEqual({
      status: 500,
      body: { error: 'fault' },
    });
    // a cancelled run is 504 whatever had settled, a mapped refusal that landed late included, and its line says so
    const cancelled = {
      ...refused,
      status: 'cancelled' as const,
      nodes: { n: { ...refused.nodes.n, reason: 'missing' } },
    };
    expect(encode(trigger, cancelled, 'r4')).toEqual({
      status: 504,
      body: { error: 'cancelled: the deadline passed' },
    });
    expect(outcomeWords(cancelled, {}, () => true)).toBe('cancelled');
  });
  it('400 on a batch whose body is not the declared shape', async () => {
    expect((await call('DELETE', '/customers', { ids: 'nope' }, true)).status).toBe(400);
    expect((await call('DELETE', '/customers', undefined, true)).status).toBe(400);
  });
});

describe('files through the blob registry', () => {
  it('uploads a CSV as a blob: the body streams into the registry, the graph gets a handle, every row is registered', async () => {
    const csv = 'name,email,tier\nAda CSV,csv-1@x.example,bronze\n"Bo, CSV",csv-2@x.example,silver\n';
    const answer = await fetch('http://localhost:8099/customers.csv', {
      method: 'POST',
      headers: { 'content-type': 'text/csv', authorization: `Bearer ${token}` },
      body: csv,
    });
    expect(answer.status).toBe(201);
    expect(await answer.json()).toEqual([
      { id: expect.any(String), name: 'Ada CSV', email: 'csv-1@x.example', tier: 'bronze', active: true },
      { id: expect.any(String), name: 'Bo, CSV', email: 'csv-2@x.example', tier: 'silver', active: true },
    ]);
    expect(rows.filter(row => String(row.email).startsWith('csv-'))).toHaveLength(2);
  });
  it('downloads every customer as a CSV: streamed from the registry with its content type, length and filename', async () => {
    const answer = await fetch('http://localhost:8099/customers.csv', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(answer.status).toBe(200);
    expect(answer.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(answer.headers.get('content-disposition')).toBe('attachment; filename="customers.csv"');
    const body = await answer.text();
    expect(Number(answer.headers.get('content-length'))).toBe(Buffer.byteLength(body));
    const lines = body.split('\r\n').filter(Boolean);
    expect(lines[0]).toBe('id,name,email,tier,registrar,active,note');
    expect(lines).toHaveLength(rows.length + 1);
    expect(lines.some(line => line.includes('"Bo, CSV"'))).toBe(true);
  });
  it('a multipart form: the file part streams into the registry as a blob, the text part arrives as a string', async () => {
    const big = `name,email,tier\n${Array.from(
      { length: 2000 },
      (_, index) => `Form ${index},form-${index}@x.example,bronze`,
    ).join('\n')}\n`;
    const form = new FormData();
    form.append('note', 'from a form');
    form.append('file', new Blob([big], { type: 'text/csv' }), 'bulk.csv');
    const before = rows.length;
    const answer = await fetch('http://localhost:8099/customers/upload', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
    expect(answer.status).toBe(201);
    expect(await answer.json()).toHaveLength(2000);
    expect(rows.length).toBe(before + 2000);
  });
  it('a CSV row that is not a customer is a fault of the import, and nothing is recorded', async () => {
    const before = rows.length;
    const answer = await fetch('http://localhost:8099/customers.csv', {
      method: 'POST',
      headers: { 'content-type': 'text/csv', authorization: `Bearer ${token}` },
      body: 'name,email,tier\nNo Tier,notier@x.example,platinum\n',
    });
    expect(answer.status).toBe(500);
    // the caller is told it broke and which run it was; what broke is the log's and the trace's
    const body = await answer.json();
    expect(body).toEqual({ error: 'fault', run: expect.any(String) });
    expect(runs).toContain(body.run);
    const line = lineFor('POST /customers.csv', 500);
    expect(line).toContain('failed at ');
    expect(line).toContain('row 2.tier');
    expect(line.endsWith(`  run=${body.run}`)).toBe(true);
    expect(rows.length).toBe(before);
  });
  it('a body of another content type than the route consumes is a 415, and an upload with no body is a 400', async () => {
    const answer = await fetch('http://localhost:8099/customers.csv', {
      method: 'POST',
      headers: { 'content-type': 'application/pdf' },
      body: '%PDF',
    });
    expect(answer.status).toBe(415);
    expect((await answer.json()).error).toBe('this route consumes text/csv, not application/pdf');
    expect(
      (await fetch('http://localhost:8099/customers.csv', { method: 'POST', headers: { 'content-type': 'text/csv' } }))
        .status,
    ).toBe(400);
  });
});

describe('an upstream that answers nothing', () => {
  it('is the upstream a switch catches it as, and a fault that says nothing of what broke where none does', async () => {
    await stopUpstream();
    try {
      const headers = { authorization: `Bearer ${token}` };
      // get-row catches the GET that got no answer and routes it to its refusal of upstream, which the route maps
      const caught = await fetch('http://localhost:8099/customers/1', { headers });
      expect(caught.status).toBe(502);
      expect(await caught.json()).toEqual({ reason: 'upstream', message: 'the customer API could not be reached' });
      expect(lineFor('GET /customers/1', 502)).toContain('customer.port.json#get refused: upstream');
      // list-rows catches nothing, so the same outage is the kind's one answer: the run named, nothing of the node
      const answer = await fetch('http://localhost:8099/customers', { headers });
      expect(answer.status).toBe(500);
      const text = await answer.text();
      const body = JSON.parse(text);
      expect(body).toEqual({ error: 'fault', run: expect.any(String) });
      expect(runs).toContain(body.run);
      expect(text).not.toContain('fetch');
      // the log line is where the operator finds what broke, under the id the caller was handed
      const line = lineFor('GET /customers', 500);
      expect(line).toMatch(/customer\.port\.json#list failed at '[^']+': /);
      expect(line.endsWith(`  run=${body.run}`)).toBe(true);
    } finally {
      stopUpstream = await listening(fakeUpstream({ rows, inFlight }), UPSTREAM);
    }
  });
});
