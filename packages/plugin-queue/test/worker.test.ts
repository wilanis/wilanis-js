/**
 * The consume step, against a `Serving` that records what was fired and the fake broker: what becomes of a
 * message for each way its run can end, what the step consumes, how it stops, and what it refuses to start
 * with. The broker is real enough to redeliver, so a retry here is a second fire, not a flag.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeBroker } from './fake-broker.js';
import { type Answering, consuming, type Held, refusing, serving, trigger, until } from './harness.js';
import { JOBS } from './tree.js';

let running: { stop: () => Promise<unknown> } | undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
});

/** Consume with the fake broker, and remember to stop it once the case is done. */
async function started(
  given: ReturnType<typeof serving>,
  input: Record<string, unknown> = {},
  broker = new FakeBroker(),
) {
  const step = await consuming(given.serving, input, broker);
  running = step;
  return { ...step, broker };
}

describe('what becomes of a message', () => {
  it('an answer is acknowledged: fired once, with the context the kind declares, in a blob scope of its own', async () => {
    const given = serving([trigger()]);
    const broker = new FakeBroker();
    const { id } = await broker.publish(JOBS, 'removals', {
      body: { id: 'golf' },
      headers: { authorization: 'Bearer t' },
    });
    const { answer } = await started(given, {}, broker);
    expect(answer).toEqual({ queues: 1, connections: 1 });
    expect(await until(() => broker.answers.length === 1)).toBe(true);
    expect(broker.answers[0]).toMatchObject({ id, outcome: 'ack' });
    expect(given.fired).toEqual([
      {
        run: '@customers/domain/customer.port.json#remove',
        context: { id, attempt: 1, queue: 'removals', headers: { authorization: 'Bearer t' }, message: { id: 'golf' } },
      },
    ]);
    expect(given.blobs).toEqual({ scopes: 1, released: 1 });
    expect(given.logs).toContain(`queue: consuming removals on ${JOBS} → @customers/domain/customer.port.json#remove`);
    expect(given.logs.at(-1)).toMatch(
      /^queue removals m1 attempt 1 → ack \(\d+ms, @customers\/domain\/customer\.port\.json#remove done\)$/,
    );
    expect(broker.waiting(JOBS, 'removals')).toEqual([]);
  });

  it('a refusal outcomes acknowledges is gone, and fired once', async () => {
    const given = serving([trigger({ outcomes: { missing: 'ack' } })], () => ({ report: refusing('missing') }));
    const { broker } = await started(given);
    await broker.publish(JOBS, 'removals', { body: { id: 'golf' }, headers: {} });
    expect(await until(() => broker.answers.length === 1)).toBe(true);
    expect(broker.answers[0].outcome).toBe('ack');
    expect(given.logs.at(-1)).toMatch(/→ ack \(\d+ms, .*#remove refused missing \(missing: golf\)\)$/);
  });

  it('a retry is delivered again, the wait doubling, and dead on the last attempt maxAttempts allows', async () => {
    const given = serving([trigger({ maxAttempts: 3, backoffMs: 10, outcomes: { upstream: 'retry' } })], () => ({
      report: refusing('upstream'),
    }));
    const { broker } = await started(given);
    const { id } = await broker.publish(JOBS, 'removals', { body: { id: 'golf' }, headers: {} });
    expect(await until(() => broker.answers.length === 3)).toBe(true);
    expect(broker.answers).toEqual([
      { id, attempt: 1, outcome: 'retry', backoffMs: 10 },
      { id, attempt: 2, outcome: 'retry', backoffMs: 20 },
      { id, attempt: 3, outcome: 'dead' },
    ]);
    expect(given.fired.map(one => one.context.attempt)).toEqual([1, 2, 3]);
    expect(broker.parked(JOBS, 'removals')).toEqual([{ id, body: { id: 'golf' } }]);
  });

  it('a run that throws is a fault: retried by default, dead where onFault says so', async () => {
    const given = serving([trigger({ maxAttempts: 2, backoffMs: 0 })], () => ({ error: 'the registry is gone' }));
    const { broker } = await started(given);
    await broker.publish(JOBS, 'removals', { body: { id: 'golf' }, headers: {} });
    expect(await until(() => broker.answers.length === 2)).toBe(true);
    expect(broker.answers.map(one => one.outcome)).toEqual(['retry', 'dead']);
    expect(given.logs.at(-1)).toMatch(/#remove failed \(the registry is gone\)\)$/);

    const dead = serving([trigger({ onFault: 'dead' })], () => ({ error: 'the registry is gone' }));
    const other = new FakeBroker();
    await other.publish(JOBS, 'removals', { body: { id: 'golf' }, headers: {} });
    const step = await consuming(dead.serving, {}, other);
    try {
      expect(await until(() => other.answers.length === 1)).toBe(true);
      expect(other.answers[0].outcome).toBe('dead');
    } finally {
      await step.stop();
    }
  });

  it('a message whose input does not conform is dead at once, never fired, and the line says why', async () => {
    const given = serving([trigger()]);
    given.judging(() => ({ error: "field 'id': expected string, got number" }));
    const { broker } = await started(given);
    await broker.publish(JOBS, 'removals', { body: { id: 7 }, headers: {} });
    expect(await until(() => broker.answers.length === 1)).toBe(true);
    expect(broker.answers[0].outcome).toBe('dead');
    expect(given.fired).toEqual([]);
    expect(given.logs.at(-1)).toMatch(
      /→ dead \(\d+ms, input does not conform: field 'id': expected string, got number\)$/,
    );
  });
});

describe('what the step consumes, and when', () => {
  it('every queue once, grouped by connection, one hold each; queues narrows them', async () => {
    const triggers = [
      trigger(),
      trigger({ queue: 'receipts' }),
      trigger({ queue: 'purges' }, '@customers/domain/customer.port.json#purge'),
      trigger({ connection: '@connections/other.connection.json', queue: 'digests' }),
    ];
    const all = await consuming(serving(triggers).serving);
    try {
      expect(all.answer).toEqual({ queues: 4, connections: 2 });
      expect(all.held.map((one: Held) => one.label)).toEqual([
        `queue ${JOBS}`,
        'queue @connections/other.connection.json',
      ]);
    } finally {
      await all.stop();
    }
    const narrowed = await consuming(serving(triggers).serving, { queues: ['receipts'] });
    try {
      expect(narrowed.answer).toEqual({ queues: 1, connections: 1 });
    } finally {
      await narrowed.stop();
    }
  });

  it('a reload is seen by the next message: the trigger is found afresh on every delivery', async () => {
    const given = serving([trigger()]);
    const { broker } = await started(given);
    await broker.publish(JOBS, 'removals', { body: { id: 'one' }, headers: {} });
    expect(await until(() => given.fired.length === 1)).toBe(true);
    given.reloadWith([trigger({}, '@customers/domain/customer.port.json#archive')]);
    await broker.publish(JOBS, 'removals', { body: { id: 'two' }, headers: {} });
    expect(await until(() => given.fired.length === 2)).toBe(true);
    expect(given.fired[1].run).toBe('@customers/domain/customer.port.json#archive');
  });

  it('a message no trigger receives any more, across a reload, is delivered again later', async () => {
    const given = serving([trigger()]);
    const { broker } = await started(given);
    given.reloadWith([]);
    await broker.publish(JOBS, 'removals', { body: { id: 'one' }, headers: {} });
    expect(await until(() => broker.answers.length === 1)).toBe(true);
    expect(broker.answers[0]).toMatchObject({ outcome: 'retry', backoffMs: 1000 });
    expect(given.logs.at(-1)).toMatch(/→ retry \(\d+ms, no queue trigger receives it\)$/);
  });

  it('a stop takes nothing more and resolves once the delivery in flight has been answered', async () => {
    const given = serving([trigger()], () => ({ hold: true }));
    const broker = new FakeBroker();
    await broker.publish(JOBS, 'removals', { body: { id: 'one' }, headers: {} });
    await broker.publish(JOBS, 'removals', { body: { id: 'two' }, headers: {} });
    const step = await consuming(given.serving, {}, broker);
    expect(await until(() => given.fired.length === 1)).toBe(true);
    let stopped = false;
    const stopping = step.stop().then(() => {
      stopped = true;
    });
    await new Promise(done => setTimeout(done, 50));
    expect(stopped).toBe(false);
    given.release();
    await stopping;
    expect(broker.answers.map(one => one.outcome)).toEqual(['ack']);
    expect(given.fired).toHaveLength(1);
    expect(broker.waiting(JOBS, 'removals')).toHaveLength(1);
  });
});

describe('what the step refuses to start with', () => {
  it('a connection whose kind no broker registered: it throws naming both, and holds nothing', async () => {
    await expect(consuming(serving([trigger()]).serving, {}, 'none')).rejects.toThrow(
      `no broker for connection '${JOBS}', of kind '@fake-broker/fake.connection-kind.json'`,
    );
  });

  it('a concurrency that is no number of messages', async () => {
    await expect(consuming(serving([trigger()]).serving, { concurrency: 0 })).rejects.toThrow(
      /was given concurrency 0; it is a whole number, 1 or more/,
    );
  });

  it('a run from a graph, which has no tree being served to consume for', async () => {
    const { consume } = await import('../src/worker.js');
    await expect(consume({ in: {}, ctx: { env: {} } as never })).rejects.toThrow(/runs from a project's startup list/);
  });

  it('no queue trigger at all: nothing is consumed, and the log says so', async () => {
    const given = serving([]);
    const step = await consuming(given.serving);
    expect(step.answer).toEqual({ queues: 0, connections: 0 });
    expect(step.held).toEqual([]);
    expect(given.logs).toContain('queue: no queue trigger to consume');
  });
});

describe('a deadline (RFC 0044), on a fake clock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Publish one message and consume it under one trigger, the clock stopped once its run has been fired. */
  async function delivering(settings: Record<string, unknown>, answer: Answering) {
    const given = serving([trigger(settings)], () => answer);
    const broker = new FakeBroker();
    await broker.publish(JOBS, 'removals', { body: { id: 'golf' }, headers: {} });
    const step = await consuming(given.serving, {}, broker);
    await vi.advanceTimersByTimeAsync(0);
    return { given, broker, step };
  }

  it('a run past its deadline is told through its signal, and retried with the backoff', async () => {
    const { given, broker, step } = await delivering({ deadlineMs: 50, backoffMs: 1000 }, { untilCancelled: true });
    expect(given.handed).toHaveLength(1);
    const signal = given.handed[0] as AbortSignal;
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(49);
    expect(broker.answers).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal.aborted).toBe(true);
    expect(broker.answers).toEqual([{ id: 'm1', attempt: 1, outcome: 'retry', backoffMs: 1000 }]);
    expect(given.logs.at(-1)).toMatch(
      /^queue removals m1 attempt 1 → retry \(\d+ms, @customers\/domain\/customer\.port\.json#remove cancelled \(deadline\)\)$/,
    );
    expect(given.blobs).toEqual({ scopes: 1, released: 1 });
    await step.stop();
  });

  it('on the last attempt maxAttempts allows, a run past its deadline is dead', async () => {
    const { broker, step } = await delivering(
      { deadlineMs: 50, maxAttempts: 2, backoffMs: 10 },
      { untilCancelled: true },
    );
    await vi.advanceTimersByTimeAsync(200);
    expect(broker.answers).toEqual([
      { id: 'm1', attempt: 1, outcome: 'retry', backoffMs: 10 },
      { id: 'm1', attempt: 2, outcome: 'dead' },
    ]);
    expect(broker.parked(JOBS, 'removals')).toHaveLength(1);
    await step.stop();
  });

  it('onFault dead parks a run past its deadline at once', async () => {
    const { broker, step } = await delivering({ deadlineMs: 50, onFault: 'dead' }, { untilCancelled: true });
    await vi.advanceTimersByTimeAsync(50);
    expect(broker.answers).toEqual([{ id: 'm1', attempt: 1, outcome: 'dead' }]);
    await step.stop();
  });

  it('a run that answers in time is acknowledged, and its deadline is cleared', async () => {
    const { given, broker, step } = await delivering({ deadlineMs: 50 }, { afterMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    expect(broker.answers).toEqual([{ id: 'm1', attempt: 1, outcome: 'ack' }]);
    await vi.advanceTimersByTimeAsync(100);
    expect((given.handed[0] as AbortSignal).aborted).toBe(false);
    expect(given.logs.at(-1)).toMatch(/#remove done\)$/);
    await step.stop();
  });

  it('a trigger with no deadline hands its run no signal', async () => {
    const { given, broker, step } = await delivering({}, { afterMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    expect(given.handed).toEqual(['none']);
    expect(broker.answers).toEqual([{ id: 'm1', attempt: 1, outcome: 'ack' }]);
    await step.stop();
  });

  it('a stop while a run waits on its signal resolves once the deadline has cancelled it and the broker is answered', async () => {
    const { broker, step } = await delivering({ deadlineMs: 50 }, { untilCancelled: true });
    let stopped = false;
    const stopping = step.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(49);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(broker.answers).toEqual([{ id: 'm1', attempt: 1, outcome: 'retry', backoffMs: 1000 }]);
    expect(broker.waiting(JOBS, 'removals')).toHaveLength(1);
  });
});
