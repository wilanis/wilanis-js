/**
 * What the exporter says when a batch cannot be sent, given a sender that refuses the way a real one does. The
 * OTLP exporter hands Node's own error back for a collector that is not there: an `AggregateError`, one attempt
 * per address, with an empty message and the code on the error itself -- which is why `wilanis start` once
 * logged `6 span(s) not exported ()`. The reason in the parentheses is never empty.
 */
import type { Trace } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { Exporter, reasonOf, type Sends } from '../src/exporter.js';

/** The trace of one run, small enough that what is said of its batch is the whole of the log. */
const trace = (): Trace => ({
  name: 'fire @customers/edge/get-customer.trigger.json',
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_000_143,
  status: 'ok',
  attributes: { 'wilanis.trigger': '@customers/edge/get-customer.trigger.json' },
  children: [],
});

/** A sender that refuses every batch with one error, as the OTLP exporter does against a port nobody listens on. */
function refusing(error: unknown): Sends {
  return {
    export: (_spans, done) => done({ code: 1, error: error as Error }),
    shutdown: async () => {},
  };
}

/** What the exporter logs of one batch a sender refused with this error. */
async function said(error: unknown): Promise<string[]> {
  const logs: string[] = [];
  const exporter = new Exporter({
    sends: refusing(error),
    configured: { endpoint: 'http://localhost:4318/v1/traces', service: 'customers', headers: {}, level: 'summary' },
    log: line => logs.push(line),
  });
  exporter.take(trace());
  await exporter.flush();
  return logs;
}

/** Node's refused connection: an AggregateError over one error per address, its own message empty. */
function refused(): AggregateError {
  const attempts = ['::1', '127.0.0.1'].map(address =>
    Object.assign(new Error(`connect ECONNREFUSED ${address}:4318`), { code: 'ECONNREFUSED' }),
  );
  return Object.assign(new AggregateError(attempts), { code: 'ECONNREFUSED' });
}

describe('the reason a batch was not exported', () => {
  it("reads a refused connection's code, where Node's AggregateError carries no message", async () => {
    expect(await said(refused())).toEqual(['otel: 1 span(s) not exported (ECONNREFUSED)']);
  });

  it('reads the first inner error when the aggregate has neither message nor code', async () => {
    const inner = Object.assign(new Error(''), { code: 'ETIMEDOUT' });
    expect(await said(new AggregateError([inner]))).toEqual(['otel: 1 span(s) not exported (ETIMEDOUT)']);
  });

  it('never says nothing: an error with no message, code or errors is a refused connection', async () => {
    expect(await said(new AggregateError([]))).toEqual(['otel: 1 span(s) not exported (connection refused)']);
    expect(await said(new Error(''))).toEqual(['otel: 1 span(s) not exported (connection refused)']);
  });

  it('reads a message where there is one, and a bare value as itself', async () => {
    expect(await said(new Error('collector answered 503'))).toEqual([
      'otel: 1 span(s) not exported (collector answered 503)',
    ]);
    expect(reasonOf('refused')).toBe('refused');
    expect(reasonOf(undefined)).toBe('undefined');
  });
});
