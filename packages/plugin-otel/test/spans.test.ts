/**
 * What a trace becomes, without a socket: the mapping is pure, so what this plugin sends can be pinned
 * exactly rather than inferred from a collector's copy of it. `export.test.ts` then proves the same mapping
 * survives the wire.
 */
import type { Trace } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { at } from '../src/level.js';
import { configure } from '../src/settings.js';
import { parentOf, type Scope, spansOf } from '../src/spans.js';

const SCOPE: Scope = { service: 'customers', name: '@wilanis/plugin-otel', version: '0.1.0' };

/** A span of a trace, written as the runtime hands one. */
const span = (name: string, status: string, over: Partial<Trace> = {}): Trace => ({
  name,
  startedAt: 1_000,
  endedAt: 1_100,
  status,
  attributes: {},
  children: [],
  ...over,
});

describe('a trace becomes spans', () => {
  it('one span per thing that happened, root first, each hanging from the one above', () => {
    const spans = spansOf(
      span('fire t', 'ok', { children: [span('port#op', 'ok', { children: [span('asked h', 'ok')] })] }),
      SCOPE,
    );
    expect(spans.map(one => one.name)).toEqual(['fire t', 'port#op', 'asked h']);
    const ids = spans.map(one => one.spanContext().spanId);
    expect(spans[0].parentSpanContext).toBeUndefined();
    expect(spans[1].parentSpanContext?.spanId).toBe(ids[0]);
    expect(spans[2].parentSpanContext?.spanId).toBe(ids[1]);
    // one run is one trace
    expect(new Set(spans.map(one => one.spanContext().traceId)).size).toBe(1);
  });

  it('a sibling hangs from the same parent, not from the span before it', () => {
    const spans = spansOf(span('fire t', 'ok', { children: [span('a', 'ok'), span('b', 'ok')] }), SCOPE);
    const root = spans[0].spanContext().spanId;
    expect(spans[1].parentSpanContext?.spanId).toBe(root);
    expect(spans[2].parentSpanContext?.spanId).toBe(root);
  });

  it('two runs are two traces, so one request never gathers another', () => {
    const one = spansOf(span('fire t', 'ok'), SCOPE)[0].spanContext().traceId;
    const other = spansOf(span('fire t', 'ok'), SCOPE)[0].spanContext().traceId;
    expect(one).not.toBe(other);
  });

  it('milliseconds become the seconds and nanoseconds OTLP counts in', () => {
    const [one] = spansOf(span('fire t', 'ok', { startedAt: 1_700_000_000_143, endedAt: 1_700_000_000_500 }), SCOPE);
    expect(one.startTime).toEqual([1_700_000_000, 143_000_000]);
    expect(one.endTime).toEqual([1_700_000_000, 500_000_000]);
    expect(one.duration).toEqual([0, 357_000_000]);
  });

  it('a span that ended before it started lasts no time, rather than a negative one', () => {
    const [one] = spansOf(span('fire t', 'ok', { startedAt: 500, endedAt: 400 }), SCOPE);
    expect(one.duration).toEqual([0, 0]);
  });

  it("what ended well is ok, what did not is an error carrying the tree's own word", () => {
    const status = (word: string) => spansOf(span('n', word), SCOPE)[0].status;
    expect(status('ok')).toEqual({ code: 1 });
    expect(status('allowed')).toEqual({ code: 1 });
    expect(status('refused: upstream')).toEqual({ code: 2, message: 'refused: upstream' });
    expect(status('denied')).toEqual({ code: 2, message: 'denied' });
    expect(status('failed')).toEqual({ code: 2, message: 'failed' });
    // a branch not taken did not go wrong: it simply never ran
    expect(status('cancelled')).toEqual({ code: 0, message: 'cancelled' });
    expect(status('seeded')).toEqual({ code: 0, message: 'seeded' });
  });

  it('every span carries the service and the scope that sent it', () => {
    const [one] = spansOf(span('fire t', 'ok'), SCOPE);
    expect(one.resource.attributes['service.name']).toBe('customers');
    expect(one.instrumentationScope.name).toBe('@wilanis/plugin-otel');
  });
});

describe("a caller's correlation", () => {
  it('a traceparent gives the trace this run belongs to and the span it hangs from', () => {
    expect(parentOf('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')).toEqual({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
    });
  });

  it("whitespace around it is the caller's, not the meaning", () => {
    expect(parentOf('  00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01 ')).toBeDefined();
  });

  it('anything that is not one is no error: the id was copied opaquely and may be anything', () => {
    expect(parentOf('req-7f3a')).toBeUndefined();
    expect(parentOf('00-tooshort-00f067aa0ba902b7-01')).toBeUndefined();
    expect(parentOf(undefined)).toBeUndefined();
    expect(parentOf(42)).toBeUndefined();
  });

  it("the run joins the caller's trace when the correlation is one", () => {
    const [root] = spansOf(
      span('fire t', 'ok', {
        attributes: { 'wilanis.correlation': '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' },
      }),
      SCOPE,
    );
    expect(root.spanContext().traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(root.parentSpanContext?.spanId).toBe('00f067aa0ba902b7');
  });
});

describe('what a level lets a span carry', () => {
  const traced = span('asked h', 'ok', {
    attributes: { 'wilanis.node': 'asked', 'wilanis.in': '{"id":"golf"}', 'wilanis.error': 'no entry golf' },
    children: [span('missing', 'cancelled')],
  });

  it('summary keeps what a reader searches on and drops every value', () => {
    const kept = at(traced, 'summary');
    expect(kept.attributes).toEqual({ 'wilanis.node': 'asked' });
    expect(kept.children).toHaveLength(0);
  });

  it('full keeps the values and the branches not taken', () => {
    const kept = at(traced, 'full');
    expect(kept.attributes['wilanis.in']).toBe('{"id":"golf"}');
    expect(kept.attributes['wilanis.error']).toBe('no entry golf');
    expect(kept.children.map(one => one.name)).toEqual(['missing']);
  });

  it('a level is held at the edge too, so a trace built elsewhere cannot export a value at summary', () => {
    // what `traceOf` drops, this drops again: the thing that sends is what makes the level safe
    const deep = span('fire t', 'ok', { children: [traced] });
    const kept = at(deep, 'summary');
    expect(kept.children[0].attributes['wilanis.in']).toBeUndefined();
  });
});

describe('how the exporter is configured', () => {
  const env = (settings: Record<string, unknown>) => ({ plugins: { '@otel': settings } });

  it('summary stands where neither the step nor the settings said', () => {
    expect(configure(env({ endpoint: 'http://c/v1/traces', service: 'm' }), {}).level).toBe('summary');
  });

  it("the step's level wins over the plugin's", () => {
    expect(configure(env({ level: 'summary' }), { level: 'full' }).level).toBe('full');
  });

  it('a level that is not one falls back rather than exporting at a word nobody meant', () => {
    expect(configure(env({ level: 'verbose' }), {}).level).toBe('summary');
  });

  it('only the headers that really are strings are sent', () => {
    expect(configure(env({ headers: { 'x-api-key': 'shh', n: 7 } }), {}).headers).toEqual({ 'x-api-key': 'shh' });
  });
});
