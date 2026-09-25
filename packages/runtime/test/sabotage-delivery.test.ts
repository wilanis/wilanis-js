/**
 * What a queue trigger receives from (RFC 0009, T009 and T010). `remove-queued.trigger.json` receives from
 * `jobs.connection.json`, whose memory broker delivers at least once, so `customer.port.json#remove` may run twice
 * for one message and says it is safe to: `"idempotent": true`, which B011 holds under every profile. Each case
 * breaks one side of that: the promise, or the connection the trigger names.
 */
import { describe, expect, it } from 'vitest';
import {
  codes,
  EXAMPLE,
  plantedEditingAllAt,
  sabotage,
  sabotageHinting,
  sabotagePointing,
  sabotageSaying,
} from './example-harness.js';

const QUEUED = 'features/customers/edge/remove-queued.trigger.json';
const PORT = 'features/customers/domain/customer.port.json';
const JOBS = '@connections/jobs.connection.json';
const HTTP = '@connections/customers-api.connection.json';
const REMOVE = '@customers/domain/customer.port.json#remove';
const AT_CONNECTION = `T010 @${QUEUED}#settings/connection`;

/** An edit that has the queue trigger receive from `connection`. */
const receivingFrom = (connection: string) => (trigger: any) => {
  trigger.settings.connection = connection;
};

/** An edit that takes the customer port's `remove` back from its promise. */
const unpromised = (port: any) => {
  delete port.operations.remove.idempotent;
};

describe('sabotage: what a queue trigger receives from (RFC 0009)', () => {
  it('checks clean as written, the promise on remove held under every profile', () => {
    expect(codes(EXAMPLE)).toEqual([]);
  });

  it('T009 an at-least-once connection firing an operation that does not promise idempotent', () => {
    expect(sabotage(PORT, unpromised)).toEqual(['T009']);
    expect(sabotagePointing(PORT, unpromised)).toEqual([`T009 @${QUEUED}#fire/run`]);
    expect(sabotageSaying(PORT, unpromised)).toEqual([
      `T009 '${JOBS}' delivers a message at least once, so '${REMOVE}' may run twice for one message, and the operation does not promise idempotent`,
    ]);
    expect(sabotageHinting(PORT, unpromised)).toEqual([
      `T009 declare "idempotent": true on ${REMOVE} (the checker then holds every profile to it, B011), or receive from a connection whose kind delivers at most once`,
    ]);
  });

  it('T010 a connection whose kind declares no delivery', () => {
    expect(sabotage(QUEUED, receivingFrom(HTTP))).toEqual(['T010']);
    expect(sabotagePointing(QUEUED, receivingFrom(HTTP))).toEqual([AT_CONNECTION]);
    expect(sabotageSaying(QUEUED, receivingFrom(HTTP))).toEqual([
      `T010 '${HTTP}' is a connection of kind '@http/http.connection-kind.json', which declares no delivery: it hands a trigger no messages`,
    ]);
    expect(sabotageHinting(QUEUED, receivingFrom(HTTP))).toEqual([
      'T010 receive from a connection whose kind declares delivery; wilanis ls connection-kind',
    ]);
  });

  it('T010 a connection path that names no document', () => {
    const nope = '@connections/nope.connection.json';
    expect(sabotagePointing(QUEUED, receivingFrom(nope))).toEqual([AT_CONNECTION]);
    expect(sabotageSaying(QUEUED, receivingFrom(nope))).toEqual([
      `T010 settings.connection names no connection: '${nope}'`,
    ]);
  });

  it('T010 a connection read rather than written as a path', () => {
    expect(sabotagePointing(QUEUED, receivingFrom('{{secrets.jwt}}'))).toEqual([AT_CONNECTION]);
  });

  it('asks no promise of what a trigger fires where its connection delivers nothing: T010 alone', () => {
    const edits = { [PORT]: unpromised, [QUEUED]: receivingFrom(HTTP) };
    expect(plantedEditingAllAt({}, edits)).toEqual([AT_CONNECTION]);
  });
});
