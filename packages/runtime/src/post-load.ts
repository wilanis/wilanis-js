/** What a tree's plugins set up when it is loaded, and the way to undo it. */
import type { LoadResult } from '@wilanis/core';
import type { Embedder } from './embed.js';

/** One thing to stop, and the name it is logged by when it will not stop; one with no label logs for itself. */
export interface Teardown {
  label?: string;
  stop: () => Promise<unknown>;
}

/**
 * Stop every one of them in the order given, whatever the one before threw: a teardown that throws is logged
 * and the ones after it still run, so one stuck connection never leaves the rest held. Answers once all have
 * run, and throws the first error, so a caller still learns that something did not stop.
 */
export async function stopEach(teardowns: Teardown[], log: (line: string) => void): Promise<void> {
  const errors: unknown[] = [];
  for (const one of teardowns)
    try {
      await one.stop();
    } catch (error) {
      errors.push(error);
      if (one.label !== undefined) log(`stopping ${one.label}: ${(error as Error).message}`);
    }
  if (errors.length) throw errors[0];
}

/**
 * Run every plugin's postLoad hook in project.json order; answers a teardown that runs theirs in reverse.
 * Where one throws, what already ran is undone before the throw is passed on, named for the plugin that threw,
 * so a load that does not finish holds nothing. It runs once per load, not once per process: a reload runs it
 * again for the new tree.
 */
export async function postLoad(
  load: LoadResult,
  emb: Embedder,
  log: (line: string) => void,
): Promise<() => Promise<void>> {
  const downs: Teardown[] = [];
  const teardown = () => stopEach([...downs].reverse(), log);
  for (const plugin of load.plugins) {
    if (!plugin.postLoad) continue;
    const settings = (emb.env.plugins as Record<string, Record<string, unknown>>)[plugin.root] ?? {};
    try {
      const down = await plugin.postLoad({
        root: load.root,
        registry: load.registry,
        scope: emb.scope,
        settings,
        env: emb.env,
        log,
      });
      if (down) downs.push({ label: `plugin '${plugin.root}'`, stop: down });
    } catch (error) {
      await teardown().catch(() => undefined);
      throw new Error(`plugin '${plugin.root}' postLoad: ${(error as Error).message}`, { cause: error });
    }
  }
  return teardown;
}
