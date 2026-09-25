/**
 * The limits an http route keeps (RFC 0012): a run past its deadline is cancelled and answered 504, a body past its
 * bound is answered 413 before a codec has finished with it, an upstream's answer past the connection's bound fails
 * the request node, and X004 refuses a limit that could never be met. The example is copied with the limits written
 * in, served on a port of its own against a fake upstream that can stop answering.
 */
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { checkTree } from '@wilanis/compiler';
import { type BlobStore, loadTree } from '@wilanis/core';
import { FileBlobStore, start } from '@wilanis/runtime';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { multipart } from '../src/codecs.js';
import { bounded } from '../src/limit.js';
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
import { EXAMPLE_PLUGINS as PLUGINS } from './plugins.js';

const BACK = UPSTREAM + 2;
const PORT = UPSTREAM + 3;
const EDGE = 'features/customers/edge';

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
 * bytes at most. The tree's blob registry is kept under `.blobs` in the copy, so a test can see what it holds.
 */
function withLimits(edit: Edit) {
  edit('project.json', project => {
    Object.assign(httpSettings(project), { port: PORT, deadlineMs: 500, maxBodyBytes: 4096 });
    project.blobs = { ...project.blobs, dir: '.blobs' };
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
  // the example tries a faulted GET again after 200 ms, past the route's 50 ms: without the retry an answer past the
  // connection's bound is seen as the fault it is, not as the deadline it would otherwise run into
  edit('features/customers/data/get-row.graph.json', graph => {
    delete graph.nodes.find((node: { id: string }) => node.id === 'fetched').retry;
  });
}

/** A copy of the example, edited, and loaded with every plugin handed in. */
function loaded(edits: (edit: Edit) => void) {
  const dir = localCopy(edits);
  dirs.push(dir);
  return loadTree(dir, PLUGINS, INCLUDES);
}

/**
 * A body sent as a stream a kilobyte at a time, a tick apart, so it carries no content-length, the bound has to count
 * it as it arrives, and a reader has begun on it by the time it is cut.
 */
const streamed = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  return {
    body: new ReadableStream({
      async pull(control) {
        if (at >= bytes.length) return control.close();
        if (at > 0) await new Promise(done => setTimeout(done, 5));
        control.enqueue(bytes.subarray(at, at + 1024));
        at += 1024;
      },
    }),
    duplex: 'half',
  } as unknown as RequestInit;
};

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
    // nothing of the cut upload is left in the tree's registry
    expect(readdirSync(join(dirs[0], '.blobs'))).toEqual([]);
  });

  it("a multipart upload cut inside its file part is 413, and the part's blob write settles rather than hanging", async () => {
    const boundary = 'cut-here';
    const form = [
      `--${boundary}`,
      'content-disposition: form-data; name="note"',
      '',
      'a note',
      `--${boundary}`,
      'content-disposition: form-data; name="file"; filename="bulk.csv"',
      'content-type: text/csv',
      '',
      `name,email,tier\n${'Row,row@x.example,bronze\n'.repeat(400)}`,
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const answered = fetch(`http://localhost:${PORT}/customers/upload`, {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${token}` },
      ...streamed(form),
    });
    // a write left open would hold the answer forever: give it a second, then say so
    const hung = new Promise<'hung'>(done => setTimeout(() => done('hung'), 1000));
    const answer = await Promise.race([answered, hung]);
    expect(answer).not.toBe('hung');
    expect((answer as Response).status).toBe(413);
    expect(await (answer as Response).json()).toEqual({ error: 'body exceeds 4096 bytes' });
  });

  it("a multipart body cut inside its file part fails that part's blob write rather than leaving it open", async () => {
    const boundary = 'cut-here';
    const head = `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="bulk.csv"\r\n\r\n`;
    // a tick apart, so the part has begun its write before the bound cuts the body
    async function* chunks() {
      for (const chunk of [Buffer.from(head), Buffer.alloc(1024, 'a'), Buffer.alloc(1024, 'b')]) {
        yield chunk;
        await new Promise(done => setTimeout(done, 5));
      }
    }
    // the tree's registry on disk, watched: how each write ended
    const store = new FileBlobStore(dirs[0]);
    const writes: string[] = [];
    const registry = {
      async put(source: Readable, meta: { contentType: string; filename?: string }) {
        try {
          const handle = await store.put(source, meta);
          writes.push('stored');
          return handle;
        } catch (error) {
          writes.push(`failed: ${(error as Error).message}`);
          throw error;
        }
      },
    } as unknown as BlobStore;
    const body = bounded(Readable.from(chunks()), { max: 1500, what: 'body', rest: 'drop' });
    await expect(
      multipart.decode(body.stream, `multipart/form-data; boundary=${boundary}`, undefined, registry),
    ).rejects.toThrow('body exceeds 1500 bytes');
    // the decode waited for the write it began: by the time it rejected, the write had failed too
    expect(writes).toEqual(['failed: body exceeds 1500 bytes']);
    // and the registry unlinked the half-written file (#581): nothing of the cut part is left on disk
    expect(readdirSync(store.dir)).toEqual([]);
    store.destroy();
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
      // list-rows catches nothing, so the node the bound broke is the run's fault
      const answer = await call('GET', '/customers', undefined, true);
      expect(answer.status).toBe(500);
      expect(answer.body).toEqual({ error: 'fault', run: expect.any(String) });
      expect(lineFor('GET /customers', 500)).toContain('answer body exceeds 600 bytes');
    } finally {
      upstream.rows.pop();
    }
  });

  it('is the declared upstream where a switch catches the node it broke: get-row answers 502', async () => {
    upstream.rows.push({ ...firstRow(), id: 'big', name: 'y'.repeat(1024) });
    try {
      const answer = await call('GET', '/customers/big', undefined, true);
      expect(answer.status).toBe(502);
      expect(answer.body).toEqual({ reason: 'upstream', message: 'the customer API could not be reached' });
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
