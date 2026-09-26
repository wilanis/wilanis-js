/**
 * A queued removal carries the caller's token to the worker in the message's headers, so the worker's gate
 * judges the same caller the route did (`publish-removal.graph.json`). The token is a credential, so no report and
 * no full trace of either run shows it: `@queue/queue.port.json#publish` marks `headers` secret, and an open map
 * has no named field to mark, so the map is redacted whole. What the broker is handed, and so what the worker's
 * gate reads, is the value itself.
 *
 * The example is the tree, under `local`, in one process as `wilanis start example --profile local` runs it: the
 * route and the worker share the embedder and the in-process broker. The startup is the example's but for what
 * would reach outside a test -- the listener, the reload watch, the schedule and the exporter -- so the route is
 * fired as the listener would fire it, and the worker consumes what it published.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import { loadTree, type Trace } from '@wilanis/core';
import { afterEach, describe, expect, it } from 'vitest';
import { embedderFor, type Fired, isStarted, postLoad, type Ran, runStartup, Served, traceOf } from '../src/index.js';
import { copyOfExample, INCLUDES, PLUGINS } from './example-harness.js';

const PROFILE = 'local';
const SIGN_IN = '@access/edge/auth-employees.trigger.json';
const REGISTER = '@customers/edge/register-customer.trigger.json';
const ENQUEUE = '@customers/edge/enqueue-removal.trigger.json';
/** The two runs of a removal, by the canonical paths a fire names its trigger by. */
const ROUTE = '@features/customers/edge/enqueue-removal.trigger.json';
const WORKER = '@features/customers/edge/remove-queued.trigger.json';
/** What a test cannot start: a socket, a watch on the directory, a clock, and a collector to export to. */
const OUTSIDE = [
  '@http/server.port.json#listen',
  '@reload/watch.port.json#watch',
  '@schedule/scheduler.port.json#run',
  '@otel/exporter.port.json#export',
];

const dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A copy of the example whose startup runs everything but what reaches outside the process. */
function inProcess(): string {
  const dir = copyOfExample();
  dirs.push(dir);
  const path = join(dir, 'project.json');
  const project = JSON.parse(readFileSync(path, 'utf8'));
  project.startup = project.startup.filter((step: { run: string }) => !OUTSIDE.includes(step.run));
  writeFileSync(path, JSON.stringify(project));
  return dir;
}

/**
 * The example started as `start` starts it -- the plugins' postLoad, then the startup steps -- with every run the
 * embedder hands the server kept, and what the worker logs. Answers how to fire one of its http routes.
 */
async function started() {
  process.env.CUSTOMERS_JWT_SECRET ??= 'a-secret-of-thirty-two-bytes-or-more!';
  const load = loadTree(inProcess(), PLUGINS, INCLUDES);
  expect(checkTree(load).items).toEqual([]);
  const emb = embedderFor(load, { profile: PROFILE });
  const heard: Fired[] = [];
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);
  const served = new Served({ load, emb }, log, { profile: PROFILE });
  emb.serve(Object.assign(served, { ran: (what: Ran) => (isStarted(what) ? undefined : heard.push(what)) }));
  const down = await postLoad(load, emb, log);
  stops.push(async () => {
    for (const held of [...emb.held].reverse()) await held.stop();
    await down();
  });
  await runStartup(load, emb, log, PROFILE);
  /** Fire a route with this request, as the listener would: the input built from the request, then the gate and the run. */
  const fire = async (ref: string, request: Record<string, unknown>) => {
    const trigger = load.registry.get('trigger', load.resolve(ref));
    if (!trigger) throw new Error(`no trigger at '${ref}'`);
    const built = emb.inputFor(trigger.doc, request);
    if ('error' in built) throw new Error(`input: ${built.error}`);
    return emb.fire(trigger.doc, built.input, request);
  };
  const traceOfRun = (fired: Fired): Trace => traceOf(fired, emb.scope, { level: 'full' });
  return { fire, heard, logs, traceOfRun };
}

/** Wait until `done` holds, or give up after a few seconds. */
async function until(done: () => boolean): Promise<boolean> {
  for (let tries = 0; tries < 100 && !done(); tries++) await new Promise(wait => setTimeout(wait, 20));
  return done();
}

/** What ran under one fire, in order: the guard, each policy, the operation, each with how it ended. */
const steps = (trace: Trace) => trace.children.map(child => `${child.name} → ${child.status}`);

describe("a queued removal's token", () => {
  it('is the marker in every report and full trace of the route and the worker, and the worker’s gate still admits it', async () => {
    const at = await started();
    const credential = { username: 'bo', password: 'bo-pass' };
    const signedIn = await at.fire(SIGN_IN, { body: credential, headers: {} });
    const token = (signedIn.output as { accessToken: string }).accessToken;
    const headers = { authorization: `Bearer ${token}` };
    const body = { name: 'Ada', email: 'ada@one.example', tier: 'silver' };
    const registered = await at.fire(REGISTER, { body, headers });
    expect(registered.status).toBe('done');
    const { id } = registered.output as { id: string };
    const before = at.heard.length;

    const queued = await at.fire(ENQUEUE, { params: { id }, headers });
    expect(queued.status).toBe('done');
    // the worker may finish before the route's last node does, so each run is found by its trigger
    const ranFor = (trigger: string) => at.heard.slice(before).find(one => one.trigger === trigger);
    expect(await until(() => ranFor(WORKER) !== undefined)).toBe(true);
    const [route, worker] = [ranFor(ROUTE), ranFor(WORKER)] as Fired[];

    // the publish call says its headers as the marker, since the port marks the map whole
    const published = route.run?.nodes.op.sub?.nodes.published;
    expect(published?.in?.headers).toBe('«secret»');
    expect(published?.in?.message).toEqual({ id });

    // the worker's gate read the token the broker was handed: the guard named bo, both policies let him through
    expect(steps(at.traceOfRun(worker))).toEqual([
      'identify (@auth) → ok',
      'policy @features/access/edge/employees-only.policy.json → allowed',
      'policy @features/access/edge/can-register.policy.json → allowed',
      '@features/customers/domain/customer.port.json#remove → ok',
    ]);
    expect(at.logs.some(line => line.startsWith('queue removals') && line.includes('→ ack'))).toBe(true);

    // and nowhere the route or the worker left behind -- any report, any full trace -- shows the token
    for (const fired of [route, worker]) {
      expect(JSON.stringify(fired)).not.toContain(token);
      expect(JSON.stringify(at.traceOfRun(fired))).not.toContain(token);
    }
  }, 15_000);
});
