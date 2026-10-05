/**
 * @wilanis/plugin-storage-sqlite, the @storage-sqlite engine: an @storage store kept in one SQLite file. It
 * grants one connection kind and no port -- what may be asked of a store is @storage's business -- and it is a
 * package of its own because every engine is a plugin, and the one with a native driver is the one that most
 * needs to cost nothing to the trees that do not name it.
 *
 * It registers itself from `postLoad`, opening nothing: the first operation against a connection opens its
 * file. The teardown closes every handle it opened, so a reload leaves no file held.
 */
import { fileURLToPath } from 'node:url';
import type { PluginModule, PostLoadContext } from '@wilanis/core';
import { engines } from '@wilanis/plugin-storage';
import { SqliteEngine } from './engine.js';
import { Handles } from './handles.js';
import { check } from './rules.js';
import type { Settings } from './settings.js';

export { SqliteEngine } from './engine.js';
export { Handles } from './handles.js';
export { BUSY_TIMEOUT_MS, type Settings } from './settings.js';

const ROOT = '@storage-sqlite';
const KIND = `${ROOT}/sqlite.connection-kind.json`;

/**
 * The engine one load of a tree registers, and the teardown that closes what it opened. Relative files are
 * read against the tree's root, so a tree copied elsewhere carries its database with it.
 */
export function makeSqliteEngine(ctx: Pick<PostLoadContext, 'root' | 'settings'>): {
  engine: SqliteEngine;
  close: () => Promise<void>;
} {
  const settings = ctx.settings as Settings;
  const handles = new Handles(ctx.root, settings);
  return { engine: new SqliteEngine(handles, settings), close: () => handles.close() };
}

const plugin: PluginModule = {
  root: ROOT,
  docs: fileURLToPath(new URL('../docs', import.meta.url)),
  handlers: {},
  check,
  async postLoad(ctx) {
    const { engine, close } = makeSqliteEngine(ctx);
    engines(ctx.env).register(ctx.scope.canon(KIND), engine);
    return close;
  },
};
export default plugin;
