/**
 * A message correlates its run with the publisher's trace the way a request does: the kind declares
 * `correlation: headers.traceparent`, T007 holds that path to the context the kind hands, and the runtime copies
 * what the message's headers carry there onto the run's trace. Nothing in the worker reads it; the kind says
 * where it is and the embedder reads it, as it does for a route (RFC 0006).
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import { loadTree, type Trace } from '@wilanis/core';
import { describe as describeDoc, start } from '@wilanis/runtime';
import { afterEach, describe, expect, it } from 'vitest';
import queue from '../src/index.js';
import { KIND } from '../src/paths.js';
import { FakeBroker } from './fake-broker.js';
import { until } from './harness.js';
import { JOBS, pluginsWith, tree, written } from './tree.js';

const PARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const REMOVALS = '@features/customers/edge/removals.trigger.json';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The refusals of the tree when @queue's trigger kind says `correlation` is the given path. */
function withCorrelation(path: string): string[] {
  const docs = mkdtempSync(join(tmpdir(), 'wilanis-queue-kind-'));
  dirs.push(docs);
  cpSync(queue.docs, docs, { recursive: true });
  const file = join(docs, 'queue.trigger-kind.json');
  const kind = JSON.parse(readFileSync(file, 'utf8'));
  kind.correlation = path;
  writeFileSync(file, JSON.stringify(kind));
  const dir = written(tree());
  dirs.push(dir);
  const refusals = checkTree(loadTree(dir, { ...pluginsWith(), '@queue': { ...queue, docs } })).items;
  return refusals.map(one => `${one.code} ${one.file}${one.at ? `#${one.at}` : ''}`);
}

describe("a queue trigger's correlation", () => {
  it('names a field of the context the kind hands, which T007 accepts and a wrong path would not', () => {
    const dir = written(tree());
    dirs.push(dir);
    const loaded = loadTree(dir, pluginsWith());

    expect(loaded.registry.get('trigger-kind', KIND)?.doc.correlation).toBe('headers.traceparent');
    expect(checkTree(loaded).items.map(one => one.code)).not.toContain('T007');
    expect(describeDoc(loaded, KIND)).toContain(
      "correlation: request.headers.traceparent correlates a run with the caller's trace, copied opaquely (T007)",
    );
    // the rule judges this kind too: a path its context has no field for is refused at the kind
    expect(withCorrelation('traceparent')).toEqual([`T007 ${KIND}#correlation`]);
  });

  it("carries the traceparent a message's headers hold onto the trace of the run it fires", async () => {
    const dir = written(tree());
    dirs.push(dir);
    const broker = new FakeBroker();
    const traces: Trace[] = [];
    const served = await start(loadTree(dir, pluginsWith(broker)), {
      log: () => {},
      observe: trace => traces.push(trace),
    });
    try {
      await broker.publish(JOBS, 'removals', { body: { id: 'golf' }, headers: { traceparent: PARENT } });
      await broker.publish(JOBS, 'removals', { body: { id: 'golf' }, headers: {} });
      const fired = () => traces.filter(trace => trace.attributes['wilanis.trigger'] === REMOVALS);
      expect(await until(() => fired().length === 2)).toBe(true);

      const [carried, bare] = fired();
      expect(carried.attributes['wilanis.kind']).toBe(KIND);
      expect(carried.attributes['wilanis.correlation']).toBe(PARENT);
      // a message whose headers hold no traceparent correlates nothing, as a request without one does
      expect(bare.attributes['wilanis.correlation']).toBeUndefined();
    } finally {
      await served.stop();
    }
  }, 10_000);
});
