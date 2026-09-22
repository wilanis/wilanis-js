/**
 * What one run says as spans. `traceOf` is pure: it reads what the embedder left behind -- the gate's record
 * and the engine's reports -- and answers a `Trace`, so what a printer writes, what an exporter sends and what
 * a case here asserts are the same walk of the same run.
 *
 * The example is the tree, because the claim is about a trace of a real fire: the trigger an author wrote, the
 * port it names, the binding a profile chose and the data graph beneath it, each with its own span. The one
 * effect is stubbed, so nothing here reaches a network. What a gate says as spans is `trace-gate.test.ts`.
 */
import { loadTree, type Trace } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import {
  atLevel,
  embedderFor,
  type Fired,
  type Ran,
  Served,
  type Started,
  traceJson,
  traceOf,
  traceText,
} from '../src/index.js';
import { EXAMPLE, INCLUDES, PLUGINS } from './example-harness.js';

const GET_CUSTOMER = '@customers/edge/get-customer.trigger.json';

/** Every span of a trace, depth first, so a case can say which ones a run left and in what order. */
function spansOf(trace: Trace): Trace[] {
  return [trace, ...trace.children.flatMap(spansOf)];
}

/** The one span with this name, or nothing: what a case reaches for when the claim is about one of them. */
const spanNamed = (trace: Trace, name: string): Trace | undefined =>
  spansOf(trace).find(one => one.name === name || one.name.startsWith(`${name} `));

/**
 * Fire one of the example's triggers under a profile and answer the record the embedder handed the server.
 * The observers are the server's, as they are when a tree is really served, so a case reads exactly what an
 * exporter would be handed.
 */
async function fire(
  ref: string,
  given: { input: unknown; request: Record<string, unknown>; stubs?: Record<string, unknown> },
  profile = 'live',
): Promise<{ ran: Ran; scope: ReturnType<typeof embedderFor>['scope'] }> {
  const load = loadTree(EXAMPLE, PLUGINS, INCLUDES);
  const emb = embedderFor(load, { profile });
  const heard: Ran[] = [];
  const served = new Served({ load, emb }, () => {});
  emb.serve(Object.assign(served, { ran: (what: Ran) => heard.push(what) }));
  const trigger = load.registry.get('trigger', load.resolve(ref));
  await emb.fire(trigger?.doc as never, given.input, given.request, { stubs: given.stubs });
  return { ran: heard[0], scope: emb.scope };
}

/** The trace of one fire of `GET /customers/{id}`, with the upstream stubbed to whatever a case wants it to say. */
async function getCustomer(status: number, level: 'summary' | 'full' = 'full'): Promise<Trace> {
  const { ran, scope } = await fire(GET_CUSTOMER, {
    input: { id: 'golf' },
    request: { params: { id: 'golf' }, headers: {} },
    stubs: {
      'op.asked': {
        status,
        body: status === 200 ? { id: 'golf', name: 'Ada', email: 'ada@example.com', tier: 'bronze' } : undefined,
      },
    },
  });
  return traceOf(ran, scope, { level });
}

describe('one fire, said as spans', () => {
  it('nests the fire, the port operation, the binding, the graph and every node that ran', async () => {
    const trace = await getCustomer(500);

    expect(spansOf(trace).map(one => one.name)).toEqual([
      'fire @features/customers/edge/get-customer.trigger.json',
      '@features/customers/domain/customer.port.json#get',
      'binding @features/customers/data/customers-rest.binding.json#get',
      '@features/customers/data/get-row.graph.json',
      'asked @http/http.port.json#request',
      'route switch → failed',
      'row',
      'missing',
      'failed @std/outcome.port.json#refuse',
    ]);
  });

  it('says how the run ended, in the tree’s own word for it, at every level of the nesting', async () => {
    const trace = await getCustomer(500);
    const statuses = Object.fromEntries(spansOf(trace).map(one => [one.name.split(' ')[0], one.status]));

    // the reason is the author's own -- "upstream" is a word get-row.graph.json declared, not the engine's
    expect(trace.status).toBe('refused: upstream');
    expect(statuses['@features/customers/data/get-row.graph.json']).toBe('refused: upstream');
    expect(statuses.asked).toBe('ok');
    expect(statuses.failed).toBe('refused: upstream');
    // the branches nothing took are there, so a reader sees what did not run as well as what did
    expect(statuses.row).toBe('cancelled');
    expect(statuses.missing).toBe('cancelled');
  });

  it('carries the run id, the trigger and its kind on the root span', async () => {
    const trace = await getCustomer(500);

    expect(trace.attributes['wilanis.trigger']).toBe('@features/customers/edge/get-customer.trigger.json');
    expect(trace.attributes['wilanis.kind']).toBe('@http/http.trigger-kind.json');
    expect(trace.attributes['wilanis.run.id']).toMatch(/^[0-9a-f-]{36}$/);
    // a request that carried no traceparent correlates nothing rather than an empty string
    expect(trace.attributes['wilanis.correlation']).toBeUndefined();
  });

  it("reads the caller's own trace off the path the trigger's kind declares", async () => {
    const parent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    const { ran, scope } = await fire(GET_CUSTOMER, {
      input: { id: 'golf' },
      request: { params: { id: 'golf' }, headers: { traceparent: parent } },
      stubs: { 'op.asked': { status: 500 } },
    });

    // @http/http.trigger-kind.json says `correlation: headers.traceparent`, and nothing else had to
    expect(traceOf(ran, scope).attributes['wilanis.correlation']).toBe(parent);
  });

  it('gives every node span the address a refusal prints, so a span and a refusal join on one pair', async () => {
    const trace = await getCustomer(500);
    const graph = spanNamed(trace, '@features/customers/data/get-row.graph.json');
    const asked = spanNamed(trace, 'asked');

    // the graph span names the file, the node span names the place inside it: `file` and `at`, as a refusal has
    expect(graph?.attributes['wilanis.graph']).toBe('@features/customers/data/get-row.graph.json');
    expect(asked?.attributes['wilanis.at']).toBe('nodes/asked');
    expect(asked?.attributes['wilanis.node']).toBe('asked');
  });

  it("reads the connection and the HTTP status out of the node's own in and out", async () => {
    const asked = spanNamed(await getCustomer(500), 'asked');

    // the engine knows nothing of connections or of HTTP; these two are read here, where the tree's words are
    expect(asked?.attributes['wilanis.connection']).toBe('@connections/customers-api.connection.json');
    expect(asked?.attributes['http.response.status_code']).toBe(500);
    // and the node is an effect, because the operation it ran is not declared pure
    expect(asked?.attributes['wilanis.effect']).toBe(true);
  });

  it('says what a switch routed to, and names the branch in the span so a reader sees the route taken', async () => {
    const route = spanNamed(await getCustomer(404), 'route');

    expect(route?.name).toBe('route switch → missing');
    expect(route?.attributes['wilanis.selected']).toBe('missing');
    expect(route?.status).toBe('ok');
  });

  it('a run that answered says so, and the graph under it says so too', async () => {
    const trace = await getCustomer(200);

    expect(trace.status).toBe('ok');
    expect(spanNamed(trace, '@features/customers/data/get-row.graph.json')?.status).toBe('ok');
    expect(spanNamed(trace, 'row')?.status).toBe('ok');
  });

  it('stamps every span from the run’s own clock, so a span never ends before it started', async () => {
    for (const span of spansOf(await getCustomer(500))) expect(span.endedAt).toBeGreaterThanOrEqual(span.startedAt);
  });
});

describe('what a level lets a span carry', () => {
  it('summary carries status, timing and what ran -- and never a value', async () => {
    const trace = atLevel(await getCustomer(500), 'summary');
    const asked = spanNamed(trace, 'asked');

    expect(asked?.attributes['wilanis.in']).toBeUndefined();
    expect(asked?.attributes['wilanis.out']).toBeUndefined();
    // what a reader searches on is still there: the address, the connection, the status
    expect(asked?.attributes['wilanis.at']).toBe('nodes/asked');
    expect(asked?.attributes['wilanis.connection']).toBe('@connections/customers-api.connection.json');
    expect(asked?.attributes['http.response.status_code']).toBe(500);
  });

  it('summary never carries a message: a reason is a declared word, a message is prose', async () => {
    const trace = atLevel(await getCustomer(500), 'summary');
    const refused = spanNamed(trace, 'failed');

    // the status still says the reason the author declared, which is a closed set and cannot leak
    expect(refused?.status).toBe('refused: upstream');
    expect(refused?.attributes['wilanis.error']).toBeUndefined();
  });

  it("full adds the report's already-redacted in and out, and the node's message", async () => {
    const trace = await getCustomer(500);
    const asked = spanNamed(trace, 'asked');
    const refused = spanNamed(trace, 'failed');

    expect(JSON.parse(String(asked?.attributes['wilanis.in'])).path).toBe('/customer/golf');
    expect(JSON.parse(String(asked?.attributes['wilanis.out'])).status).toBe(500);
    expect(refused?.attributes['wilanis.error']).toBe('the customer API answered 500');
  });

  it('summary drops the branches nothing took; full keeps them', async () => {
    const full = await getCustomer(500);
    const summary = atLevel(full, 'summary');

    expect(spansOf(full).map(one => one.name)).toContain('row');
    expect(spansOf(summary).map(one => one.name)).not.toContain('row');
  });

  it('a detail never enters a trace, at either level', async () => {
    // a challenge's detail is the one thing a report carries that no span may: it is how to answer a
    // challenge, not what a run did, and neither level is a place for it
    for (const level of ['summary', 'full'] as const) {
      const trace = atLevel(await getCustomer(500), level);
      const said = JSON.stringify(trace);
      expect(said).not.toContain('wilanis.detail');
      expect(said).not.toContain('"detail"');
    }
  });
});

describe('a run written out', () => {
  it('prints the run, then one line per span, indented by how deep it ran', async () => {
    const text = traceText(atLevel(await getCustomer(500), 'summary'));
    const lines = text.split('\n');

    expect(lines[0]).toMatch(
      /^trace [0-9a-f-]{36}\s+fire @features\/customers\/edge\/get-customer\.trigger\.json → refused: upstream\s+\d+ms$/,
    );
    expect(lines[1]).toMatch(/^ {2}@features\/customers\/domain\/customer\.port\.json#get\b/);
    expect(lines[2]).toMatch(/^ {4}binding @features\/customers\/data\/customers-rest\.binding\.json#get\b/);
    expect(lines.some(line => /^ {8}asked @http\/http\.port\.json#request\s+\d+ms {2}ok\b/.test(line))).toBe(true);
    // the reason the author declared is on the line, where a reader of a terminal looks first
    expect(text).toContain('refused: upstream');
  });

  it('prints the whole span tree as one object, so nothing the text form shows is missing from the json', async () => {
    const trace = atLevel(await getCustomer(500), 'summary');
    const parsed = JSON.parse(traceJson(trace)) as Trace;

    expect(parsed).toEqual(trace);
    expect(spansOf(parsed).map(one => one.name)).toEqual(spansOf(trace).map(one => one.name));
  });
});

describe('a startup step, said as spans', () => {
  it('roots the trace at the step and never at a trigger it does not have', async () => {
    const load = loadTree(EXAMPLE, PLUGINS, INCLUDES);
    const emb = embedderFor(load, { profile: 'local' });
    const heard: Ran[] = [];
    const served = new Served({ load, emb }, () => {});
    emb.serve(Object.assign(served, { ran: (what: Ran) => heard.push(what) }));

    await emb.startup({ run: '@customers/domain/customer.port.json#prepare', label: 'Prepare' }, { at: 0 });
    const trace = traceOf(heard[0] as Started, emb.scope);

    expect(trace.name).toBe('startup Prepare');
    expect(trace.attributes['wilanis.startup.at']).toBe(0);
    expect(trace.attributes['wilanis.operation']).toBe('@features/customers/domain/customer.port.json#prepare');
    // a step is not a trigger: nothing here says it was one
    expect(trace.attributes['wilanis.trigger']).toBeUndefined();
    expect(trace.attributes['wilanis.kind']).toBeUndefined();
    // and the run beneath it is there all the same, so a trace of a start says what a step did
    expect(trace.children.length).toBeGreaterThan(0);
  });
});

describe('the record and the trace are two things', () => {
  it('leaves the record untouched: traceOf reads and never writes', async () => {
    const { ran, scope } = await fire(GET_CUSTOMER, {
      input: { id: 'golf' },
      request: { params: { id: 'golf' }, headers: {} },
      stubs: { 'op.asked': { status: 500 } },
    });
    const before = JSON.stringify(ran);

    traceOf(ran, scope, { level: 'full' });
    traceOf(ran, scope, { level: 'summary' });

    expect(JSON.stringify(ran)).toBe(before);
    // and the same record read twice says the same thing, since nothing about the walk is stateful
    expect(traceOf(ran, scope)).toEqual(traceOf(ran, scope));
    expect((ran as Fired).trigger).toBe('@features/customers/edge/get-customer.trigger.json');
  });
});

describe('a run that calls another port operation', () => {
  it('shows the binding that met it and never the wrapper node the compiler lowered it to', async () => {
    // export runs a business graph whose nodes call two more port operations; each of those lowers to a
    // single node called `op`, which names nothing an author wrote and must not reach a reader
    const { ran, scope } = await fire(
      '@customers/edge/export-customers.trigger.json',
      { input: undefined, request: { params: {}, headers: {} } },
      'local',
    );
    const trace = traceOf(ran, scope);
    const names = spansOf(trace).map(one => one.name);

    // the claim here is what the spans are called, not how the run ended: nothing set the store's engine up,
    // so it faults, and a trace of a run that faulted names what it reached exactly as one that answered does
    // the call site, the binding that met it, and the graph inside it: three real names, no `op` between them
    expect(names).toContain('all @features/customers/data/customers-store.binding.json#listAll');
    expect(names).toContain('binding @features/customers/data/customers-store.binding.json#listAll');
    expect(names).toContain('@features/customers/data/kept-list.graph.json');
    expect(names.filter(name => name.startsWith('op '))).toEqual([]);
    expect(names.filter(name => name.startsWith('op ('))).toEqual([]);
  });

  it('names a native holds operation by its port, since no binding met it', async () => {
    const load = loadTree(EXAMPLE, PLUGINS, INCLUDES);
    const emb = embedderFor(load, { profile: 'local' });
    const heard: Ran[] = [];
    const served = new Served({ load, emb }, () => {});
    emb.serve(Object.assign(served, { ran: (what: Ran) => heard.push(what) }));

    await emb.startup({ run: '@reload/watch.port.json#watch', label: 'Watch' }, { at: 2 });
    try {
      const under = traceOf(heard[0], emb.scope).children[0];

      // a startup step may name one native `holds` operation, and there is no binding document to call it
      expect(under.name).toBe('@reload/watch.port.json#watch');
      expect(under.attributes['wilanis.port']).toBe('@reload/watch.port.json');
      expect(under.attributes['wilanis.binding']).toBeUndefined();
    } finally {
      // the watch is held whatever the assertions did: a failing expect must not leave it watching
      for (const holding of [...emb.held].reverse()) await holding.stop();
    }
  });
});
