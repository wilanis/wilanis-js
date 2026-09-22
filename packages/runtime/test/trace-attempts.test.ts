/**
 * The tries a node took, said as spans (RFC 0011, step 11). Nothing retries yet -- the wrapper that records a try
 * is the compiler's -- so every report here is written by hand, with `attempts` where a retried node would carry
 * them, and run through `traceOf` against the example's scope so a binding resolves to its own document.
 */
import { loadTree, type Trace } from '@wilanis/core';
import type { NodeReport, Report } from '@wilanis/engine';
import { beforeAll, describe, expect, it } from 'vitest';
import { atLevel, embedderFor, type Started, traceOf, traceText } from '../src/index.js';
import { EXAMPLE, INCLUDES, PLUGINS } from './example-harness.js';

const BINDING = '@features/customers/data/customers-rest.binding.json';
const GET_ROW = '@features/customers/data/get-row.graph.json';
const HTTP = '@http/http.port.json#request';

let scope: ReturnType<typeof embedderFor>['scope'];

beforeAll(() => {
  // the @auth settings read the signing secret from the environment, so it is set before the tree is loaded
  process.env.CUSTOMERS_JWT_SECRET ??= 'a-secret-of-thirty-two-bytes-or-more!';
  scope = embedderFor(loadTree(EXAMPLE, PLUGINS, INCLUDES), { profile: 'live' }).scope;
});

/** Every span of a trace, depth first. */
const spansOf = (trace: Trace): Trace[] => [trace, ...trace.children.flatMap(spansOf)];

/** The one span with exactly this name. */
const named = (trace: Trace, name: string): Trace | undefined => spansOf(trace).find(one => one.name === name);

/** get-row's run, whose `asked` is whatever a case says it was: a GET that answered 200 on its last try. */
function getRow(asked: Partial<NodeReport> = {}, status: Report['status'] = 'done'): Report {
  return {
    graph: GET_ROW,
    status,
    startedAt: 100,
    endedAt: 190,
    nodes: {
      asked: {
        status: 'done',
        handler: HTTP,
        in: { connection: '@connections/customers-api.connection.json', method: 'GET' },
        out: { status: 200 },
        startedAt: 100,
        endedAt: 180,
        ...asked,
      },
    },
  };
}

/** The binding operation `get`, lowered to its one `op` node, running get-row -- tried as a case says. */
function bound(sub: Report, op: Partial<NodeReport> = {}): Report {
  return {
    graph: `${BINDING}#get`,
    status: sub.status,
    startedAt: 90,
    endedAt: 200,
    nodes: { op: { status: sub.status === 'done' ? 'done' : 'failed', handler: `graph:${GET_ROW}`, sub, ...op } },
  };
}

/** One startup step whose answer is the given report: a record with no gate, so a case reads the run alone. */
const step = (answer: Report): Started => ({
  id: 'run-1',
  at: 0,
  label: 'Read one customer',
  run: '@features/customers/domain/customer.port.json#get',
  answer,
  startedAt: answer.startedAt,
  endedAt: answer.endedAt,
});

/** Two tries of `asked` that did not stand before the third that did, each with its own stamps. */
const TWO_FAILED = [
  { startedAt: 100, endedAt: 110, error: 'fetch failed' },
  { startedAt: 130, endedAt: 150, error: 'timed out after 20ms' },
];

describe('a node that was tried again', () => {
  it('carries each try that did not stand as a child span, in order, with its own stamps', () => {
    const trace = traceOf(step(bound(getRow({ attempts: TWO_FAILED }))), scope, { level: 'full' });
    const asked = named(trace, `asked ${HTTP}`);

    expect(asked?.children.map(one => [one.name, one.status, one.startedAt, one.endedAt])).toEqual([
      ['asked try 1', 'failed', 100, 110],
      ['asked try 2', 'failed', 130, 150],
    ]);
    // the node's own span is the node, spanning every try, and ends as the try that stood did
    expect([asked?.status, asked?.startedAt, asked?.endedAt]).toEqual(['ok', 100, 180]);
    expect(asked?.attributes['wilanis.attempts']).toBe(2);
    expect(asked?.attributes['http.response.status_code']).toBe(200);
  });

  it('gives a try the address its node has, so a try and a refusal join on the same pair', () => {
    const trace = traceOf(step(bound(getRow({ attempts: TWO_FAILED }))), scope);
    const first = named(trace, 'asked try 1');

    expect(first?.attributes['wilanis.node']).toBe('asked');
    expect(first?.attributes['wilanis.at']).toBe('nodes/asked');
  });

  it("carries a try's error at full only, since it is a message like a node's", () => {
    const full = traceOf(step(bound(getRow({ attempts: TWO_FAILED }))), scope, { level: 'full' });
    const summary = traceOf(step(bound(getRow({ attempts: TWO_FAILED }))), scope);

    expect(named(full, 'asked try 2')?.attributes['wilanis.error']).toBe('timed out after 20ms');
    expect(named(summary, 'asked try 2')?.attributes['wilanis.error']).toBeUndefined();
    // and narrowing a full trace drops it the same way, so an exporter holding one never sends it
    expect(named(atLevel(full, 'summary'), 'asked try 2')?.attributes['wilanis.error']).toBeUndefined();
    // how many tries it took is not a value: summary says it
    expect(named(summary, `asked ${HTTP}`)?.attributes['wilanis.attempts']).toBe(2);
  });

  it('says the tries of a map per element, on the element that took them', () => {
    const items: NodeReport[] = [
      { status: 'done', handler: HTTP, startedAt: 10, endedAt: 12 },
      {
        status: 'done',
        handler: HTTP,
        startedAt: 10,
        endedAt: 30,
        attempts: [{ startedAt: 10, endedAt: 14, error: 'reset' }],
      },
      { status: 'done', handler: HTTP, startedAt: 10, endedAt: 13 },
    ];
    const report: Report = {
      graph: GET_ROW,
      status: 'done',
      startedAt: 10,
      endedAt: 30,
      nodes: { each: { status: 'done', handler: HTTP, items, startedAt: 10, endedAt: 30 } },
    };
    const each = named(traceOf(step(bound(report)), scope), 'each map ×3');

    expect(each?.attributes['wilanis.attempts']).toBeUndefined();
    expect(each?.children.map(one => [one.name, one.attributes['wilanis.attempts']])).toEqual([
      [`each.0 ${HTTP}`, undefined],
      [`each.1 ${HTTP}`, 1],
      [`each.2 ${HTTP}`, undefined],
    ]);
    expect(named(each as Trace, 'each.1 try 1')?.startedAt).toBe(10);
  });
});

describe('a binding operation that retried its graph', () => {
  it('keeps the nested run of each try that did not stand, before the graph that did', () => {
    const broke = getRow({ status: 'failed', error: 'fetch failed', out: undefined }, 'failed');
    const tried = bound(getRow(), { attempts: [{ startedAt: 90, endedAt: 120, error: 'fetch failed', sub: broke }] });
    const binding = named(traceOf(step(tried), scope), `binding ${BINDING}#get`);

    expect(binding?.attributes['wilanis.attempts']).toBe(1);
    expect(binding?.children.map(one => [one.name, one.status])).toEqual([
      ['get try 1', 'failed'],
      [GET_ROW, 'ok'],
    ]);
    const first = binding?.children[0];
    expect(first?.attributes['wilanis.at']).toBe('operations/get');
    // the try that broke says what broke in it, the way any nested run does
    expect(first?.children.map(one => one.name)).toEqual([GET_ROW]);
    expect(first?.children[0].children.map(one => [one.name, one.status])).toEqual([[`asked ${HTTP}`, 'failed']]);
  });
});

describe('a node that ran once', () => {
  it('is said exactly as it was before anything could retry', () => {
    const once = traceOf(step(bound(getRow())), scope, { level: 'full' });
    const tried = traceOf(step(bound(getRow({ attempts: TWO_FAILED }))), scope, { level: 'full' });

    // strip what the tries added, and what is left is the trace of the node that ran once
    const without = (span: Trace): Trace => {
      const { 'wilanis.attempts': _, ...attributes } = span.attributes;
      return { ...span, attributes, children: span.children.filter(one => !/ try \d+$/.test(one.name)).map(without) };
    };
    expect(without(tried)).toEqual(once);
    expect(spansOf(once).some(one => 'wilanis.attempts' in one.attributes || / try \d+$/.test(one.name))).toBe(false);
  });

  it('prints its tries as lines of their own, indented under the node', () => {
    const text = traceText(traceOf(step(bound(getRow({ attempts: TWO_FAILED }))), scope));

    expect(text).toMatch(/\n {6}asked @http\/http\.port\.json#request .*attempts=2/);
    expect(text).toMatch(/\n {8}asked try 1 +10ms {2}failed/);
  });
});
