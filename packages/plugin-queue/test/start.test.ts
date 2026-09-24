/**
 * The whole path, against the real runtime: a tree whose startup list names the consume step, a command line
 * that publishes through a data graph, and the fake broker the tree's connection kind registers. What is
 * pinned here is that the pieces meet -- `publish` reaches the broker through the connection, the runtime holds
 * the consumer and stops it, a message fires the trigger's operation through the embedder, and the graph's
 * refusals become outcomes -- while every outcome's detail is `worker.test.ts`'s.
 */
import { rmSync } from 'node:fs';
import { loadTree } from '@wilanis/core';
import { runTrigger, start } from '@wilanis/runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeBroker } from './fake-broker.js';
import { until } from './harness.js';
import { JOBS, pluginsWith, tree, written } from './tree.js';

const ENQUEUE = '@features/customers/edge/enqueue.trigger.json';

let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('a tree that works its queues', () => {
  it('publishes from a graph, consumes through the trigger, and maps every ending to an outcome', async () => {
    dir = written(tree());
    const broker = new FakeBroker();
    const plugins = pluginsWith(broker);
    const logs: string[] = [];
    const served = await start(loadTree(dir, plugins), { log: line => logs.push(line) });
    try {
      expect(logs).toContain(
        `queue: consuming removals on ${JOBS} → @features/customers/domain/customer.port.json#remove`,
      );
      for (const id of ['golf', 'missing', 'broken']) {
        const { answer } = await runTrigger(loadTree(dir, plugins), ENQUEUE, { flags: { id } }, { log: () => {} });
        expect(answer).toMatchObject({ id: expect.stringMatching(/^m\d+$/) });
      }
      // golf answers, missing is acknowledged, broken is retried twice and dead on the third of maxAttempts 3
      expect(await until(() => broker.answers.length === 5)).toBe(true);
      const outcomes = broker.answers.map(one => `${one.id}:${one.attempt}:${one.outcome}`);
      expect(outcomes.slice(0, 2)).toEqual(['m1:1:ack', 'm2:1:ack']);
      expect(outcomes.slice(2)).toEqual(['m3:1:retry', 'm3:2:retry', 'm3:3:dead']);
      expect(broker.parked(JOBS, 'removals')).toEqual([{ id: 'm3', body: { id: 'broken' } }]);
      expect(broker.waiting(JOBS, 'removals')).toEqual([]);
      expect(logs.some(line => /^queue removals m1 attempt 1 → ack \(\d+ms, .*#remove done\)$/.test(line))).toBe(true);
      expect(logs.some(line => line.includes('m3 attempt 3 → dead') && line.includes('refused upstream'))).toBe(true);
    } finally {
      await served.stop();
    }
  }, 10_000);

  it('a message whose input does not conform is dead and fires nothing', async () => {
    dir = written(tree());
    const broker = new FakeBroker();
    const logs: string[] = [];
    const served = await start(loadTree(dir, pluginsWith(broker)), { log: line => logs.push(line) });
    try {
      await broker.publish(JOBS, 'removals', { body: { id: 7 }, headers: {} });
      expect(await until(() => broker.answers.length === 1)).toBe(true);
      expect(broker.answers[0].outcome).toBe('dead');
      expect(logs.some(line => line.includes('→ dead') && line.includes('input does not conform'))).toBe(true);
    } finally {
      await served.stop();
    }
  }, 10_000);

  it('a connection whose kind no broker registered stops the start, naming the connection and the kind', async () => {
    dir = written(tree());
    await expect(start(loadTree(dir, pluginsWith('none')), { log: () => {} })).rejects.toThrow(
      `no broker for connection '${JOBS}', of kind '@fake-broker/fake.connection-kind.json'`,
    );
  });
});
