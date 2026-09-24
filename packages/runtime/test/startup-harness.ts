/**
 * The trees the startup tests start: one domain port met by a native operation the test watches, a plugin
 * whose postLoad records that it ran and which grants a `holds` operation standing in for a listener, and --
 * for the profile tests -- the same tree declaring two profiles that reach different connections.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type PluginModule, schemaRef, schemaUrl } from '@wilanis/core';
import { BUILTIN_PLUGINS } from '../src/index.js';
import { docsDir } from './example-harness.js';

/** The documents of the plugin behind the boot port: its manifest, its two ports and the kind of its connections. */
const FAKE_DOCS = {
  'plugin.json': {
    $schema: schemaRef('plugin'),
    description: 'a plugin behind the boot port',
    grants: {
      ports: ['@fake/boot.port.json', '@fake/server.port.json'],
      connectionKinds: ['@fake/boot.connection-kind.json'],
    },
  },
  'boot.connection-kind.json': {
    $schema: schemaRef('connection-kind'),
    description: 'what the boot port opens, reached with a key',
    settings: { fields: { key: { type: 'string' } } },
  },
  'boot.port.json': {
    $schema: schemaRef('port'),
    description: 'what the tree does before it serves',
    operations: {
      open: {
        description: 'open the connection',
        accepts: {
          name: { type: 'string' },
          connection: { type: 'string', static: true, required: false },
        },
        returns: 'string',
      },
    },
  },
  'server.port.json': {
    $schema: schemaRef('port'),
    description: 'the listener this tree may open',
    operations: { listen: { description: 'answer requests until the process stops', holds: true } },
  },
};

/**
 * A tree with the startup steps given, whose boot port answers what `onBoot` does. `calls` records the order of
 * the plugin's postLoad, each startup step, and the moment the listener opened -- so a test can say what
 * started, and whether. `stuck` names the listener, counted from 1, that will not stop.
 */
export function bootTree(startup: unknown[], onBoot: () => unknown, onDown?: () => void, stuck?: number) {
  const calls: string[] = [];
  /** What the fake listener was given as `env.serving`: the way a test asks the tree to load itself again. */
  let serving: { reload: () => Promise<{ ok: boolean; refusals?: string }> } | undefined;
  const fake: PluginModule = {
    root: '@fake',
    docs: docsDir(FAKE_DOCS),
    handlers: {
      '@fake/boot.port.json#open': async ({ in: input }: any) => {
        calls.push(`open:${input.name}`);
        return onBoot();
      },
      '@fake/server.port.json#listen': async ({ ctx }: any) => {
        calls.push('listening');
        serving = ctx.env.serving;
        const nth = calls.filter(call => call === 'listening').length;
        ctx.env.hold({
          label: `fake listener ${nth}`,
          stop: async () => {
            if (nth === stuck) throw new Error(`listener ${nth} is stuck`);
            calls.push(stuck === undefined ? 'stopped' : `stopped ${nth}`);
          },
        });
        return undefined;
      },
    },
    postLoad: async () => {
      calls.push('postLoad');
      return async () => {
        calls.push('postLoadDown');
        onDown?.();
      };
    },
  };
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-startup-'));
  mkdirSync(join(dir, 'features/boot/domain'), { recursive: true });
  mkdirSync(join(dir, 'features/boot/data'), { recursive: true });
  const put = (rel: string, doc: unknown) => writeFileSync(join(dir, rel), JSON.stringify(doc));
  put('project.json', {
    $schema: schemaUrl('project'),
    name: 'boot',
    description: 'a tree with startup steps',
    plugins: [{ use: '@std' }, { use: '@fake' }],
    startup,
  });
  put('features/boot/feature.json', {
    $schema: schemaRef('feature'),
    description: 'the boot feature',
    effects: ['@fake/boot.port.json#open'],
  });
  put('features/boot/domain/ready.port.json', {
    $schema: schemaRef('port'),
    description: 'what the tree needs before it serves',
    operations: {
      warm: { description: 'warm the connection', accepts: { name: { type: 'string' } }, returns: 'string' },
    },
  });
  put('features/boot/data/ready.binding.json', {
    $schema: schemaRef('binding'),
    description: 'met by the fake connection',
    port: '@features/boot/domain/ready.port.json',
    operations: {
      warm: { run: '@fake/boot.port.json#open', in: { name: '{{in.name}}' } },
    },
  });
  return { dir, put, calls, plugins: { ...BUILTIN_PLUGINS, '@fake': fake }, serving: () => serving };
}

/** One connection of the boot kind whose key is the secret named. */
const connection = (description: string, secret: string) => ({
  $schema: schemaRef('connection'),
  description,
  kind: '@fake/boot.connection-kind.json',
  settings: { key: `{{secrets.${secret}}}` },
});

/**
 * The boot tree declaring `live` and `production`, `live` the default where `withDefault` says so. `production`
 * meets the ready port through `primary.connection.json`, which `primary-production.connection.json` stands in
 * for (PRODUCTION_KEY); `live` meets it through a binding of its own on `laptop.connection.json` (LAPTOP_KEY).
 * Every profile reads SHARED_KEY, through the first step's `in`; PRIMARY_KEY is read by a connection that every
 * profile names and none reaches.
 */
export function profiledTree(startup: unknown[], opts: { withDefault?: boolean } = {}) {
  const tree = bootTree(startup, () => 'ok');
  mkdirSync(join(tree.dir, 'connections'), { recursive: true });
  tree.put('connections/primary.connection.json', connection('the store every profile names', 'primary'));
  tree.put('connections/primary-production.connection.json', connection('the store behind production', 'production'));
  tree.put('connections/laptop.connection.json', connection('the store on the laptop', 'laptop'));
  const port = '@features/boot/domain/ready.port.json';
  const binding = (description: string, on: string) => ({
    $schema: schemaRef('binding'),
    description,
    port,
    operations: { warm: { run: '@fake/boot.port.json#open', in: { name: '{{in.name}}', connection: on } } },
  });
  tree.put(
    'features/boot/data/ready.binding.json',
    binding('met by the primary store', '@connections/primary.connection.json'),
  );
  tree.put(
    'features/boot/data/ready-live.binding.json',
    binding('met on the laptop', '@connections/laptop.connection.json'),
  );
  tree.put('project.json', {
    $schema: schemaUrl('project'),
    name: 'boot',
    description: 'a tree with startup steps and two places it runs',
    plugins: [{ use: '@std' }, { use: '@fake' }],
    secrets: { shared: 'SHARED_KEY', primary: 'PRIMARY_KEY', production: 'PRODUCTION_KEY', laptop: 'LAPTOP_KEY' },
    startup,
    profiles: {
      live: {
        description: 'the laptop',
        ...(opts.withDefault ? { default: true } : {}),
        bindings: { [port]: '@features/boot/data/ready-live.binding.json' },
      },
      production: {
        description: 'behind the load balancer',
        bindings: { [port]: '@features/boot/data/ready.binding.json' },
        connections: { '@connections/primary.connection.json': '@connections/primary-production.connection.json' },
      },
    },
  });
  return tree;
}
