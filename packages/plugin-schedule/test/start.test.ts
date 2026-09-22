/**
 * The whole thing, once, against the real runtime and the real clock: a tree whose startup list names the
 * `run` step and whose one scheduled trigger fires every second. This is the one test here that waits on
 * time, and it waits on one second of it -- everything about *when* is pinned by the fake clock in
 * `scheduler.test.ts`, and what is pinned here is that the runtime holds the schedule and stops it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadTree } from '@wilanis/core';
import { start } from '@wilanis/runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { type Docs, PLUGINS, tree } from './tree.js';

let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** The small tree on disk, with its schedule set to fire every second and no lease to hold a tick on. */
function written(): string {
  const docs: Docs = tree();
  (docs['features/customers/edge/digest.trigger.json'] as any).settings = { everyMs: 1000 };
  (docs['project.json'] as any).startup[0].in = undefined;
  const at = mkdtempSync(join(tmpdir(), 'wilanis-schedule-start-'));
  for (const [relative, doc] of Object.entries(docs)) {
    const path = join(at, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(doc));
  }
  return at;
}

/**
 * The same tree, with the digest graph answering a shape the trigger's `out` does not accept, so the run is
 * judged against `out` after the operation has answered and fails there.
 */
function writtenAnsweringWrongly(): string {
  const docs: Docs = tree();
  (docs['features/customers/edge/digest.trigger.json'] as Record<string, unknown>).settings = { everyMs: 1000 };
  ((docs['project.json'] as Record<string, unknown>).startup as Record<string, unknown>[])[0].in = undefined;
  // the trigger's out says count is a number; the graph is made to answer a string instead
  const graph = docs['features/customers/data/count.graph.json'] as Record<string, unknown>;
  const nodes = graph.nodes as Record<string, unknown>[];
  (nodes[0].in as Record<string, unknown>).value = { count: 'not a number' };
  const at = mkdtempSync(join(tmpdir(), 'wilanis-schedule-judged-'));
  for (const [relative, doc] of Object.entries(docs)) {
    const path = join(at, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(doc));
  }
  return at;
}

/** Wait for a condition the schedule settles into, rather than a fixed sleep. */
async function until(ok: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise(done => setTimeout(done, 20));
  return ok();
}

describe('a tree that asks to be scheduled', () => {
  it('fires its trigger within two seconds, logs the tick, and stops when told', async () => {
    dir = written();
    const logs: string[] = [];
    const served = await start(loadTree(dir, PLUGINS), { log: line => logs.push(line) });
    try {
      expect(logs.some(line => line.startsWith('schedule: 1 trigger(s)'))).toBe(true);
      const fired = await until(() => logs.some(line => line.includes('→ done')));
      expect(fired).toBe(true);
      const line = logs.find(one => one.includes('→ done')) as string;
      // a schedule is named by the canonical path of the trigger that declares it, through Serving.pathOf
      expect(line).toMatch(/^schedule @features\/customers\/edge\/digest\.trigger\.json /);
      expect(line).toMatch(/\dZ → done \(\d+ms\)/);
    } finally {
      await served.stop();
    }
    // nothing fires after the stop: the log stands still
    const after = logs.length;
    await new Promise(done => setTimeout(done, 1200));
    expect(logs).toHaveLength(after);
  }, 10_000);

  it('an answer is judged against the trigger out, and a run that answers otherwise is logged as failed', async () => {
    dir = writtenAnsweringWrongly();
    const logs: string[] = [];
    const served = await start(loadTree(dir, PLUGINS), { log: line => logs.push(line) });
    try {
      // nobody is called to answer, so the tick's line is where the judgement shows
      const judged = await until(() => logs.some(line => line.includes('→ failed')));
      expect(judged).toBe(true);
      const line = logs.find(one => one.includes('→ failed')) as string;
      expect(line).toMatch(/^schedule @features\/customers\/edge\/digest\.trigger\.json /);
      expect(line).toMatch(/→ failed \(\d+ms\)$/);
      expect(logs.some(one => one.includes('→ done'))).toBe(false); // it never counted as done
    } finally {
      await served.stop();
    }
  }, 10_000);

  it('a tree that names no run step schedules nothing, however many scheduled triggers it has', async () => {
    const docs: Docs = tree();
    (docs['features/customers/edge/digest.trigger.json'] as any).settings = { everyMs: 1000 };
    (docs['project.json'] as any).startup = [];
    dir = mkdtempSync(join(tmpdir(), 'wilanis-schedule-none-'));
    for (const [relative, doc] of Object.entries(docs)) {
      const path = join(dir, relative);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(doc));
    }
    const logs: string[] = [];
    const served = await start(loadTree(dir, PLUGINS), { log: line => logs.push(line) });
    try {
      await new Promise(done => setTimeout(done, 1500));
      expect(logs.some(line => line.includes('→ done'))).toBe(false);
    } finally {
      await served.stop();
    }
  }, 10_000);
});
