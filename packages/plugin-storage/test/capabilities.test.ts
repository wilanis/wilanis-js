/**
 * What an engine can do is what its kind document says (RFC 0022): `capabilitiesOf` reads the block of the kind
 * a connection names, a storage kind without one is a broken plugin, refused when the plugin loads, and a store
 * whose `unique` or `refs` asks more than the block says is refused by the checker (C008). Those sabotages sit here
 * rather than in `rules.test.ts`, which holds @storage's own X rules and is at the house limit.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildEnv } from '@wilanis/compiler';
import { loadTree, type PluginModule, Scope, schemaRef } from '@wilanis/core';
import memory from '@wilanis/plugin-storage-memory';
import { afterEach, describe, expect, it } from 'vitest';
import { capabilitiesOf } from '../src/index.js';
import { CONNECTION, type Docs, MEMORY, NARROW, PLUGINS, refusals, tree } from './harness.js';

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

describe('C008 reads the block: a store asks no more of its engine than the kind constrains', () => {
  /** The tree over a connection of `kind`, its customers carrying a shape field, their collection edited by `change`. */
  function over(kind: string, use: string, change: (collection: any) => void): Docs {
    const docs = tree();
    (docs['project.json'] as { plugins: { use: string }[] }).plugins.push({ use });
    (docs['connections/records.connection.json'] as { kind: string }).kind = kind;
    const customer = docs['features/customers/domain/Customer.shape.json'] as { fields: Record<string, unknown> };
    customer.fields.wanted = { type: '@features/customers/domain/Ref.shape.json', required: false };
    change((docs['features/customers/data/customers.store.json'] as any).collections.customers);
    return docs;
  }
  const uniqueOverShape = (collection: any) => {
    collection.unique = [['email', 'wanted']];
  };
  const referring = (collection: any) => {
    collection.refs = { note: { collection: 'customers' } };
  };
  const c008 = (docs: Docs) => refusals(docs).filter(one => one.code === 'C008');

  it('a unique over a shape field passes on the memory kind, whose block constrains every class', () => {
    expect(refusals(over(MEMORY, '@storage-memory', uniqueOverShape))).toEqual([]);
  });

  it('C008 the same unique over a kind constraining strings alone, naming the class and the list', () => {
    const found = c008(over(NARROW, '@narrow-engine', uniqueOverShape));
    expect(found).toHaveLength(1);
    expect(found[0].at).toBe('collections/customers/unique/0/1');
    expect(found[0].message).toBe(`'wanted' is a shape, and ${CONNECTION} keeps no unique constraint over one`);
    expect(found[0].hint).toBe(`'wanted' is a shape; ${NARROW} constrains unique over string`);
  });

  it('C008 refs over a kind that enforces none, where memory, which does, passes them', () => {
    expect(refusals(over(MEMORY, '@storage-memory', referring))).toEqual([]);
    const found = c008(over(NARROW, '@narrow-engine', referring));
    expect(found).toHaveLength(1);
    expect(found[0].at).toBe('collections/customers/refs/note');
    expect(found[0].hint).toBe(
      `${NARROW} does not enforce refs; check the target with a get, or move the store to a connection that does`,
    );
  });

  it('C008 once for a reference over a list on such a kind: the type refuses it, and the kind adds nothing', () => {
    const overList = (collection: any) => {
      collection.refs = { tags: { collection: 'customers' } };
    };
    const found = c008(over(NARROW, '@narrow-engine', overList));
    expect(found.map(one => [one.at, one.message])).toEqual([
      ['collections/customers/refs/tags', expect.stringMatching(/a reference holds one value/)],
    ]);
  });
});
