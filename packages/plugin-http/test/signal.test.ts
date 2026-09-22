/**
 * `request` honours the signal it is handed (RFC 0011): a site's retry repeats a request the upstream failed, a
 * site's `timeoutMs` stops one the connection would have let run for ten seconds, and a run cancelled from outside
 * stops the fetch in flight. Each test runs the example's `get-row.graph.json`, edited as the test says, against a
 * scripted upstream of its own.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { type Compiled, checkTree, runGraph } from '@wilanis/compiler';
import { loadTree } from '@wilanis/core';
import auth from '@wilanis/plugin-auth';
import blobs from '@wilanis/plugin-blob';
import otel from '@wilanis/plugin-otel';
import reload from '@wilanis/plugin-reload';
import schedule from '@wilanis/plugin-schedule';
import storage from '@wilanis/plugin-storage';
import memory from '@wilanis/plugin-storage-memory';
import postgres from '@wilanis/plugin-storage-postgres';
import { BUILTIN_PLUGINS, embedderFor } from '@wilanis/runtime';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import http from '../src/index.js';
import { firstRow, INCLUDES, listening, localCopy, SECRET, UPSTREAM } from './harness.js';

const PORT = UPSTREAM + 1;
const GRAPH = 'features/customers/data/get-row.graph.json';

/** What the upstream does with the next request: answer each status in turn, or hold the socket and never answer. */
const script: { statuses: number[]; hold: boolean } = { statuses: [], hold: false };
/** Every request the upstream received, and whether its socket closed before it was answered. */
const seen: { closed: boolean }[] = [];
let received: () => void = () => {};

/** An upstream that answers one row, with the status the script names next, or holds the request open. */
function scripted(): Server {
  return createServer((_request, response) => {
    const entry = { closed: false };
    seen.push(entry);
    response.on('close', () => {
      if (!response.writableEnded) entry.closed = true;
    });
    received();
    if (script.hold) return;
    const status = script.statuses.shift() ?? 200;
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(status === 200 ? firstRow() : 'Service Unavailable'));
  });
}

let server: Server;
let stopUpstream: () => Promise<void>;
const dirs: string[] = [];

beforeAll(async () => {
  server = scripted();
  stopUpstream = await listening(server, PORT);
  process.env.CUSTOMERS_JWT_SECRET = SECRET;
  process.env.CUSTOMERS_DATABASE_URL = 'postgres://customers:customers@localhost:5432/customers';
});

afterEach(() => {
  script.statuses = [];
  script.hold = false;
  seen.length = 0;
  server.closeAllConnections();
});

afterAll(async () => {
  await stopUpstream();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * The example pointed at the scripted upstream, with `said` written on the `fetched` node of get-row.graph.json,
 * checked, and the graph compiled under `live`; with the environment its handlers see.
 */
function getRow(said: Record<string, unknown>): { compiled: Compiled; env: Record<string, unknown> } {
  const dir = localCopy();
  dirs.push(dir);
  const connection = join(dir, 'connections/customers-api.connection.json');
  const conn = JSON.parse(readFileSync(connection, 'utf8'));
  conn.settings.baseUrl = `http://localhost:${PORT}/api/v1`;
  writeFileSync(connection, JSON.stringify(conn));
  const graph = JSON.parse(readFileSync(join(dir, GRAPH), 'utf8'));
  Object.assign(
    graph.nodes.find((node: { id: string }) => node.id === 'fetched'),
    said,
  );
  writeFileSync(join(dir, GRAPH), JSON.stringify(graph));
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
    },
    INCLUDES,
  );
  expect(checkTree(load).items).toEqual([]);
  const embedder = embedderFor(load, { profile: 'live' });
  return { compiled: embedder.graph(`@features/customers/data/get-row.graph.json`), env: embedder.env };
}

describe('request honours the signal it is handed', () => {
  it('a GET the upstream answered 503 is tried again under the guide retry, and the 200 stands', async () => {
    const { compiled, env } = getRow({ timeoutMs: 5000, retry: { times: 2, backoffMs: 1, when: 'status >= 500' } });
    script.statuses = [503, 200];
    const report = await runGraph(compiled, { initial: { in: { id: '1' } }, env });
    expect(report.status).toBe('done');
    expect(report.output).toMatchObject({ id: '1', name: 'Ada' });
    expect(report.nodes.fetched.handler).toBe('@http/http.port.json#request');
    expect(report.nodes.fetched.attempts).toHaveLength(1);
    expect(report.nodes.fetched.attempts?.[0].error).toBe('answer retried: status >= 500');
    expect(seen).toHaveLength(2);
  });

  it("a site's timeoutMs stops a request the connection's 10 s would have let hang", async () => {
    const { compiled, env } = getRow({ timeoutMs: 50 });
    script.hold = true;
    const startedAt = Date.now();
    const report = await runGraph(compiled, { initial: { in: { id: '1' } }, env });
    const took = Date.now() - startedAt;
    expect(report.status).toBe('failed');
    expect(report.nodes.fetched.status).toBe('failed');
    expect(report.nodes.fetched.error).toBe('timed out after 50ms');
    expect(took).toBeGreaterThanOrEqual(45);
    expect(took).toBeLessThan(1000);
    // the fetch itself was aborted, not abandoned: the upstream saw the socket close
    await expect.poll(() => seen[0]?.closed).toBe(true);
  });

  it('a run signal aborted mid-request rejects the fetch', async () => {
    const { compiled, env } = getRow({});
    script.hold = true;
    const arrived = new Promise<void>(done => {
      received = done;
    });
    const control = new AbortController();
    const startedAt = Date.now();
    const running = runGraph(compiled, { initial: { in: { id: '1' } }, env, signal: control.signal });
    await arrived;
    control.abort();
    const report = await running;
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(report.nodes.fetched.status).toBe('failed');
    expect(report.nodes.fetched.error).toMatch(/abort/i);
    await expect.poll(() => seen[0]?.closed).toBe(true);
  });
});
