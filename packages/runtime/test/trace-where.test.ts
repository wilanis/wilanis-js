/**
 * A map with a `where` said as spans (RFC 0039): its span says how many elements the rule kept, and a dropped
 * element's span is a cancelled one. The report is the kernel's own, so the trace reads what a run leaves behind.
 */
import type { Scope, Trace } from '@wilanis/core';
import { Kernel, type KernelSpec, type KMap, type Report } from '@wilanis/engine';
import { describe, expect, it } from 'vitest';
import { type Started, traceOf } from '../src/index.js';

/** A tree that holds no binding and no operation: the run below is a native one, and its map calls nothing it knows. */
const scope = { get: () => undefined, op: () => 'no such operation' } as unknown as Scope;

/** One startup step whose answer is the report given. */
const step = (answer: Report): Started => ({
  id: 'run-1',
  at: 0,
  label: 'Keep the even ones',
  run: '@test/numbers.port.json#evens',
  answer,
  startedAt: answer.startedAt,
  endedAt: answer.endedAt,
});

/** The span of the map `m`, the one child of the operation's span. */
const mapOf = (trace: Trace): Trace | undefined => trace.children[0]?.children[0];

/** A run of a map `m` over [1, 2, 3, 4], with the fields given. */
async function ran(fields: Partial<KMap>): Promise<Report> {
  const spec: KernelSpec = {
    name: '@test/numbers.port.json#evens',
    output: ['m'],
    nodes: { m: { kind: 'map', over: { value: [1, 2, 3, 4] }, in: {}, onItemFailure: 'fail', ...fields } },
  };
  return new Kernel({ same: async ({ in: input }) => input.item }).run(spec, { clock: () => 7 });
}

describe('the span of a map with a where', () => {
  it('says how many of its elements the rule kept, and a dropped one is cancelled', async () => {
    const where = { label: 'item % 2 == 0', when: (values: Record<string, unknown>) => Number(values.item) % 2 === 0 };
    const map = mapOf(traceOf(step(await ran({ where })), scope));
    expect(map?.name).toBe('m map ×4, kept 2');
    expect(map?.children.map(one => [one.name, one.status])).toEqual([
      ['m.0', 'cancelled'],
      ['m.1', 'ok'],
      ['m.2', 'cancelled'],
      ['m.3', 'ok'],
    ]);
  });

  it('is named as before where the map has no where', async () => {
    const map = mapOf(traceOf(step(await ran({ handler: 'same' })), scope));
    expect(map?.name).toBe('m map ×4');
  });
});
