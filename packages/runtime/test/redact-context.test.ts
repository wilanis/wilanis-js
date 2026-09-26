/**
 * The request a trigger's kind hands, as its reports show it. A queue message's headers and an http request's headers
 * and cookies are where a credential rides, so each kind marks the map secret whole; a graph that reads a header
 * through a resolver shows it as the marker, while the run is handed the value and the trace still correlates by
 * the caller's `traceparent`, which the embedder reads off the request itself (#641).
 */
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import { type LoadResult, loadTree } from '@wilanis/core';
import http from '@wilanis/plugin-http';
import queue from '@wilanis/plugin-queue';
import queueMemory from '@wilanis/plugin-queue-memory';
import { describe, expect, it } from 'vitest';
import { BUILTIN_PLUGINS, embedderFor, type Fired, type Ran, Served } from '../src/index.js';
import { clearIn, fake, nodeNamed, putter, SECRET, vaultTree } from './redact-tree.js';

const PARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const AGENT = '@features/vault/domain/agent.port.json';
const RUN = '@wilanis/node/run.schema.json';
const SWITCH = '@wilanis/node/switch.schema.json';
const MAKE = '@std/object.port.json#make';
const HTTP = '@http/http.trigger-kind.json';
const QUEUE = '@queue/queue.trigger-kind.json';
const PING = '@features/vault/edge/Ping.shape.json';
const JSON_CODEC = '@http/codecs/json.codec.json';
const SEEN_FILE = 'features/vault/domain/Seen.shape.json';
const SEEN = `@${SEEN_FILE}`;

/** The plugins the vault with a route and a queue is loaded with, and how the project names them. */
const PLUGINS = { ...BUILTIN_PLUGINS, '@fake': fake, '@http': http, '@queue': queue, '@queue-memory': queueMemory };
const NAMED = [
  { use: '@http', from: '@wilanis/plugin-http', settings: { port: 8199, codecs: { 'application/json': JSON_CODEC } } },
  { use: '@queue', from: '@wilanis/plugin-queue' },
  { use: '@queue-memory', from: '@wilanis/plugin-queue-memory' },
];

/**
 * The vault, with a route and a queue whose one operation reads a header of the request into a node. The header may
 * be missing, so a switch asks first; its inputs and the node it routes to both read it. What the operation answers
 * marks the header too, so no report of the run shows it for a reason other than the one a case is about.
 */
function withHeaders(): string {
  const dir = vaultTree();
  const put = putter(dir);
  const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
  put('project.json', { ...project, plugins: [...project.plugins, ...NAMED] });
  put('connections/jobs.connection.json', { kind: '@queue-memory/memory.connection-kind.json', settings: {} });
  put('features/vault/edge/request.resolvers.json', { resolvers: { agent: { read: "request.headers['x-agent']" } } });
  put('features/vault/edge/Ping.shape.json', { layer: 'edge', fields: { n: { type: 'number' } } });
  put('features/vault/edge/SeenView.shape.json', {
    layer: 'edge',
    fields: { agent: { type: 'string', secret: true } },
  });
  put(SEEN_FILE, { layer: 'core', fields: { agent: { type: 'string', secret: true } } });
  // idempotent, since the queue's broker delivers at least once (T009)
  put('features/vault/domain/agent.port.json', {
    operations: { agent: { description: 'd', returns: SEEN, idempotent: true } },
  });
  put('features/vault/data/agent.binding.json', {
    port: AGENT,
    operations: { agent: { graph: '@features/vault/data/agent.graph.json' } },
  });
  const make = (id: string, agent: string) => ({ type: RUN, id, run: MAKE, in: { value: { agent }, type: SEEN } });
  const sent = { type: SWITCH, id: 'sent', in: { agent: '{{agent}}' }, rules: [{ when: 'has(agent)', to: 'agented' }] };
  put('features/vault/data/agent.graph.json', {
    reads: { agent: '@features/vault/edge/request.resolvers.json#agent' },
    out: { type: SEEN, from: ['agented', 'nobody'] },
    nodes: [{ ...sent, else: 'nobody' }, make('agented', '{{agent}}'), make('nobody', 'nobody')],
  });
  const fire = { run: `${AGENT}#agent` };
  const out = '@features/vault/edge/SeenView.shape.json';
  const route = { route: '/agent', method: 'GET', produces: 'application/json' };
  put('features/vault/edge/agent-route.trigger.json', { kind: HTTP, settings: route, out, fire });
  const queued = { connection: '@connections/jobs.connection.json', queue: 'agents', message: PING };
  put('features/vault/edge/agent-queue.trigger.json', { kind: QUEUE, settings: queued, out, fire });
  return dir;
}

/** One fire of a trigger of the tree, heard as the server hears it: its report and what the embedder told it. */
async function fired(load: LoadResult, trigger: string, request: Record<string, unknown>) {
  const emb = embedderFor(load);
  const heard: Ran[] = [];
  emb.serve(Object.assign(new Served({ load, emb }, () => {}), { ran: (what: Ran) => heard.push(what) }));
  const found = load.registry.get('trigger', load.resolve(trigger));
  const report = await emb.fire(found?.doc as never, undefined, request);
  return { report, heard: heard[0] as Fired };
}

/** The tree, loaded and checked, handed to `use`; it does not outlive it. */
async function withTree<T>(use: (load: LoadResult) => Promise<T>): Promise<T> {
  const dir = withHeaders();
  try {
    const load = loadTree(dir, PLUGINS);
    expect(checkTree(load).items).toEqual([]);
    return await use(load);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("a header of the request, in the reports of a trigger's run", () => {
  it("is the marker where a queue message's headers carry it, and the trace still correlates", async () => {
    const message = { id: 'm-1', attempt: 1, queue: 'agents', message: { n: 1 } };
    const headers = { 'x-agent': 'a-1', authorization: 'Bearer t-1', traceparent: PARENT };
    const { report, heard } = await withTree(load =>
      fired(load, '@features/vault/edge/agent-queue.trigger.json', { ...message, headers }),
    );
    expect(report.status).toBe('done');
    expect(report.output).toEqual({ agent: 'a-1' });
    expect(nodeNamed(report, 'sent')?.in).toEqual({ agent: SECRET });
    expect(nodeNamed(report, 'agented')?.in).toEqual({ value: { agent: SECRET }, type: SEEN });
    expect(clearIn(report, ['a-1', 't-1'])).toEqual([]);
    expect(heard.correlation).toBe(PARENT);
  });

  it("is the marker where an http request's headers carry it, and so is every cookie", async () => {
    const request = {
      method: 'GET',
      path: '/agent',
      headers: { 'x-agent': 'a-1', authorization: 'Bearer t-1', traceparent: PARENT },
      cookies: { session: 's-1' },
      query: {},
      params: {},
    };
    const { report, heard } = await withTree(load =>
      fired(load, '@features/vault/edge/agent-route.trigger.json', request),
    );
    expect(report.status).toBe('done');
    expect(report.output).toEqual({ agent: 'a-1' });
    expect(nodeNamed(report, 'sent')?.in).toEqual({ agent: SECRET });
    expect(nodeNamed(report, 'agented')?.in).toEqual({ value: { agent: SECRET }, type: SEEN });
    expect(clearIn(report, ['a-1', 't-1', 's-1'])).toEqual([]);
    expect(heard.correlation).toBe(PARENT);
  });
});
