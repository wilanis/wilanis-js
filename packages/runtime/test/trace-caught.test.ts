/**
 * A fault a switch caught, said as spans (RFC 0014, step 12). The example writes no `catch` yet, so every report
 * here is written by hand, the way the engine leaves a caught fault -- the node `failed` and marked with the
 * switch that routed it, the switch `selected` where its `catch` sent the run -- and run through `traceOf`
 * against the example's scope. The root's `blocked` sits here too: it is the one ending the rest of the trace
 * files never reach.
 */
import { rmSync } from 'node:fs';
import { loadTree, type Trace } from '@wilanis/core';
import { type NodeReport, outcomeOf, type Report } from '@wilanis/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { atLevel, embedderFor, type Fired, type Started, traceOf, traceText } from '../src/index.js';
import { EXAMPLE, INCLUDES, loadedEditing, PLUGINS } from './example-harness.js';

const BINDING = '@features/customers/data/customers-rest.binding.json';
const GET_ROW = '@features/customers/data/get-row.graph.json';
const HTTP = '@http/http.port.json#request';
const REFUSE = '@std/outcome.port.json#refuse';

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

/** A node that never ran because its switch routed elsewhere. */
const cancelled: NodeReport = { status: 'cancelled' };

/**
 * get-row's run where `fetched` broke and `outcome` caught it, routing to `unreachable`, which refused
 * `upstream` -- what the RFC's guide writes, with the example's node names.
 */
function caughtRun(fetched: Partial<NodeReport> = {}): Report {
  return {
    graph: GET_ROW,
    status: 'failed',
    startedAt: 100,
    endedAt: 190,
    nodes: {
      fetched: {
        status: 'failed',
        handler: HTTP,
        error: 'fetch failed',
        caught: 'outcome',
        startedAt: 100,
        endedAt: 150,
        ...fetched,
      },
      outcome: { status: 'done', in: {}, out: 'unreachable', selected: 'unreachable', startedAt: 150, endedAt: 150 },
      customer: cancelled,
      noCustomer: cancelled,
      upstreamFailed: cancelled,
      unreachable: {
        status: 'failed',
        handler: REFUSE,
        reason: 'upstream',
        error: 'the customer API could not be reached',
        startedAt: 150,
        endedAt: 190,
      },
    },
  };
}

/**
 * The binding operation `get`, lowered to its one `op` node, running the given get-row. A nested refusal reaches
 * the node that ran it, as the engine carries it, so the op says the reason its graph refused with.
 */
const bound = (sub: Report): Report => {
  const refused = outcomeOf(sub);
  const reason = refused.kind === 'refused' ? { reason: refused.reason } : {};
  return {
    graph: `${BINDING}#get`,
    status: sub.status,
    startedAt: 90,
    endedAt: 200,
    nodes: { op: { status: sub.status === 'done' ? 'done' : 'failed', handler: `graph:${GET_ROW}`, sub, ...reason } },
  };
};

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

describe('a node whose fault a switch caught', () => {
  it('is failed (caught): it broke, and the run went on', () => {
    const trace = traceOf(step(bound(caughtRun())), scope);

    expect(named(trace, `fetched ${HTTP}`)?.status).toBe('failed (caught)');
    // the run ended where the catch sent it, on the reason the graph declared, not on the fault
    expect(named(trace, `unreachable ${REFUSE}`)?.status).toBe('refused: upstream');
    expect(trace.status).toBe('refused: upstream');
  });

  it('carries what it threw at full only, since a fault is a message like any other', () => {
    const full = traceOf(step(bound(caughtRun())), scope, { level: 'full' });
    const summary = traceOf(step(bound(caughtRun())), scope);

    expect(named(full, `fetched ${HTTP}`)?.attributes['wilanis.error']).toBe('fetch failed');
    expect(named(summary, `fetched ${HTTP}`)?.attributes['wilanis.error']).toBeUndefined();
    expect(named(atLevel(full, 'summary'), `fetched ${HTTP}`)?.attributes['wilanis.error']).toBeUndefined();
    // the reason the target refused with is summary's; its message is not
    expect(named(summary, `unreachable ${REFUSE}`)?.attributes['wilanis.error']).toBeUndefined();
  });

  it('stays plain failed where nothing caught it', () => {
    const uncaught = caughtRun({ caught: undefined });

    expect(named(traceOf(step(bound(uncaught)), scope), `fetched ${HTTP}`)?.status).toBe('failed');
  });

  it('is failed (caught) on a map node, and on a map element marked so', () => {
    const report: Report = {
      graph: GET_ROW,
      status: 'failed',
      startedAt: 10,
      endedAt: 30,
      nodes: {
        each: {
          status: 'failed',
          handler: HTTP,
          caught: 'outcome',
          error: 'element 1 broke',
          items: [
            { status: 'done', handler: HTTP },
            { status: 'failed', handler: HTTP, caught: 'outcome', error: 'reset' },
          ],
        },
      },
    };
    const each = named(traceOf(step(bound(report)), scope), 'each map ×2');

    expect(each?.status).toBe('failed (caught)');
    expect(each?.children.map(one => one.status)).toEqual(['ok', 'failed (caught)']);
  });
});

describe('the switch that caught it', () => {
  it('names the caught node at summary, beside where it routed', () => {
    const outcome = named(traceOf(step(bound(caughtRun())), scope), 'outcome switch → unreachable');

    expect(outcome?.attributes['wilanis.caught']).toBe('fetched');
    expect(outcome?.attributes['wilanis.selected']).toBe('unreachable');
    expect(traceText(traceOf(step(bound(caughtRun())), scope))).toMatch(
      /outcome switch → unreachable .*selected=unreachable caught=fetched/,
    );
  });

  it('names nothing caught where it routed on its rules', () => {
    const answered: Report = {
      graph: GET_ROW,
      status: 'done',
      startedAt: 100,
      endedAt: 190,
      nodes: {
        fetched: { status: 'done', handler: HTTP, out: { status: 200 } },
        outcome: { status: 'done', selected: 'customer' },
      },
    };
    const outcome = named(traceOf(step(bound(answered)), scope), 'outcome switch → customer');

    expect(outcome?.attributes).not.toHaveProperty('wilanis.caught');
  });

  describe('where two of its caught nodes broke', () => {
    let dir = '';
    let edited: typeof scope;

    beforeAll(() => {
      // outcome catches customer before fetched: the document's order, not the report's, is the one it routes on
      const loaded = loadedEditing('features/customers/data/get-row.graph.json', doc => {
        const outcome = doc.nodes.find((node: { id: string }) => node.id === 'outcome');
        outcome.catch = { customer: 'upstreamFailed', fetched: 'noCustomer' };
      });
      dir = loaded.dir;
      edited = embedderFor(loaded.load, { profile: 'live' }).scope;
    });

    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    const bothBroke = (): Report => {
      const run = caughtRun();
      run.nodes.customer = { status: 'failed', handler: '@std/object.port.json#make', error: 'no', caught: 'outcome' };
      return run;
    };

    it('names the one its catch lists first, which is the one it routed on', () => {
      const outcome = named(traceOf(step(bound(bothBroke())), edited), 'outcome switch → unreachable');

      expect(outcome?.attributes['wilanis.caught']).toBe('customer');
    });

    it('falls back to the report order where the tree does not say', () => {
      const outcome = named(traceOf(step(bound(bothBroke())), scope), 'outcome switch → unreachable');

      expect(outcome?.attributes['wilanis.caught']).toBe('fetched');
    });
  });
});

describe('a run blocked on a root nothing supplied', () => {
  const blocked: Report = { graph: GET_ROW, status: 'blocked', needs: ['in.id'], startedAt: 5, endedAt: 5, nodes: {} };

  it('says blocked on the root span of a fire', () => {
    const fired: Fired = {
      id: 'run-3',
      trigger: '@features/customers/edge/get-customer.trigger.json',
      kind: '@http/http.trigger-kind.json',
      decisions: [],
      run: blocked,
      answer: blocked,
      startedAt: 5,
      endedAt: 5,
    };

    expect(traceOf(fired, scope).status).toBe('blocked');
  });

  it('says blocked on the root span of a startup step', () => {
    expect(traceOf(step(blocked), scope).status).toBe('blocked');
  });
});
