/**
 * The port and connection-kind schemas beyond their baseline (RFC 0024): where the address an operation binds
 * comes from (`listens`), and which setting of a kind holds the address a connection dials (`endpoint`).
 */
import { describe, expect, it } from 'vitest';
import { at, doc, refused } from './documents.js';

const op = (extra: Record<string, unknown>) => doc('port', { operations: { get: { description: 'one', ...extra } } });

describe("an operation's listens", () => {
  const port = { input: 'port', setting: 'port', default: 8080 };

  it('names where the port and the interface come from, the interface with no default', () => {
    expect(refused(op({ holds: true, listens: { port, host: { input: 'host', setting: 'host' } } }))).toEqual([]);
    expect(refused(op({ holds: true, listens: { port: { default: 8080 } } }))).toEqual([]);
  });

  it('requires the port, and each part says at least one of input, setting and default', () => {
    expect(refused(op({ listens: { host: { input: 'host' } } }))).toEqual([
      at('operations/get/listens', "missing 'port'"),
    ]);
    expect(refused(op({ listens: { port: {} } }))).toEqual([at('operations/get/listens/port', 'fewer than 1')]);
  });

  it('takes a number as the default port, and nothing beyond port and host', () => {
    expect(refused(op({ listens: { port: { default: '8080' } } }))).toEqual([
      at('operations/get/listens/port/default', 'must be number'),
    ]);
    expect(refused(op({ listens: { port, path: {} } }))).toEqual([
      at('operations/get/listens', "unknown property 'path'"),
    ]);
    expect(refused(op({ listens: { port: { ...port, env: 'PORT' } } }))).toEqual([
      at('operations/get/listens/port', "unknown property 'env'"),
    ]);
  });
});

describe("a connection kind's endpoint", () => {
  const kind = (endpoint: unknown) => doc('connection-kind', { endpoint });

  it('is a dotted path into its settings', () => {
    expect(refused(kind('baseUrl'))).toEqual([]);
    expect(refused(kind('broker.url'))).toEqual([]);
    expect(refused(kind('settings/baseUrl'))).toEqual([at('endpoint', 'must match')]);
    expect(refused(kind(1))).toEqual([at('endpoint', 'must be string')]);
  });
});
