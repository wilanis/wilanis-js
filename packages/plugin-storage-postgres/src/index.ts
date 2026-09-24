/**
 * @wilanis/plugin-storage-postgres, the @storage-postgres engine: an @storage store kept in PostgreSQL. It
 * grants one connection kind and no port -- what may be asked of a store is @storage's business -- and it is a
 * package of its own because every engine is a plugin, and the second engine obeying that is what keeps the
 * claim honest rather than decorative.
 *
 * It registers itself from `postLoad`, opening nothing, twice: as @storage's engine for the kind it grants, and
 * as the lease keeper @schedule holds a tick through (RFC 0010). The first operation against a connection makes
 * its pool. The teardown destroys every pool it made, so a reload leaves no socket behind.
 */
import { fileURLToPath } from 'node:url';
import type { PluginModule } from '@wilanis/core';
import { engines, leases } from '@wilanis/plugin-storage';
import { PostgresEngine } from './engine.js';
import { TableLeases } from './leases.js';
import { closePools, type Settings } from './pool.js';
import { check } from './rules.js';

export { PostgresEngine } from './engine.js';
export { TableLeases } from './leases.js';
export type { Settings } from './pool.js';

const ROOT = '@storage-postgres';
const KIND = `${ROOT}/postgres.connection-kind.json`;

const plugin: PluginModule = {
  root: ROOT,
  docs: fileURLToPath(new URL('../docs', import.meta.url)),
  handlers: {},
  check,
  async postLoad(ctx) {
    const kind = ctx.scope.canon(KIND);
    engines(ctx.env).register(kind, new PostgresEngine(ctx.settings as Settings));
    leases(ctx.env).register(kind, new TableLeases(ctx.env, ctx.settings as Settings));
    return closePools;
  },
};
export default plugin;
