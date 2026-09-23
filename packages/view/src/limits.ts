/**
 * What a page is told about a map's fan-out (RFC 0012): the most elements it runs over and how many run at once,
 * each copied as written and only where it is written, so a map that runs every element at once over a list of
 * any length carries nothing and a page draws no mark for it. A trigger's bounds are resolved by the runtime's
 * `limitsOf`, which `describe` says them from, so the page and the command read one answer.
 */
import type { MapNode } from '@wilanis/core';

/** What one map declares about its fan-out: its ceiling and its pace, each only where it is written. */
export interface VFanOut {
  limit?: number;
  concurrency?: number;
}

/** The ceiling and the pace one map declares, and nothing where it declares neither. */
export const fanOutOf = (node: Pick<MapNode, 'limit' | 'concurrency'>): VFanOut => ({
  ...(node.limit !== undefined ? { limit: node.limit } : {}),
  ...(node.concurrency !== undefined ? { concurrency: node.concurrency } : {}),
});
