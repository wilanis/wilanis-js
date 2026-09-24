/**
 * One process schedules and the others only listen (RFC 0010, step 7). The example runs its instances behind
 * the load balancer under `production`, whose startup opens the port and names no scheduler, and one process
 * under `production-scheduler`, whose startup keeps the schedule on its lease and opens no port. The steps are
 * run through `runStartup` over an embedder that records what each step names and answers it, so what a
 * profile starts is read off the one list in `project.json`, without a database behind either.
 */
import { loadTree } from '@wilanis/core';
import type { Report } from '@wilanis/engine';
import { describe, expect, it } from 'vitest';
import { describe as describeDoc, type Embedder, runStartup } from '../src/index.js';
import { EXAMPLE, INCLUDES, PLUGINS } from './example-harness.js';

const LISTEN = '@http/server.port.json#listen';
const SCHEDULE = '@schedule/scheduler.port.json#run';
const LEASE = '@connections/customers-postgres.connection.json';
const example = loadTree(EXAMPLE, PLUGINS, INCLUDES);

/** What each startup step the profile runs names, and its `in`, in the order `runStartup` ran them. */
async function started(profile: string) {
  const ran: { run: string; in?: Record<string, unknown> }[] = [];
  const answered: Report = { graph: 'g', status: 'done', nodes: {}, startedAt: 0, endedAt: 1 };
  const emb = {
    startup: async (step: { run: string; in?: Record<string, unknown> }) => {
      ran.push({ run: step.run, ...(step.in ? { in: step.in } : {}) });
      return answered;
    },
  };
  await runStartup(example, emb as unknown as Embedder, () => {}, profile);
  return ran;
}

describe('a process that runs only the schedule', () => {
  it('under production-scheduler, keeps the schedule on its lease and opens no port', async () => {
    const ran = await started('production-scheduler');
    expect(ran.filter(step => step.run === SCHEDULE)).toEqual([{ run: SCHEDULE, in: { lease: LEASE } }]);
    expect(ran.map(step => step.run)).not.toContain(LISTEN);
  });

  it('under production, listens and schedules nothing', async () => {
    const ran = (await started('production')).map(step => step.run);
    expect(ran).toContain(LISTEN);
    expect(ran).not.toContain(SCHEDULE);
  });

  it('on the laptop, one process does both', async () => {
    for (const profile of ['live', 'local']) {
      const ran = (await started(profile)).map(step => step.run);
      expect(ran).toContain(LISTEN);
      expect(ran).toContain(SCHEDULE);
    }
  });

  it('is what describe project.json prints per profile: what each holds and starts', () => {
    const said = describeDoc(example, 'project.json').split('\n');
    // one profile's block, from its heading to the blank line before the next
    const block = (profile: string) => {
      const start = said.findIndex(line => line.startsWith(`profile ${profile}  `));
      const end = said.indexOf('', start);
      return said.slice(start, end < 0 ? undefined : end).join('\n');
    };
    expect(block('production')).toContain(LISTEN);
    expect(block('production')).not.toContain(SCHEDULE);
    expect(block('production-scheduler')).toContain(SCHEDULE);
    expect(block('production-scheduler')).not.toContain(LISTEN);
    expect(block('production-scheduler')).toMatch(/\n {2}starts {5}.*Keep the schedule in one process/);
  });
});
