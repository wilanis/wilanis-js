/**
 * `@source`, a plugin the rehearse tests read their data through (#1027): one operation that answers a value of the
 * type it is handed and is not pure, as an HTTP call or a store read is. The rehearsal stubs an effect and runs every
 * other node, so a tree whose data a pure graph wrote out has nothing to steer: what it reads is a literal. A tree
 * that reads through `@source` is steered where a real tree is, at the effect.
 */
import { type PluginModule, schemaRef } from '@wilanis/core';
import { BUILTIN_PLUGINS } from '../src/index.js';
import { docsDir } from './example-harness.js';

/** The operation a tree reads its data through: `type` says what it answers; `target` is any key it is read by. */
export const SOURCE = '@source/source.port.json#read';

/** The plugin, granted as `@source`. */
export const source: PluginModule = {
  root: '@source',
  docs: docsDir({
    'plugin.json': { $schema: schemaRef('plugin'), description: 'd', grants: { ports: ['@source/source.port.json'] } },
    'source.port.json': {
      $schema: schemaRef('port'),
      description: 'd',
      operations: {
        read: {
          description: 'read a value of the type asked for',
          accepts: {
            type: { type: 'type', binds: '$T', description: 'what it answers' },
            target: { type: 'string', required: false, description: 'what it is read by' },
          },
          returns: '$T',
        },
      },
    },
  }),
  handlers: {
    [SOURCE]: async () => {
      throw new Error('@source answers only in a rehearsal, where it is stubbed');
    },
  },
};

/** The built-in plugins and `@source`: what a tree `treeOf` writes with `{ source: true }` is loaded with. */
export const SOURCED: Record<string, PluginModule> = { ...BUILTIN_PLUGINS, '@source': source };
