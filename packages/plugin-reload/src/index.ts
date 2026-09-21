/**
 * @wilanis/plugin-reload, the @reload plugin: watch the tree and serve it again when it changes.
 *
 * The plugin decides only *when* to reload. Loading the tree and judging it belong to the runtime, and reach
 * this handler as `serving.reload()` -- a plugin never imports the compiler or the runtime.
 */
import { type FSWatcher, watch } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HOME, type Hold, type PluginModule, type Serving } from '@wilanis/core';
import type { Handler } from '@wilanis/engine';

const ROOT = '@reload';
const DOCS = fileURLToPath(new URL('../docs', import.meta.url));
/** The path of a document this plugin ships. */
const shipped = (name: string) => `${ROOT}/${name}`;
const DEFAULT_DEBOUNCE = 120;

/**
 * The directories a write under is never an edit of the tree, in the one place the watcher decides it: the tree's
 * own working state (`.wilanis/`, where the @auth files store keeps its sessions -- a sign-in must not reload the
 * tree and empty every memory engine), what `wilanis fuzz` records (`scenarios/`), and what nobody edits by hand
 * (`node_modules/`, `dist/`, `.git/`). Wherever one of these appears in a path, what is under it is left alone.
 */
const IGNORED_DIRS = ['.wilanis', HOME.scenario?.dir ?? 'scenarios', 'node_modules', 'dist', '.git'];
const escaped = (dir: string) => dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const IGNORED = new RegExp(`(^|[\\\\/])(${IGNORED_DIRS.map(escaped).join('|')})([\\\\/]|$)`);

/**
 * Watch the tree and serve it again when a document changes. Answers once the watcher is up; the watching
 * itself outlives the run, so the runtime holds it and closes it when the process stops.
 */
const watchTree: Handler = async ({ in: input, ctx }) => {
  const env = ctx.env as { serving?: Serving; hold?: Hold; plugins?: Record<string, Record<string, unknown>> };
  const serving = env.serving;
  if (!serving || !env.hold)
    throw new Error(
      `'${shipped('watch.port.json')}#watch' watches the tree while it is served, so it runs from a project's startup list -- not from a graph`,
    );
  const settings = env.plugins?.[ROOT] ?? {};
  const wait = Number(input.debounceMs ?? settings.debounceMs ?? DEFAULT_DEBOUNCE);
  const { root, log } = serving;

  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let again = false;

  const reload = async () => {
    if (running) {
      again = true;
      return;
    } // an edit during a reload is answered by the next one
    running = true;
    try {
      const result = await serving.reload();
      if (result.ok) log(`reload: ${result.documents} documents, serving the new tree`);
      else log(`reload refused, still serving the last good tree:\n${result.refusals}`);
    } catch (error) {
      log(`reload failed, still serving the last good tree: ${(error as Error).message}`);
    } finally {
      running = false;
      if (again) {
        again = false;
        void reload();
      }
    }
  };

  const watcher: FSWatcher = watch(root, { recursive: true }, (_event, name) => {
    if (name && (IGNORED.test(name) || !name.endsWith('.json'))) return; // only documents matter
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void reload();
    }, wait);
  });

  log(`reload: watching ${root} -- an edit is served once it passes wilanis check`);
  env.hold({
    label: `reload ${root}`,
    stop: async () => {
      if (timer) clearTimeout(timer);
      watcher.close();
    },
  });
  return { watching: root };
};

const reload: PluginModule = {
  root: ROOT,
  docs: DOCS,
  handlers: { [`${shipped('watch.port.json')}#watch`]: watchTree },
};

export default reload;
