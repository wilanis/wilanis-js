/**
 * @wilanis/plugin-queue-memory, the @queue-memory broker: @queue's queues kept in arrays for as long as the
 * process lives. It grants one connection kind and no port -- what may be asked of a queue is @queue's
 * business -- and it is a package of its own rather than an entry point of @queue, because "every broker is a
 * plugin" is the design and the first broker obeying it is what keeps that claim honest.
 *
 * It registers itself from `postLoad`, the hook whose meaning is "the tree is loaded and judged", which is
 * exactly when a broker may exist. It consumes nothing on its own -- the worker a startup step names does -- so
 * it holds nothing to tear down.
 */
import { fileURLToPath } from 'node:url';
import type { PluginModule } from '@wilanis/core';
import { brokers } from '@wilanis/plugin-queue';
import { MemoryBroker } from './broker.js';

export { MemoryBroker } from './broker.js';
export type { Parked } from './queue.js';

const ROOT = '@queue-memory';
/** The connection kind this plugin grants, and registers its broker under. */
export const KIND = `${ROOT}/memory.connection-kind.json`;

const plugin: PluginModule = {
  root: ROOT,
  docs: fileURLToPath(new URL('../docs', import.meta.url)),
  handlers: {},
  // no rules: the kind has no settings to judge, and what a queue trigger may say is @queue's to judge
  async postLoad(ctx) {
    brokers(ctx.env).register(ctx.scope.canon(KIND), new MemoryBroker());
  },
};
export default plugin;
