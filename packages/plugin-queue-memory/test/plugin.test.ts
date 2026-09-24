/**
 * The plugin around the broker: the kind it grants, and the broker it registers from `postLoad` under that
 * kind, in the table @queue reads. What a broker does is `broker.test.ts`'s; this is how a tree reaches one.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import { loadTree, type PluginModule } from '@wilanis/core';
import queue, { brokers } from '@wilanis/plugin-queue';
import { BUILTIN_PLUGINS } from '@wilanis/runtime';
import { afterAll, describe, expect, it } from 'vitest';
import memory, { KIND, MemoryBroker } from '../src/index.js';

const CONNECTION = '@connections/jobs.connection.json';

/** What postLoad is handed, as far as this plugin reads it: the environment and a scope that canonicalises. */
const loaded = async () => {
  const env = { connections: { [CONNECTION]: { kind: KIND, settings: {} } } };
  await memory.postLoad?.({ env, scope: { canon: (ref: string) => ref } } as never);
  return env;
};

describe('the broker postLoad registers', () => {
  it('is a memory broker, under the kind the plugin grants', async () => {
    expect(brokers(await loaded()).for(KIND)).toBeInstanceOf(MemoryBroker);
  });

  it('is one per load: a second load of a tree starts with nothing queued', async () => {
    const first = await loaded();
    const second = await loaded();
    await brokers(first).for(KIND)?.publish(CONNECTION, 'removals', { body: {}, headers: {} });
    expect((brokers(first).for(KIND) as MemoryBroker).waiting(CONNECTION, 'removals')).toHaveLength(1);
    expect((brokers(second).for(KIND) as MemoryBroker).waiting(CONNECTION, 'removals')).toEqual([]);
  });

  it('is found through a copy of the environment, as a handler is handed one', async () => {
    const env = await loaded();
    // the embedder hands a handler { ...env, blobs } on any run that carries a blob scope
    expect(brokers({ ...env, blobs: {} }).for(KIND)).toBe(brokers(env).for(KIND));
  });
});

/** A tree that names a connection of the memory kind, and nothing else: the smallest tree with a broker. */
function treeWithBroker(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-queue-memory-'));
  const write = (relative: string, doc: unknown) => {
    const path = join(dir, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(doc));
  };
  write('project.json', {
    $schema: '@wilanis/project.schema.json',
    description: 'a tree with a broker kept in memory',
    name: 'queued-in-memory',
    plugins: [{ use: '@std' }, { use: '@queue' }, { use: '@queue-memory' }],
  });
  write('connections/jobs.connection.json', {
    $schema: '@wilanis/connection.schema.json',
    description: 'the queued work, kept for as long as this process runs',
    kind: KIND,
    settings: {},
  });
  return dir;
}

const dir = treeWithBroker();
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('a tree that names this broker', () => {
  const Plugins: Record<string, PluginModule> = { ...BUILTIN_PLUGINS, '@queue': queue, '@queue-memory': memory };

  it('stands: a connection of the kind needs no settings, and the checker is content', () => {
    expect(checkTree(loadTree(dir, Plugins)).format()).toBe('');
  });

  it('the kind says it delivers at least once, which is what a queue trigger receiving from it is held to', () => {
    const kind = loadTree(dir, Plugins).registry.get('connection-kind', KIND);
    expect(kind?.doc.delivery).toBe('at-least-once');
    expect(kind?.doc.settings).toEqual({ fields: {} });
  });
});
