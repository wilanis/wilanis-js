/**
 * The tree of `tree.ts` with a gate in front of its queue: it includes the access tree (`@wilanis/access`), binds
 * that tree's identity port and the guard's memory to the directories the access tree writes for development
 * (its fake directory: bo holds `registrar`, cy only `viewer`, ana is a customer), configures `@auth` as the
 * access tree does, and attaches the two policies the RFC's example attaches, the token read from the message's
 * headers. Nothing of the access tree is edited: its documents are read from the package and written where a
 * host would keep them, as the example's `features/directories` does.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { loadTree, type PluginModule, type ResolvedInclude } from '@wilanis/core';
import auth from '@wilanis/plugin-auth';
import http from '@wilanis/plugin-http';
import type { FakeBroker } from './fake-broker.js';
import { type Docs, pluginsWith, TRIGGER, tree } from './tree.js';

/** Where the access tree sits, as the runtime would resolve it from a host's node_modules. */
const ACCESS = dirname(createRequire(import.meta.url).resolve('@wilanis/access/package.json'));

/** The tree the host includes, handed to the loader since a copy in a temporary directory has no node_modules. */
export const INCLUDES: ResolvedInclude[] = [{ from: '@wilanis/access', dir: ACCESS, features: ['access'] }];

/** The secret the guard signs and verifies tokens with, set in the environment the project's secrets name. */
export const SECRET = 'secret-secret-secret-secret-secret-1';

/** The two policies the trigger attaches, by the paths the include gives them. */
export const EMPLOYEES_ONLY = '@access/edge/employees-only.policy.json';
export const CAN_REGISTER = '@access/edge/can-register.policy.json';

/** The operation the queue trigger fires, as its trace span names it. */
export const REMOVE = '@features/customers/domain/customer.port.json#remove';

/** One document of the access tree, as the package ships it. */
const accessDoc = (relative: string): any => JSON.parse(readFileSync(join(ACCESS, relative), 'utf8'));

/** The access tree's own configuration of a plugin, which a host copies. */
const accessPlugin = (use: string) => accessDoc('project.json').plugins.find((plugin: any) => plugin.use === use);

/** The project, including the access tree and configuring the two plugins it needs. */
function project(docs: Docs): Record<string, unknown> {
  const doc = docs['project.json'] as any;
  return {
    ...doc,
    includes: [{ from: '@wilanis/access', features: ['access'] }],
    plugins: [...doc.plugins, accessPlugin('@http'), accessPlugin('@auth')],
    secrets: { jwt: 'CUSTOMERS_JWT_SECRET' },
  };
}

/** The host's feature binding identity.port.json and @auth/state.port.json to the access tree's fake directory. */
function directories(): Docs {
  const feature = accessDoc('features/access-dev/feature.json');
  return {
    'connections/employees.connection.json': accessDoc('connections/employees.connection.json'),
    'connections/customers.connection.json': accessDoc('connections/customers.connection.json'),
    'features/directories/feature.json': {
      ...feature,
      label: 'Directories',
      description: "the access tree's identity port and the guard's memory, met by the directories in connections/",
    },
    'features/directories/data/identity.binding.json': accessDoc('features/access-dev/data/identity.binding.json'),
    'features/directories/data/state.binding.json': accessDoc('features/access-dev/data/state.binding.json'),
  };
}

/** What a gated trigger maps each reason to: the RFC's table, where a message whose caller the gate refused is parked. */
export const PARKED = { anonymous: 'dead', invalid_credential: 'dead', forbidden: 'dead' };

/**
 * The queue tree with the gate: the trigger attaches `employees-only` (given the token from the message's
 * headers) and `can-register`, and maps the gate's reasons as `outcomes` says beside the graph's own.
 */
export function gated(outcomes: Record<string, string> = PARKED, settings: Record<string, unknown> = {}): Docs {
  const docs = tree();
  const trigger = docs[TRIGGER] as any;
  trigger.settings = {
    ...trigger.settings,
    ...settings,
    outcomes: { ...trigger.settings.outcomes, ...outcomes },
  };
  trigger.policies = [{ policy: EMPLOYEES_ONLY, in: { token: '{{request.headers.authorization}}' } }, CAN_REGISTER];
  (docs['features/customers/feature.json'] as any).dependsOn = ['access'];
  return { ...docs, 'project.json': project(docs), ...directories() };
}

/** The plugins a gated tree loads with: the queue tree's, and the two the access tree needs. */
export const gatedPlugins = (broker: FakeBroker): Record<string, PluginModule> => ({
  ...pluginsWith(broker),
  '@http': http,
  '@auth': auth,
});

/** Load a written gated tree, with its include. */
export const loadGated = (dir: string, broker: FakeBroker) => loadTree(dir, gatedPlugins(broker), INCLUDES);
