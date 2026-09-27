/**
 * The scenarios the example keeps (RFC 0018, step 9): `scenarios/rehearsed/` is what `wilanis rehearse --record`
 * writes for the tree as it stands and `scenarios/edges/` what `wilanis fuzz --edges` writes, byte for byte, and
 * `wilanis regress` replays every one as the same. The committed directories are judged where they are, not on a
 * copy, so a change to the example that moves a branch fails here until `--record` rewrites them and the diff goes
 * into the commit. Beside tools.test.ts, which is at the house rules' length.
 */
import { loadTree } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { checkScenarios, EDGES, RECORDED, regress } from '../src/index.js';
import { EXAMPLE, INCLUDES, PLUGINS } from './example-harness.js';

const load = () => loadTree(EXAMPLE, PLUGINS, INCLUDES);
const CURRENT = { stale: [], missing: [], extra: [] };

describe("the example's committed scenarios", () => {
  it('are what rehearse --record and fuzz --edges write for the tree today', { timeout: 120_000 }, async () => {
    const checked = await checkScenarios(load());
    expect(checked.ok, checked.lines.join('\n')).toBe(true);
    expect(checked.rehearsal.recorded).toMatchObject({ dir: RECORDED, check: CURRENT, kept: [] });
    expect(checked.edges.recorded).toMatchObject({ dir: EDGES, check: CURRENT, kept: [] });
    expect(checked.rehearsal.recorded?.files).toBeGreaterThan(0);
    expect(checked.edges.recorded?.files).toBeGreaterThan(0);
  });

  it('replay the same, every one', { timeout: 120_000 }, async () => {
    const tree = load();
    const replayed = await regress(tree);
    expect(replayed.ok, replayed.lines.join('\n')).toBe(true);
    expect(replayed.results).toHaveLength(tree.registry.all('scenario').length);
    expect(replayed.results.filter(one => !one.same)).toEqual([]);
  });
});
