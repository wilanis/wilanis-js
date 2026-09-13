/** What a tree's plugins set up when it is loaded, and the way to undo it. */
import type { LoadResult } from '@wilanis/core';
import type { Embedder } from './embed.js';

/**
 * Run every plugin's postLoad hook in project.json order; answers a teardown that runs theirs in reverse.
 * Where one throws, what already ran is undone before the throw is passed on, so a load that does not finish
 * holds nothing. It runs once per load, not once per process: a reload runs it again for the new tree.
 */
export async function postLoad(
  load: LoadResult,
  emb: Embedder,
  log: (line: string) => void,
): Promise<() => Promise<void>> {
  const downs: (() => Promise<void>)[] = [];
  const teardown = async () => {
    for (const down of [...downs].reverse()) await down();
  };
  try {
    for (const plugin of load.plugins) {
      if (!plugin.postLoad) continue;
      const settings = (emb.env.plugins as Record<string, Record<string, unknown>>)[plugin.root] ?? {};
      const down = await plugin.postLoad({
        root: load.root,
        registry: load.registry,
        scope: emb.scope,
        settings,
        env: emb.env,
        log,
      });
      if (down) downs.push(down);
    }
  } catch (error) {
    await teardown();
    throw error;
  }
  return teardown;
}
