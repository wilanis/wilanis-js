/**
 * What a process of the example starts under each profile, read two ways: the startup steps `runStartup` runs,
 * over an embedder that records each and answers it, so no database stands behind any profile; and the block
 * `wilanis describe project.json` prints for the profile. The tests of the processes the example splits its
 * production into -- the one that schedules, the ones that work the queue -- ask both.
 */
import type { LoadResult } from '@wilanis/core';
import type { Report } from '@wilanis/engine';
import { describe as describeDoc, type Embedder, runStartup } from '../src/index.js';

/** One startup step as it ran: what it names and, where it gives one, its `in`. */
export interface Ran {
  run: string;
  in?: Record<string, unknown>;
}

/** What each startup step the profile runs names, and its `in`, in the order `runStartup` ran them. */
export async function startedUnder(load: LoadResult, profile: string): Promise<Ran[]> {
  const ran: Ran[] = [];
  const answered: Report = { graph: 'g', status: 'done', nodes: {}, startedAt: 0, endedAt: 1 };
  const emb = {
    startup: async (step: Ran) => {
      ran.push({ run: step.run, ...(step.in ? { in: step.in } : {}) });
      return answered;
    },
  };
  await runStartup(load, emb as unknown as Embedder, () => {}, profile);
  return ran;
}

/** The block `describe project.json` prints for one profile, from its heading to the blank line before the next. */
export function profileBlock(load: LoadResult, profile: string): string {
  const said = describeDoc(load, 'project.json').split('\n');
  const start = said.findIndex(line => line.startsWith(`profile ${profile}  `));
  const end = said.indexOf('', start);
  return said.slice(start, end < 0 ? undefined : end).join('\n');
}
