/**
 * The queue is worked by processes of its own (RFC 0009, step 11). The example's instances behind the load
 * balancer run `production`, whose startup opens the port and consumes nothing; the processes under
 * `production-worker` consume the removals queue and open no port; on the laptop one process does both, since
 * the in-process broker keeps a queue in the process whose route published to it. What each profile starts is
 * read off the one list in `project.json`, without a database behind any of them.
 */
import { loadTree } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { EXAMPLE, INCLUDES, PLUGINS } from './example-harness.js';
import { profileBlock, startedUnder } from './roles-harness.js';

const LISTEN = '@http/server.port.json#listen';
const CONSUME = '@queue/worker.port.json#consume';
const SCHEDULE = '@schedule/scheduler.port.json#run';
const QUEUES = '@customers/domain/jobs.port.json#prepare';
const MEMORY = '@features/state/domain/memory.port.json#prepare';
const example = loadTree(EXAMPLE, PLUGINS, INCLUDES);

/** What the profile's startup names, in the order it runs. */
const started = async (profile: string) => (await startedUnder(example, profile)).map(step => step.run);

describe('a process that only works the queue', () => {
  it('under production-worker, consumes, and neither listens nor schedules', async () => {
    const ran = await started('production-worker');
    expect(ran).toContain(CONSUME);
    expect(ran).not.toContain(LISTEN);
    expect(ran).not.toContain(SCHEDULE);
  });

  it('under production-worker, prepares the queue and the guard memory, since it may start first', async () => {
    const ran = await started('production-worker');
    expect(ran.indexOf(QUEUES)).toBeLessThan(ran.indexOf(CONSUME));
    expect(ran.indexOf(MEMORY)).toBeLessThan(ran.indexOf(CONSUME));
  });

  it('under production and production-scheduler, consumes nothing', async () => {
    const production = await started('production');
    expect(production).toContain(LISTEN);
    expect(production).not.toContain(CONSUME);
    expect(await started('production-scheduler')).not.toContain(CONSUME);
  });

  it('on the laptop, the process that listens is the one that consumes, and it consumes before it listens', async () => {
    for (const profile of ['live', 'local']) {
      const ran = await started(profile);
      expect(ran.indexOf(CONSUME)).toBeGreaterThan(-1);
      expect(ran.indexOf(CONSUME)).toBeLessThan(ran.indexOf(LISTEN));
    }
  });

  it('is what describe project.json prints per profile', () => {
    const block = (profile: string) => profileBlock(example, profile);
    expect(block('production')).not.toContain(CONSUME);
    expect(block('production-worker')).toContain(CONSUME);
    expect(block('production-worker')).not.toContain(LISTEN);
    expect(block('production-worker')).toMatch(/\n {2}starts {5}.*Work the queues/);
  });
});
