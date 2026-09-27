/**
 * What the exporter says when a batch cannot be sent, given a sender that refuses the way a real one does. The
 * OTLP exporter hands Node's own error back for a collector that is not there: an `AggregateError`, one attempt
 * per address, with an empty message and the code on the error itself -- which is why `wilanis start` once
 * logged `6 span(s) not exported ()`. The reason in the parentheses is never empty.
 *
 * And how long a stop waits on a sender that has not answered: `flushDeadlineMs`, then one line and on. A sender
 * here that never answers is what the OTLP exporter is for the seconds it spends retrying a collector it cannot
 * reach, so a stop that resolves at all is a stop that did not wait on it.
 */
import type { Trace } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { Exporter, reasonOf, type Sends } from '../src/exporter.js';
import type { Configured } from '../src/settings.js';

/** What every case here is configured with; only the deadline changes between them. */
const configured = (flushDeadlineMs = 2000): Configured => ({
  endpoint: 'http://localhost:4318/v1/traces',
  service: 'customers',
  headers: {},
  level: 'summary',
  flushDeadlineMs,
});

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
    configured: configured(),
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

/**
 * A sender that answers nothing until the case says so: `answer` settles every batch it was handed, as a retry
 * that finally gives up would. `closes` is whether its shutdown ever resolves.
 */
function holding(closes = true) {
  const pending: ((result: { code: number; error?: Error }) => void)[] = [];
  const sends: Sends = {
    export: (_spans, done) => {
      pending.push(done);
    },
    shutdown: () => (closes ? Promise.resolve() : new Promise<void>(() => {})),
  };
  const answer = (result: { code: number; error?: Error }) => {
    for (const done of pending.splice(0)) done(result);
  };
  return { sends, answer };
}

/** An exporter over this sender, with this deadline, and the lines it logs. */
function exporting(sends: Sends, flushDeadlineMs: number) {
  const logs: string[] = [];
  const exporter = new Exporter({ sends, configured: configured(flushDeadlineMs), log: line => logs.push(line) });
  return { exporter, logs };
}

describe('a stop waits on the collector no longer than flushDeadlineMs', () => {
  it('a sender that never answers is left behind at the deadline, in one line naming what it held', async () => {
    const { sends } = holding();
    const { exporter, logs } = exporting(sends, 50);
    exporter.take(trace());
    await exporter.stop(); // without the bound this never resolves, and the case times out
    expect(logs).toEqual(['otel: 1 span(s) not exported (the collector did not take them within 50ms of the stop)']);
  });

  it('the answer that comes after the deadline is not said again: the stop already said it', async () => {
    const { sends, answer } = holding();
    const { exporter, logs } = exporting(sends, 50);
    exporter.take(trace());
    await exporter.stop();
    answer({ code: 1, error: refused() });
    expect(logs).toHaveLength(1);
  });

  it('a batch already on its way when the stop comes is counted with the one the stop sends', async () => {
    const { sends } = holding();
    const { exporter, logs } = exporting(sends, 50);
    exporter.take(trace());
    void exporter.flush(); // what the batch timer would have sent before the stop
    exporter.take(trace());
    await exporter.stop();
    expect(logs).toEqual(['otel: 2 span(s) not exported (the collector did not take them within 50ms of the stop)']);
  });

  it('a collector that answers within the deadline is waited for, and nothing is said', async () => {
    const { sends, answer } = holding();
    const { exporter, logs } = exporting(sends, 1000);
    exporter.take(trace());
    setTimeout(() => answer({ code: 0 }), 20);
    await exporter.stop();
    expect(logs).toEqual([]);
  });

  it('a sender that took every span and will not close is said as that, not as spans lost', async () => {
    const { sends, answer } = holding(false);
    const { exporter, logs } = exporting(sends, 50);
    exporter.take(trace());
    setTimeout(() => answer({ code: 0 }), 5);
    await exporter.stop();
    expect(logs).toEqual(['otel: the exporter did not close within 50ms of the stop; going on without it']);
  });
});
