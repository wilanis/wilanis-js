/** What a document may say about repeating and bounding a call (RFC 0011): the words, not what retries. */
import { describe, expect, it } from 'vitest';
import { NODE_MAP } from '../src/model.js';
import { at, doc, refused, run } from './documents.js';

describe('an operation says whether a repeat is safe', () => {
  const op = (extra: Record<string, unknown>) =>
    doc('port', { operations: { request: { description: 'one', accepts: { method: { type: 'string' } }, ...extra } } });

  it('idempotent is a boolean, or an expression over the accepted fields', () => {
    expect(refused(op({ idempotent: true }))).toEqual([]);
    expect(refused(op({ idempotent: "method == 'GET' || method == 'HEAD'" }))).toEqual([]);
    expect(refused(op({ idempotent: 3 }))).toEqual([at('operations/request/idempotent', 'must be boolean,string')]);
    expect(refused(op({ idempotent: '' }))).toEqual([at('operations/request/idempotent', 'fewer than 1 characters')]);
  });

  it('key names one accepted field, as an identifier', () => {
    expect(refused(op({ key: 'method' }))).toEqual([]);
    expect(refused(op({ key: 'Idempotency-Key' }))).toEqual([at('operations/request/key', 'identifier')]);
    expect(refused(op({ key: 3 }))).toEqual([at('operations/request/key', 'must be string')]);
  });
});

describe('a call site says how long and how often', () => {
  const node = (extra: Record<string, unknown>) => doc('graph', { nodes: [run('a', extra)] });
  const map = (extra: Record<string, unknown>) =>
    doc('graph', { nodes: [{ type: NODE_MAP, id: 'm', run: '@x/p.json#op', over: '{{in.list}}', ...extra }] });
  const bound = (extra: Record<string, unknown>) => doc('binding', { operations: { get: extra } });

  it('a run node, a map node and a binding operation each take retry and timeoutMs', () => {
    const words = { timeoutMs: 5000, retry: { times: 2, backoffMs: 200, when: 'status >= 500' } };
    expect(refused(node(words))).toEqual([]);
    expect(refused(map(words))).toEqual([]);
    expect(refused(bound({ graph: '@features/f/data/g.graph.json', ...words }))).toEqual([]);
    expect(refused(bound({ run: '@x/p.json#op', in: {}, ...words }))).toEqual([]);
  });

  it('retry says times, at least one more try; backoffMs is a wait of zero or more; when is an expression', () => {
    expect(refused(node({ retry: { times: 0 } }))).toEqual([at('nodes/a/retry/times', 'must be >= 1')]);
    expect(refused(node({ retry: { times: 1.5 } }))).toEqual([at('nodes/a/retry/times', 'must be integer')]);
    expect(refused(node({ retry: {} }))).toEqual([at('nodes/a/retry', "missing 'times'")]);
    expect(refused(node({ retry: { times: 1, backoffMs: -1 } }))).toEqual([
      at('nodes/a/retry/backoffMs', 'must be >= 0'),
    ]);
    expect(refused(node({ retry: { times: 1, when: '' } }))).toEqual([
      at('nodes/a/retry/when', 'fewer than 1 characters'),
    ]);
    expect(refused(node({ retry: { times: 1, jitter: true } }))).toEqual([
      at('nodes/a/retry', "unknown property 'jitter'"),
    ]);
  });

  it('timeoutMs is a number of milliseconds above zero', () => {
    expect(refused(node({ timeoutMs: 0 }))).toEqual([at('nodes/a/timeoutMs', 'must be > 0')]);
    expect(refused(node({ timeoutMs: '5s' }))).toEqual([at('nodes/a/timeoutMs', 'must be number')]);
    expect(refused(map({ timeoutMs: 0, retry: { times: 0 } }))).toEqual([
      at('nodes/m/timeoutMs', 'must be > 0'),
      at('nodes/m/retry/times', 'must be >= 1'),
    ]);
  });

  it('beside a graph, a binding operation holds retry and timeoutMs to the same bounds, and still takes no run', () => {
    expect(refused(bound({ graph: '@features/f/data/g.graph.json', timeoutMs: 0, retry: { times: 0 } }))).toEqual([
      at('operations/get/timeoutMs', 'must be > 0'),
      at('operations/get/retry/times', 'must be >= 1'),
    ]);
    expect(
      refused(bound({ graph: '@features/f/data/g.graph.json', run: '@x/p.json#op', retry: { times: 1 } })),
    ).toEqual([at('operations/get/run', "'run' is not allowed here")]);
  });
});
