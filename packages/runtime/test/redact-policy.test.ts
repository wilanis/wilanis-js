/**
 * A policy's decision, in the reports the gate keeps of it. An http request's headers and cookies are marked secret
 * whole, so a policy whose `decide.in` reads an api key from a header and the session from a cookie shows both as
 * the marker in every report of its run -- the call of its operation and the graph's switch -- while the decision
 * is made on the values: the right key is allowed, a wrong one denied.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import { loadTree } from '@wilanis/core';
import { outcomeOf, type Report } from '@wilanis/engine';
import http from '@wilanis/plugin-http';
import { describe, expect, it } from 'vitest';
import { BUILTIN_PLUGINS, embedderFor, type Fired, type Ran, Served } from '../src/index.js';
import { clearIn, nodeNamed, putter, SECRET } from './redact-tree.js';

const PORT = '@features/keyed/domain/keyed.port.json';
const GRANT = '@features/keyed/domain/Grant.shape.json';
const PRESENTED = '@features/keyed/domain/Presented.shape.json';
const RUN = '@wilanis/node/run.schema.json';
const MAKE = '@std/object.port.json#make';
const TRIGGER = '@features/keyed/edge/greet.trigger.json';

const PLUGINS = { ...BUILTIN_PLUGINS, '@http': http };
const HTTP = {
  use: '@http',
  from: '@wilanis/plugin-http',
  settings: { port: 8199, codecs: { 'application/json': '@http/codecs/json.codec.json' } },
};

/** The decision: allow the one key, refuse anything else as `unkeyed`. */
const decision = {
  in: PRESENTED,
  out: { type: GRANT, from: ['granted', 'denied'] },
  nodes: [
    {
      type: '@wilanis/node/switch.schema.json',
      id: 'decide',
      in: { key: '{{in.key}}', session: '{{in.session}}' },
      rules: [{ when: "has(key) && key == 'k-1'", to: 'granted' }],
      else: 'denied',
    },
    { type: RUN, id: 'granted', run: MAKE, in: { value: { allowed: true }, type: GRANT } },
    {
      type: RUN,
      id: 'denied',
      run: '@std/outcome.port.json#refuse',
      in: { reason: 'unkeyed', message: 'the key is wrong', type: GRANT },
    },
  ],
};

/** A route gated by one policy that reads an api key from a header and the session from a cookie. */
function keyedTree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-keyed-'));
  const put = putter(dir);
  put('project.json', { name: 'keyed', plugins: [{ use: '@std' }, HTTP] });
  put('features/keyed/feature.json', { exports: [] });
  put('features/keyed/domain/Grant.shape.json', { layer: 'core', fields: { allowed: { type: 'boolean' } } });
  const presented = { key: { type: 'string', required: false }, session: { type: 'string', required: false } };
  put('features/keyed/domain/Presented.shape.json', { layer: 'core', fields: presented });
  put('features/keyed/domain/keyed.port.json', {
    operations: {
      keyed: { description: 'd', accepts: presented, returns: GRANT },
      greet: { description: 'd', returns: 'string' },
    },
  });
  put('features/keyed/domain/keyed.graph.json', decision);
  put('features/keyed/domain/greet.graph.json', {
    out: { type: 'string', from: 'said' },
    nodes: [{ type: RUN, id: 'said', run: MAKE, in: { value: 'hello', type: 'string' } }],
  });
  put('features/keyed/data/keyed.binding.json', {
    port: PORT,
    operations: {
      keyed: { graph: '@features/keyed/domain/keyed.graph.json' },
      greet: { graph: '@features/keyed/domain/greet.graph.json' },
    },
  });
  put('features/keyed/edge/keyed.policy.json', {
    decide: {
      run: `${PORT}#keyed`,
      in: { key: "{{request.headers['x-api-key']}}", session: '{{request.cookies.session}}' },
    },
    outcomes: { unkeyed: { effect: 'deny' } },
  });
  put('features/keyed/edge/greet.trigger.json', {
    kind: '@http/http.trigger-kind.json',
    settings: {
      route: '/greet',
      method: 'GET',
      produces: 'application/json',
      response: { refusals: { unkeyed: 401 } },
    },
    out: 'string',
    policies: ['@features/keyed/edge/keyed.policy.json'],
    fire: { run: `${PORT}#greet` },
  });
  return dir;
}

/** One fire of the route with this api key, heard as the server hears it: its report and what the embedder told it. */
async function fired(key: string): Promise<{ report: Report; heard: Fired }> {
  const dir = keyedTree();
  try {
    const load = loadTree(dir, PLUGINS);
    expect(checkTree(load).items).toEqual([]);
    const emb = embedderFor(load);
    const heard: Ran[] = [];
    emb.serve(Object.assign(new Served({ load, emb }, () => {}), { ran: (what: Ran) => heard.push(what) }));
    const trigger = load.registry.get('trigger', load.resolve(TRIGGER))?.doc;
    const request = {
      method: 'GET',
      path: '/greet',
      headers: { 'x-api-key': key },
      cookies: { session: 's-1' },
      query: {},
      params: {},
    };
    const report = await emb.fire(trigger as never, undefined, request);
    return { report, heard: heard[0] as Fired };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("a policy reading a marked field of the request, in its decision's reports", () => {
  it('allows the right key, while every report of the decision shows the key and the cookie as the marker', async () => {
    const { report, heard } = await fired('k-1');
    expect(report.status).toBe('done');
    expect(report.output).toBe('hello');
    expect(heard.decisions).toHaveLength(1);
    const decided = heard.decisions[0].report;
    expect(decided.status).toBe('done');
    expect(nodeNamed(decided, 'op')?.in).toEqual({ key: SECRET, session: SECRET });
    expect(nodeNamed(decided, 'decide')?.in).toEqual({ key: SECRET, session: SECRET });
    expect(clearIn(decided, ['k-1', 's-1'])).toEqual([]);
  });

  it('denies a wrong key, and the report that ends the run shows it as the marker', async () => {
    const { report, heard } = await fired('k-2');
    expect(outcomeOf(report)).toMatchObject({ kind: 'refused', reason: 'unkeyed' });
    expect(heard.decisions[0]).toMatchObject({ effect: 'deny' });
    expect(nodeNamed(report, 'decide')?.in).toEqual({ key: SECRET, session: SECRET });
    expect(clearIn(report, ['k-2', 's-1'])).toEqual([]);
  });
});
