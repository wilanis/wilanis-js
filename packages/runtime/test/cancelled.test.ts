import type { LoadResult } from '@wilanis/core';
import type { Report } from '@wilanis/engine';
import { describe, expect, it } from 'vitest';
import type { Embedder } from '../src/index.js';
import { runStartup, statusOf } from '../src/index.js';

/** A run whose signal aborted: the node in flight failed as it was told to stop, and nothing answered. */
const cancelled: Report = {
  graph: 'g',
  status: 'cancelled',
  nodes: { asked: { status: 'failed', error: 'This operation was aborted' }, after: { status: 'cancelled' } },
  startedAt: 0,
  endedAt: 1,
};

describe('a cancelled run, where the runtime reads how a run ended', () => {
  it('is said cancelled on its span, not failed', () => {
    expect(statusOf(cancelled)).toBe('cancelled');
  });
  it('is a startup step that did not answer: it stops serving, and says cancelled', async () => {
    const load = { registry: { project: { doc: { startup: [{ run: 'p.port.json#open', label: 'boot' }] } } } };
    const emb = { startup: async () => cancelled };
    const lines: string[] = [];
    const started = runStartup(load as unknown as LoadResult, emb as unknown as Embedder, line => lines.push(line));
    await expect(started).rejects.toThrow('startup step 1/1 boot: cancelled; nothing is serving');
    expect(lines).toEqual([]);
  });
});
