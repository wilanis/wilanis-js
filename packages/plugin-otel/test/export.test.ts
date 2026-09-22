/**
 * The `export` handler against a collector that is really there: the handler is run as the kernel would run
 * it, given a `Serving` that keeps its observers the way the server does, and the spans are read back off the
 * socket as OTLP/JSON.
 *
 * Every case here hands a trace over directly, because a trace handed to an observer is the whole contract
 * between the runtime and this plugin, and a case that builds one says exactly what this plugin is given.
 * `served.test.ts` closes the loop the other way, with a real tree and a real fire.
 */
import type { Serving, Trace } from '@wilanis/core';
import { afterEach, describe, expect, it } from 'vitest';
import otel from '../src/index.js';
import { EXPORT, ROOT } from '../src/paths.js';
import { attributesOf, type Collector, collector, until } from './collector.js';

let open: Collector | undefined;
let stop: (() => Promise<void>) | undefined;

afterEach(async () => {
  await stop?.();
  stop = undefined;
  await open?.stop();
  open = undefined;
});

/** What a test hands the handler in place of the runtime: the observers the server would keep, and a log. */
function serving() {
  const listeners = new Set<(trace: Trace) => void>();
  const logs: string[] = [];
  const served = {
    observe(listener: (trace: Trace) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    log: (line: string) => logs.push(line),
    root: '/nowhere',
  } as unknown as Serving;
  return {
    serving: served,
    logs,
    listening: () => listeners.size,
    /** Hand a trace to whoever is listening, as `Served.observed` does on every fire. */
    observed: (trace: Trace) => {
      for (const listener of listeners) listener(trace);
    },
  };
}

/** Run the `holds` handler against an environment a case built, as the kernel would. */
async function exporting(env: unknown, input: Record<string, unknown> = {}) {
  const held: { label: string; stop: () => Promise<void> }[] = [];
  const ctx = {
    env: { ...(env as object), hold: (what: (typeof held)[number]) => held.push(what) },
    nodePath: [],
    attach: () => {},
  };
  const answer = await otel.handlers[EXPORT]({ in: input, ctx } as never);
  stop = async () => {
    for (const one of held.reverse()) await one.stop();
  };
  return { answer, held };
}

/** The trace of one request, as the runtime will hand it: a fire, the operation, and the node that asked. */
function trace(correlation?: string): Trace {
  return {
    name: 'fire @customers/edge/get-customer.trigger.json',
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_000_143,
    status: 'refused: upstream',
    attributes: {
      'wilanis.trigger': '@customers/edge/get-customer.trigger.json',
      'wilanis.kind': '@http/http.trigger-kind.json',
      ...(correlation ? { 'wilanis.correlation': correlation } : {}),
    },
    children: [
      {
        name: '@customers/domain/customer.port.json#get',
        startedAt: 1_700_000_000_002,
        endedAt: 1_700_000_000_143,
        status: 'refused: upstream',
        attributes: { 'wilanis.port': '@customers/domain/customer.port.json', 'wilanis.operation': 'get' },
        children: [
          {
            name: 'asked @http/http.port.json#request',
            startedAt: 1_700_000_000_010,
            endedAt: 1_700_000_000_141,
            status: 'ok',
            attributes: {
              'wilanis.node': 'asked',
              'wilanis.connection': '@connections/customers-api.connection.json',
              'http.response.status_code': 500,
              'wilanis.in': '{"id":"golf"}',
            },
            children: [
              {
                name: 'missing',
                startedAt: 1_700_000_000_141,
                endedAt: 1_700_000_000_141,
                status: 'cancelled',
                attributes: { 'wilanis.node': 'missing' },
                children: [],
              },
            ],
          },
        ],
      },
    ],
  };
}

/** The tree's settings for a collector, at the level a case wants. */
const settings = (url: string, extra: Record<string, unknown> = {}) => ({
  plugins: { [ROOT]: { endpoint: url, service: 'monitor', ...extra } },
});

describe('spans reach a collector', () => {
  it("a trace handed to the observer arrives as OTLP/JSON, nested and named in the tree's own words", async () => {
    open = await collector();
    const server = serving();
    const { answer } = await exporting({ serving: server.serving, ...settings(open.url) });

    expect(answer).toEqual({ endpoint: open.url, service: 'monitor' });
    expect(server.listening()).toBe(1);

    server.observed(trace());
    await stop?.(); // stopping flushes what is waiting, so nothing here sleeps on a timer
    stop = undefined;

    expect(await until(() => open?.batches() === 1)).toBe(true);
    const spans = open.spans();
    expect(spans.map(one => one.name)).toEqual([
      'fire @customers/edge/get-customer.trigger.json',
      '@customers/domain/customer.port.json#get',
      'asked @http/http.port.json#request',
    ]);

    // one trace: every span shares the trace id, and each hangs from the one above it
    const [root, operation, asked] = spans;
    expect(new Set(spans.map(one => one.traceId)).size).toBe(1);
    expect(root.parentSpanId ?? '').toBe('');
    expect(operation.parentSpanId).toBe(root.spanId);
    expect(asked.parentSpanId).toBe(operation.spanId);

    // the service the tree is called by -- OTLP groups a batch by resource, so every span carries it
    expect(new Set(open.services())).toEqual(new Set(['monitor']));
    expect(attributesOf(asked)['wilanis.connection']).toBe('@connections/customers-api.connection.json');
    expect(attributesOf(asked)['http.response.status_code']).toBe(500);
    expect(attributesOf(root)['wilanis.trigger']).toBe('@customers/edge/get-customer.trigger.json');
  });

  it('the timing the run stamped is the timing the collector reads, to the nanosecond', async () => {
    open = await collector();
    const server = serving();
    await exporting({ serving: server.serving, ...settings(open.url) });
    server.observed(trace());
    await stop?.();
    stop = undefined;
    expect(await until(() => open?.batches() === 1)).toBe(true);

    const root = open.spans()[0];
    expect(root.startTimeUnixNano).toBe('1700000000000000000');
    expect(root.endTimeUnixNano).toBe('1700000000143000000');
    // a refusal is an error to a collector, and carries the tree's own word for it
    expect(root.status.code).toBe(2);
    expect(root.status.message).toBe('refused: upstream');
  });

  it("a caller's traceparent makes this run part of the caller's trace", async () => {
    open = await collector();
    const server = serving();
    await exporting({ serving: server.serving, ...settings(open.url) });
    server.observed(trace('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'));
    await stop?.();
    stop = undefined;
    expect(await until(() => open?.batches() === 1)).toBe(true);

    const [root] = open.spans();
    expect(root.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(root.parentSpanId).toBe('00f067aa0ba902b7');
  });

  it('a correlation that is not a traceparent starts a trace of its own and is kept as it came', async () => {
    open = await collector();
    const server = serving();
    await exporting({ serving: server.serving, ...settings(open.url) });
    server.observed(trace('req-7f3a'));
    await stop?.();
    stop = undefined;
    expect(await until(() => open?.batches() === 1)).toBe(true);

    const [root] = open.spans();
    expect(root.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(root.parentSpanId ?? '').toBe('');
    expect(attributesOf(root)['wilanis.correlation']).toBe('req-7f3a');
  });

  it("a collector's headers are sent with the batch", async () => {
    open = await collector();
    const server = serving();
    await exporting({ serving: server.serving, ...settings(open.url, { headers: { 'x-api-key': 'shh' } }) });
    server.observed(trace());
    await stop?.();
    stop = undefined;
    expect(await until(() => open?.batches() === 1)).toBe(true);
    expect(open.headers()['x-api-key']).toBe('shh');
  });
});

describe('what a level lets leave the process', () => {
  it('summary carries no value and drops the branches not taken', async () => {
    open = await collector();
    const server = serving();
    await exporting({ serving: server.serving, ...settings(open.url) });
    server.observed(trace());
    await stop?.();
    stop = undefined;
    expect(await until(() => open?.batches() === 1)).toBe(true);

    const spans = open.spans();
    expect(spans.map(one => one.name)).not.toContain('missing');
    const asked = spans.find(one => one.name.startsWith('asked'));
    expect(asked && attributesOf(asked)['wilanis.in']).toBeUndefined();
    // what a reader searches on is still there
    expect(asked && attributesOf(asked)['wilanis.connection']).toBe('@connections/customers-api.connection.json');
  });

  it("full carries the report's redacted values and keeps the cancelled branches", async () => {
    open = await collector();
    const server = serving();
    await exporting({ serving: server.serving, ...settings(open.url, { level: 'full' }) });
    server.observed(trace());
    await stop?.();
    stop = undefined;
    expect(await until(() => open?.batches() === 1)).toBe(true);

    const spans = open.spans();
    expect(spans.map(one => one.name)).toContain('missing');
    const asked = spans.find(one => one.name.startsWith('asked'));
    expect(asked && attributesOf(asked)['wilanis.in']).toBe('{"id":"golf"}');
    const cancelled = spans.find(one => one.name === 'missing');
    expect(cancelled?.status.message).toBe('cancelled');
  });

  it("the step's level wins over the plugin's, as the listener's port wins over its settings", async () => {
    open = await collector();
    const server = serving();
    await exporting({ serving: server.serving, ...settings(open.url, { level: 'summary' }) }, { level: 'full' });
    server.observed(trace());
    await stop?.();
    stop = undefined;
    expect(await until(() => open?.batches() === 1)).toBe(true);
    const asked = open.spans().find(one => one.name.startsWith('asked'));
    expect(asked && attributesOf(asked)['wilanis.in']).toBe('{"id":"golf"}');
  });
});

describe('observing a tree never changes what the tree does', () => {
  // the OTLP exporter retries a batch with a backoff before it gives up, which is what one wants of a
  // collector that is briefly out of reach -- so this is the one case here that waits on that happening
  it('a collector that is not there is said once, and the run that was traced is untouched', async () => {
    const server = serving();
    // nothing is listening on this port: the export fails, and the handler must not
    await exporting({ serving: server.serving, ...settings('http://127.0.0.1:1/v1/traces') });
    expect(() => server.observed(trace())).not.toThrow();
    await stop?.();
    stop = undefined;
    expect(server.logs.some(line => line.includes('not exported'))).toBe(true);
  }, 30_000);

  it('the hold says where it sends, and stopping unsubscribes', async () => {
    open = await collector();
    const server = serving();
    const { held } = await exporting({ serving: server.serving, ...settings(open.url) });
    expect(held).toHaveLength(1);
    expect(held[0].label).toBe(`otel → ${open.url}`);
    await stop?.();
    stop = undefined;
    expect(server.listening()).toBe(0);
  });

  it('a trace handed after the stop is not sent: what was unsubscribed stays so', async () => {
    open = await collector();
    const server = serving();
    await exporting({ serving: server.serving, ...settings(open.url) });
    await stop?.();
    stop = undefined;
    server.observed(trace());
    expect(server.listening()).toBe(0);
    expect(open.batches()).toBe(0);
  });
});

describe('where the export step cannot do what it was asked', () => {
  it('run from a graph, with no tree to serve: it says where it belongs', async () => {
    await expect(
      otel.handlers[EXPORT]({ in: {}, ctx: { env: {}, nodePath: [], attach: () => {} } } as never),
    ).rejects.toThrow(/runs from a project's startup list/);
  });
});
