/**
 * @wilanis/plugin-storage-mysql, the @storage-mysql engine: an @storage store kept in MySQL. It grants one
 * connection kind and no port -- what may be asked of a store is @storage's business -- and it is a package of
 * its own because every engine is a plugin, and a driver is a cost only the trees that name it should pay.
 *
 * Before it registers, `postLoad` asks each server a connection of the kind reaches for `SELECT VERSION()`, on
 * a connection closed at once, and fails the start on one older than MySQL 8.0.16, which the kind's
 * `capabilities` assume (RFC 0022). It opens no pool: the first operation against a connection makes its pool.
 * The teardown destroys every pool it made, so a reload leaves no socket behind.
 */
import { fileURLToPath } from 'node:url';
import type { PluginModule, PostLoadContext } from '@wilanis/core';
import { engines } from '@wilanis/plugin-storage';
import { MysqlEngine } from './engine.js';
import { Pools } from './pools.js';
import type { Settings } from './settings.js';
import { holdVersions } from './version.js';

export { MysqlEngine } from './engine.js';
export { POOL_MAX, Pools } from './pools.js';
export type { Settings } from './settings.js';
export { REQUIRED } from './version.js';

const ROOT = '@storage-mysql';
const KIND = `${ROOT}/mysql.connection-kind.json`;

/** The engine one load of a tree registers, and the teardown that destroys the pools it made. */
export function makeMysqlEngine(ctx: Pick<PostLoadContext, 'settings'>): {
  engine: MysqlEngine;
  close: () => Promise<void>;
} {
  const settings = ctx.settings as Settings;
  const pools = new Pools(settings);
  return { engine: new MysqlEngine(pools, settings), close: () => pools.close() };
}

const plugin: PluginModule = {
  root: ROOT,
  docs: fileURLToPath(new URL('../docs', import.meta.url)),
  handlers: {},
  async postLoad(ctx) {
    const kind = ctx.scope.canon(KIND);
    await holdVersions(ctx.env, kind, KIND);
    const { engine, close } = makeMysqlEngine(ctx);
    engines(ctx.env).register(kind, engine);
    return close;
  },
};
export default plugin;
