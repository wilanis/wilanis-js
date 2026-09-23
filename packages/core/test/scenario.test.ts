/** The scenario schema beyond its baseline: what a recorded node may pin (RFC 0014). */
import { describe, expect, it } from 'vitest';
import { at, doc, refused } from './documents.js';

const recorded = (nodes: Record<string, unknown>) => doc('scenario', { expect: { status: 'failed', nodes } });

describe('a scenario node', () => {
  it('may pin the reason it refused with, on the refusing node and on the call that ran its graph', () => {
    const nodes = {
      op: { status: 'failed', reason: 'missing' },
      'op.missing': { status: 'failed', reason: 'missing' },
    };
    expect(refused(recorded(nodes))).toEqual([]);
  });

  it('pins a reason as a word, never another value', () => {
    expect(refused(recorded({ op: { status: 'failed', reason: 404 } }))).toEqual([
      at('expect/nodes/op/reason', 'must be string'),
    ]);
  });
});
