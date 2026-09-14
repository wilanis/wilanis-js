import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import { loadTree, type PluginModule, schemaRef, schemaUrl } from '@wilanis/core';
import storage, { type At, type Engine, engines } from '@wilanis/plugin-storage';
import { describe, expect, it } from 'vitest';
import { BUILTIN_PLUGINS, start } from '../src/index.js';
import { docsDir } from './example-harness.js';

/**
 * A `drift` stops the start. RFC 0003 draws the line that makes this worth its own test: a constraint a graph
 * could route on is answered as a flag, but drift is not a graph's outcome at all -- `ensure` refuses to
 * change what is already there, and the tree stops rather than serving over a database that is not what the
 * store declares. The port never opens, the way it never opens over an unreachable one.
 */
describe('a startup step that prepares a store', () => {
  const Kind = '@drifty/drifty.connection-kind.json';
  const Store = '@features/keep/data/entries.store.json';

  /** An engine that keeps nothing and refuses whatever the case tells it to. */
  const engineThat = (onEnsure: () => void): Engine =>
    ({
      async ensure(_collections: At[]) {
        onEnsure();
        return { collections: 0, columns: 0, constraints: 0 };
      },
    }) as Engine;

  /** A tree whose first startup step prepares a store through a domain port, and whose second listens. */
  const tree = (onEnsure: () => void) => {
    const calls: string[] = [];
    const drifty: PluginModule = {
      root: '@drifty',
      docs: docsDir({
        'plugin.json': {
          $schema: schemaRef('plugin'),
          description: 'an engine that keeps nothing, so a test can say what ensure did',
          grants: { connectionKinds: [Kind] },
        },
        'drifty.connection-kind.json': {
          $schema: schemaRef('connection-kind'),
          description: 'a connection reaching an engine that exists only while a test runs',
          settings: { fields: {} },
          storage: true,
        },
      }),
      handlers: {},
      async postLoad(ctx) {
        engines(ctx.env).register(ctx.scope.canon(Kind), engineThat(onEnsure));
      },
    };
    const server: PluginModule = {
      root: '@listener',
      docs: docsDir({
        'plugin.json': {
          $schema: schemaRef('plugin'),
          description: 'the listener this tree may open',
          grants: { ports: ['@listener/server.port.json'] },
        },
        'server.port.json': {
          $schema: schemaRef('port'),
          description: 'the listener this tree may open',
          operations: { listen: { description: 'answer requests until the process stops', holds: true } },
        },
      }),
      handlers: {
        '@listener/server.port.json#listen': async ({ ctx }: any) => {
          calls.push('listening');
          ctx.env.hold({ label: 'fake listener', stop: async () => {} });
          return undefined;
        },
      },
    };

    const dir = mkdtempSync(join(tmpdir(), 'wilanis-drift-'));
    mkdirSync(join(dir, 'features/keep/domain'), { recursive: true });
    mkdirSync(join(dir, 'features/keep/data'), { recursive: true });
    mkdirSync(join(dir, 'connections'), { recursive: true });
    const put = (rel: string, doc: unknown) => writeFileSync(join(dir, rel), JSON.stringify(doc));

    put('project.json', {
      $schema: schemaUrl('project'),
      name: 'keeper',
      description: 'a tree that prepares its store before it serves',
      plugins: [{ use: '@std' }, { use: '@storage' }, { use: '@drifty' }, { use: '@listener' }],
      startup: [
        { run: '@features/keep/domain/keeping.port.json#prepare', required: true },
        { run: '@listener/server.port.json#listen' },
      ],
    });
    put('connections/records.connection.json', {
      $schema: schemaRef('connection'),
      description: 'where the records live',
      kind: Kind,
      settings: {},
    });
    put('features/keep/feature.json', {
      $schema: schemaRef('feature'),
      description: 'what the tree keeps',
      effects: ['@storage/storage.port.json#ensure'],
    });
    put('features/keep/domain/Entry.shape.json', {
      $schema: schemaRef('shape'),
      description: 'one observed call',
      layer: 'core',
      fields: { id: { type: 'string' }, url: { type: 'string' } },
    });
    put('features/keep/domain/Made.shape.json', {
      $schema: schemaRef('shape'),
      description: 'what preparing the store made',
      layer: 'core',
      fields: { collections: { type: 'number' }, columns: { type: 'number' }, constraints: { type: 'number' } },
    });
    put('features/keep/domain/keeping.port.json', {
      $schema: schemaRef('port'),
      description: 'what the tree needs of its storage before it serves',
      operations: {
        prepare: {
          description: 'Make the store ready to answer, once, before anything is served.',
          returns: '@features/keep/domain/Made.shape.json',
        },
      },
    });
    put('features/keep/data/entries.store.json', {
      $schema: schemaRef('store'),
      description: 'the entries kept so far',
      connection: '@connections/records.connection.json',
      collections: { entries: { of: '@features/keep/domain/Entry.shape.json', key: 'id' } },
    });
    put('features/keep/data/keeping.binding.json', {
      $schema: schemaRef('binding'),
      description: 'prepare delegates to the storage port',
      port: '@features/keep/domain/keeping.port.json',
      operations: { prepare: { run: '@storage/storage.port.json#ensure', in: { store: Store } } },
    });

    const plugins = { ...BUILTIN_PLUGINS, '@storage': storage, '@drifty': drifty, '@listener': server };
    return { dir, calls, plugins };
  };

  it('a drift stops the start, and the port never opens', async () => {
    const { dir, calls, plugins } = tree(() => {
      throw new Error('drift: entries.url is text, and the shape says double precision');
    });
    const loaded = loadTree(dir, plugins);
    expect(checkTree(loaded).format()).toBe('');
    await expect(start(loaded, { log: () => {} })).rejects.toThrow(/drift: entries.url is text/);
    expect(calls).not.toContain('listening');
    rmSync(dir, { recursive: true, force: true });
  });

  it('a store that is ready lets the tree serve, and says what it made', async () => {
    let prepared = 0;
    const { dir, calls, plugins } = tree(() => {
      prepared += 1;
    });
    const loaded = loadTree(dir, plugins);
    const logs: string[] = [];
    const { stop } = await start(loaded, { log: line => logs.push(line) });
    expect(prepared).toBe(1);
    expect(calls).toContain('listening');
    await stop();
    rmSync(dir, { recursive: true, force: true });
  });
});
