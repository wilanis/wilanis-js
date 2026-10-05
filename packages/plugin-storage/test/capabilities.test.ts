/**
 * What an engine can do is what its kind document says (RFC 0022): `capabilitiesOf` reads the block of the kind
 * a connection names, and a storage kind without one is a broken plugin, refused when the plugin loads.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildEnv } from '@wilanis/compiler';
import { loadTree, type PluginModule, Scope, schemaRef } from '@wilanis/core';
import memory from '@wilanis/plugin-storage-memory';
import { afterEach, describe, expect, it } from 'vitest';
import { capabilitiesOf } from '../src/index.js';
import { CONNECTION, type Docs, PLUGINS, tree } from './harness.js';

const MEMORY = '@storage-memory/memory.connection-kind.json';
const UPSTREAM = '@connections/upstream.connection.json';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Write documents into a directory of their own, removed after the case. */
function written(docs: Docs): string {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-capabilities-'));
  dirs.push(dir);
  for (const [relative, doc] of Object.entries(docs)) {
    mkdirSync(dirname(join(dir, relative)), { recursive: true });
    writeFileSync(join(dir, relative), JSON.stringify(doc));
  }
  return dir;
}

/** The harness's tree with its records kept in memory, and a second connection that reaches no engine. */
function memoryTree(): Docs {
  const docs = tree();
  const project = docs['project.json'] as { plugins: { use: string }[] };
  project.plugins.push({ use: '@storage-memory' });
  (docs['connections/records.connection.json'] as { kind: string }).kind = MEMORY;
  docs['connections/upstream.connection.json'] = {
    $schema: schemaRef('connection'),
    description: 'something that is not a store',
    kind: '@fake-upstream/upstream.connection-kind.json',
    settings: {},
  };
  return docs;
}

/** The environment a handler of the tree would see. */
function envOf(docs: Docs, plugins: Record<string, PluginModule>) {
  const load = loadTree(written(docs), plugins);
  expect(load.refusals.items).toEqual([]);
  return buildEnv(new Scope(load.registry, load.resolve)).env;
}

describe('capabilitiesOf: what the engine behind a connection can do', () => {
  it("answers the memory kind's block for a connection of it, every entry at its widest", () => {
    const env = envOf(memoryTree(), { ...PLUGINS, '@storage-memory': memory });
    expect(capabilitiesOf(env, CONNECTION)).toEqual({
      transactionalDdl: true,
      unique: ['string', 'number', 'boolean', 'shape', 'list', 'unknown'],
      refs: true,
    });
  });

  it('throws naming the kind for a connection whose kind is not storage, and naming one the tree has not got', () => {
    const env = envOf(memoryTree(), { ...PLUGINS, '@storage-memory': memory });
    expect(() => capabilitiesOf(env, UPSTREAM)).toThrow(
      `connection '${UPSTREAM}' is of kind '@fake-upstream/upstream.connection-kind.json', which does not say "storage": true`,
    );
    expect(() => capabilitiesOf(env, '@connections/nowhere.connection.json')).toThrow(
      "unknown connection '@connections/nowhere.connection.json'",
    );
  });

  it('a storage kind without the block is a broken plugin: the load refuses its document', () => {
    const docs = written({
      'plugin.json': {
        $schema: schemaRef('plugin'),
        description: 'an engine whose author forgot to say what it can do',
        grants: { connectionKinds: ['@careless/careless.connection-kind.json'] },
      },
      'careless.connection-kind.json': {
        $schema: schemaRef('connection-kind'),
        description: 'a connection reaching an engine of unknown limits',
        settings: { fields: {} },
        storage: true,
      },
    });
    const careless: PluginModule = { root: '@careless', docs, handlers: {} };
    const project = tree();
    (project['project.json'] as { plugins: { use: string }[] }).plugins.push({ use: '@careless' });
    const load = loadTree(written(project), { ...PLUGINS, '@careless': careless });
    expect(load.refusals.items.map(one => [one.code, one.message])).toEqual([
      ['D001', expect.stringContaining("missing 'capabilities'")],
    ]);
  });
});
