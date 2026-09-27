/**
 * The line a tick is logged as says what the run answered, and a log is a report: the answer is written as the run's
 * own report shows it, so a secret the run carried is the marker there whatever type the trigger's `out` answers it
 * under, and a field the trigger's `out` marks secret is the marker too, while the run's own output -- what anything
 * waiting on the tick is handed -- stays the value.
 */
import { rmSync } from 'node:fs';
import { checkTree } from '@wilanis/compiler';
import { loadTree, schemaRef, type Type } from '@wilanis/core';
import { embedderFor, Served } from '@wilanis/runtime';
import { describe, expect, it } from 'vitest';
import { fireTick, lineOf, type Tick } from '../src/fire.js';
import { KIND } from '../src/paths.js';
import { serving, trigger } from './harness.js';
import { type Docs, PLUGINS, tree, write } from './tree.js';

const TICK: Tick = { scheduled: '2026-09-11T03:00:00.000Z', fired: '2026-09-11T03:00:00.000Z', missed: 0 };

/** A digest whose token the trigger's out marks secret. */
const DIGEST: Type = {
  kind: 'object',
  fields: {
    count: { type: { kind: 'number' }, required: true },
    token: { type: { kind: 'string' }, required: true, secret: true },
  },
  open: false,
};

const STAMP = '@features/customers/edge/stamp.trigger.json';

/**
 * The small tree, with a second scheduled trigger whose `in` marks the key it fills from the tick secret, and whose
 * operation's graph makes that key a plain `string` and answers it: the trigger's `out` is a `string` that marks
 * nothing, so only the run's report says the answer is a secret.
 */
function stamping(): Docs {
  const docs = tree();
  const shape = (layer: string) => ({
    $schema: schemaRef('shape'),
    description: 'the key a stamp is made of',
    layer,
    fields: { key: { type: 'string', secret: true } },
  });
  docs['features/customers/domain/Key.shape.json'] = shape('core');
  docs['features/customers/edge/KeyView.shape.json'] = shape('edge');
  const port = docs['features/customers/domain/customer.port.json'] as { operations: Record<string, unknown> };
  port.operations.stamp = {
    description: 'a stamp made of a key',
    accepts: '@features/customers/domain/Key.shape.json',
    returns: 'string',
  };
  const binding = docs['features/customers/data/digest.binding.json'] as { operations: Record<string, unknown> };
  binding.operations.stamp = { graph: '@features/customers/data/stamp.graph.json' };
  docs['features/customers/data/stamp.graph.json'] = {
    $schema: schemaRef('graph'),
    description: 'the key, made a plain string',
    in: '@features/customers/domain/Key.shape.json',
    out: { type: 'string', from: 'stamped' },
    nodes: [
      {
        id: 'stamped',
        type: '@wilanis/node/run.schema.json',
        run: '@std/object.port.json#make',
        in: { value: '{{in.key}}', type: 'string' },
      },
    ],
  };
  docs['features/customers/edge/stamp.trigger.json'] = {
    $schema: schemaRef('trigger'),
    description: 'a stamp, every night at three',
    kind: KIND,
    settings: { cron: '0 3 * * *', timezone: 'UTC' },
    in: '@features/customers/edge/KeyView.shape.json',
    out: 'string',
    fire: { run: '@features/customers/domain/customer.port.json#stamp', in: { key: '{{context.scheduled}}' } },
  };
  return docs;
}

describe('the line a tick is logged as', () => {
  it("says the answer as the trigger's out marks it, and leaves the run's output the value", async () => {
    const digest = trigger({ cron: '0 3 * * *', timezone: 'UTC' });
    const served = serving([digest], () => ({ report: { output: { count: 2, token: 't-1' } } }));
    served.serving.types = () => ({ out: DIGEST });
    const fired = await fireTick(served.serving, digest, TICK);
    expect(fired.report?.output).toEqual({ count: 2, token: 't-1' });
    const line = lineOf('digest', TICK, fired);
    expect(line).toContain('{"count":2,"token":"«secret»"}');
    expect(line).not.toContain('t-1');
  });

  it("says the answer as the run's report shows it, where the trigger's out is a plain string", async () => {
    const dir = write(stamping());
    try {
      const load = loadTree(dir, PLUGINS);
      expect(checkTree(load).items).toEqual([]);
      const live = new Served({ load, emb: embedderFor(load) }, () => {}).serving();
      const stamp = live.triggers(KIND).find(one => live.pathOf(one) === STAMP);
      if (!stamp) throw new Error(`the tree has no ${STAMP}`);
      const fired = await fireTick(live, stamp, TICK);
      expect(fired.report?.status).toBe('done');
      expect(fired.report?.output).toBe(TICK.scheduled);
      expect(fired.answer).toBe('«secret»');
      // the tick's instant heads every line; what the run answered with it is the marker
      expect(lineOf('stamp', TICK, fired)).toMatch(/→ done \(\d+ms\) "«secret»"$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
