/**
 * What a report means to the message that fired it, read off reports built by hand: one function decides it for
 * the worker and for `encode`, so this is the one place its table is pinned.
 */
import type { TriggerDoc } from '@wilanis/core';
import type { Report } from '@wilanis/engine';
import { describe, expect, it } from 'vitest';
import queue from '../src/index.js';
import { outcomeOf } from '../src/outcome.js';
import { KIND } from '../src/paths.js';

/** A queue trigger with the settings a case varies. */
const trigger = (settings: Record<string, unknown> = {}): TriggerDoc =>
  ({
    $schema: '@wilanis/trigger.schema.json',
    description: 'a queue trigger, for a test',
    kind: KIND,
    settings: { connection: '@connections/jobs.connection.json', queue: 'removals', message: 'x', ...settings },
    fire: { run: '@customers/domain/customer.port.json#remove' },
  }) as TriggerDoc;

const ran = { graph: 'g', nodes: {}, startedAt: 0, endedAt: 1 };
const answered: Report = { ...ran, status: 'done', output: { id: 'golf' } };
const refused = (reason: string): Report => ({
  ...ran,
  status: 'failed',
  nodes: { gone: { status: 'failed', reason, error: `${reason}: golf`, endedAt: 1 } },
});
const faulted: Report = { ...ran, status: 'failed', nodes: { gone: { status: 'failed', error: 'boom', endedAt: 1 } } };
const blocked: Report = { ...ran, status: 'blocked', needs: ['in.id'] };

describe('what a report means to its message', () => {
  const table = trigger({ outcomes: { missing: 'ack', upstream: 'retry', forbidden: 'dead' } });

  it('an answer is acknowledged', () => {
    expect(outcomeOf(table, answered)).toMatchObject({ outcome: 'ack', ended: 'done' });
  });

  it('a refusal is what outcomes maps its reason to', () => {
    expect(outcomeOf(table, refused('missing')).outcome).toBe('ack');
    expect(outcomeOf(table, refused('forbidden')).outcome).toBe('dead');
    expect(outcomeOf(table, refused('upstream'))).toMatchObject({
      outcome: 'retry',
      reason: 'upstream',
      message: 'upstream: golf',
    });
  });

  it('a reason outcomes does not map, which only a reload brings about, is a fault', () => {
    expect(outcomeOf(table, refused('conflict'))).toMatchObject({ outcome: 'retry', reason: 'conflict' });
    expect(outcomeOf(trigger({ onFault: 'dead' }), refused('conflict')).outcome).toBe('dead');
  });

  it('a fault, or a blocked run, is onFault: retry unless it says dead', () => {
    expect(outcomeOf(table, faulted)).toMatchObject({ outcome: 'retry', ended: 'failed (boom)' });
    expect(outcomeOf(table, blocked).outcome).toBe('retry');
    expect(outcomeOf(trigger({ onFault: 'dead' }), faulted).outcome).toBe('dead');
  });

  it('the wait before a retry doubles with every attempt, from backoffMs', () => {
    const doubling = trigger({ backoffMs: 10, outcomes: { upstream: 'retry' } });
    expect([1, 2, 3].map(attempt => outcomeOf(doubling, refused('upstream'), attempt).backoffMs)).toEqual([10, 20, 40]);
    expect(outcomeOf(trigger(), faulted).backoffMs).toBe(1000);
  });

  it('a retry on the last delivery maxAttempts allows is dead: five by default', () => {
    const twice = trigger({ maxAttempts: 2, outcomes: { upstream: 'retry' } });
    expect(outcomeOf(twice, refused('upstream'), 1).outcome).toBe('retry');
    expect(outcomeOf(twice, refused('upstream'), 2)).toMatchObject({ outcome: 'dead', reason: 'upstream' });
    expect(outcomeOf(trigger(), faulted, 4).outcome).toBe('retry');
    expect(outcomeOf(trigger(), faulted, 5).outcome).toBe('dead');
  });
});

describe('the kind encodes a report as what the message would become', () => {
  const encode = queue.triggers?.[KIND]?.encode;

  it('a refusal says the outcome, the reason and the message, as the first delivery would', () => {
    expect(encode?.(trigger({ outcomes: { upstream: 'retry' } }), refused('upstream'))).toEqual({
      outcome: 'retry',
      reason: 'upstream',
      message: 'upstream: golf',
    });
  });

  it('an answer says ack and nothing else, since nobody receives it', () => {
    expect(encode?.(trigger(), answered)).toEqual({ outcome: 'ack' });
  });
});
