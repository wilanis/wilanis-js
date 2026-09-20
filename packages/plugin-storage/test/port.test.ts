/**
 * The operations, driven the way the kernel drives them: a store document read off the environment, the
 * collection found in it, and the engine registered for its connection's kind asked. What is tested here is
 * the three steps every handler takes -- not how records are kept, which is the engine's and the suite's.
 */
import type { Atomic, Participant } from '@wilanis/core';
import { type Type, TypeResolver } from '@wilanis/core';
import { MemoryEngine } from '@wilanis/plugin-storage-memory';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import plugin, { engines } from '../src/index.js';

const KIND = '@fake/fake.connection-kind.json';
const CONNECTION = '@connections/records.connection.json';
const STORE = '@features/monitor/data/entries.store.json';
const SHAPE = '@features/monitor/domain/Entry.shape.json';

const types = new TypeResolver(() => undefined);
const ENTRY: Type = types.inline({
  fields: { id: { type: 'string' }, url: { type: 'string' }, hits: { type: 'number' } },
});

const storeDoc = {
  connection: CONNECTION,
  collections: {
    entries: { of: SHAPE, key: 'id' },
    notes: { of: SHAPE, key: 'id' },
  },
};

let env: Record<string, unknown>;
const ctx = () => ({ env, nodePath: [], attach: () => {} }) as never;
const run = (op: string, input: Record<string, unknown>) =>
  plugin.handlers[op]({ in: input, ctx: ctx() } as never) as Promise<Record<string, unknown>>;
const on = (extra: Record<string, unknown> = {}) => ({ store: STORE, collection: 'entries', ...extra });

beforeEach(() => {
  env = {
    canon: (ref: string) => ref,
    connections: { [CONNECTION]: { kind: KIND, settings: {} } },
    resolving: {
      document: (ref: string) => (ref === STORE ? storeDoc : undefined),
      type: (ref: string) => {
        if (ref === SHAPE) return ENTRY;
        throw new Error(`unknown type '${ref}'`);
      },
    },
  };
  engines(env).register(KIND, new MemoryEngine());
});

describe('what an operation reads off the tree', () => {
  it('a record written under one collection is read back from it', async () => {
    const record = { id: '1', url: 'https://x', hits: 2 };
    expect(await run('@storage/store.port.json#put', on({ record }))).toEqual({ record, conflict: false });
    expect(await run('@storage/store.port.json#get', on({ key: '1' }))).toEqual({ record });
    expect(await run('@storage/store.port.json#count', on({}))).toBe(1);
  });

  it('the collection is the pair of connection and name, so two of one store do not share records', async () => {
    await run('@storage/store.port.json#put', on({ record: { id: '1', url: 'https://x', hits: 2 } }));
    expect(await run('@storage/store.port.json#count', { store: STORE, collection: 'notes' })).toBe(0);
  });

  it('ensure prepares every collection the store declares, and says what it made', async () => {
    // the memory engine creates nothing -- a collection exists as soon as it is asked for -- so it answers
    // zeros, which is the same answer any engine gives on a second run
    expect(await run('@storage/storage.port.json#ensure', { store: STORE })).toEqual({
      collections: 0,
      columns: 0,
      constraints: 0,
    });
  });

  it('newKey answers a key the collection does not hold', async () => {
    const key = await run('@storage/store.port.json#newKey', on({}));
    expect(await run('@storage/store.port.json#get', on({ key }))).toEqual({ record: undefined });
  });
});

describe('what an operation refuses before it reaches an engine', () => {
  it('a store the tree does not hold, and a collection the store does not declare', async () => {
    await expect(run('@storage/store.port.json#get', { store: '@nope.store.json', key: '1' })).rejects.toThrow(
      /unknown store '@nope.store.json'/,
    );
    await expect(run('@storage/store.port.json#get', { store: STORE, collection: 'nope', key: '1' })).rejects.toThrow(
      /has no collection 'nope' \(collections: entries, notes\)/,
    );
  });

  it('a filter naming a field the collection shape lacks, judged by the grammar and not by the engine', async () => {
    await expect(run('@storage/store.port.json#find', on({ where: { nope: 1 } }))).rejects.toThrow(
      /'nope' is not a field of the collection's shape/,
    );
  });

  it('a patch of the key, since a key is never patched', async () => {
    await expect(run('@storage/store.port.json#patch', on({ key: '1', changes: { id: 'other' } }))).rejects.toThrow(
      /'id' is the key of this collection, and a key is never patched/,
    );
  });

  it('an order or a page that is not one', async () => {
    await expect(run('@storage/store.port.json#find', on({ order: [{ dir: 'asc' }] }))).rejects.toThrow(
      /every entry names the field it orders 'by'/,
    );
    await expect(run('@storage/store.port.json#find', on({ limit: -1 }))).rejects.toThrow(/limit: a whole number/);
  });

  it('a connection kind no loaded plugin registered an engine for, naming what to add', async () => {
    env.connections = { [CONNECTION]: { kind: '@other/other.connection-kind.json', settings: {} } };
    await expect(run('@storage/store.port.json#count', on({}))).rejects.toThrow(
      /no storage engine for connection kind '@other\/other.connection-kind.json': add the package that grants it/,
    );
  });
});

/**
 * The scope an operation carries, judged the way a filter is: at the value, before an engine sees it. A
 * checked tree cannot reach any of these -- the compiler fills a scope at every site over a scoped
 * collection and X214 refuses a document that writes one -- but a read of an edge types `unknown`, and a
 * tree reloaded under a store that has gained a scope has sites lowered without one, so the handler says
 * what it found rather than assuming the check that passed.
 */
describe('the scope an operation carries', () => {
  const scoped = { ...on(), key: '1' };
  const entries = storeDoc.collections.entries as { scoped?: Record<string, string> };
  beforeEach(() => {
    entries.scoped = { tenant: '{{tenant}}' };
  });
  afterEach(() => {
    entries.scoped = undefined;
  });

  it('a scoped collection reached with no scope at all fails the node, naming the column', async () => {
    await expect(run('@storage/store.port.json#get', scoped)).rejects.toThrow(
      /scope: 'entries' is scoped by tenant, and this operation carries no scope/,
    );
  });

  it('a scope missing one of the collection columns fails the node', async () => {
    entries.scoped = {
      tenant: '{{tenant}}',
      owner: '{{owner}}',
    };
    await expect(run('@storage/store.port.json#find', { ...on(), scope: { tenant: 'acme' } })).rejects.toThrow(
      /scope: 'entries' is scoped by 'owner', which holds a string or a number/,
    );
  });

  it('a scope whose column holds something other than a string or a number fails the node', async () => {
    for (const tenant of [7n, { id: 'acme' }, ['acme'], null, true])
      await expect(run('@storage/store.port.json#count', { ...on(), scope: { tenant } })).rejects.toThrow(
        /scope: 'entries' is scoped by 'tenant', which holds a string or a number/,
      );
  });

  it('a scope naming a column the collection does not keep fails the node, naming the ones it does', async () => {
    await expect(
      run('@storage/store.port.json#remove', { ...scoped, scope: { tenant: 'acme', nope: 'x' } }),
    ).rejects.toThrow(/scope: 'entries' keeps no column 'nope' \(scoped by: tenant\)/);
  });

  it('a scope that is not an object at all fails the node as an absent one does', async () => {
    await expect(run('@storage/store.port.json#get', { ...scoped, scope: 'acme' })).rejects.toThrow(
      /and this operation carries no scope/,
    );
  });

  it('a scope that fits is judged, and the operation runs under exactly it', async () => {
    const record = { id: '1', url: 'https://x', hits: 2 };
    expect(await run('@storage/store.port.json#put', { ...on(), record, scope: { tenant: 'acme' } })).toEqual({
      record,
      conflict: false,
    });
    expect(await run('@storage/store.port.json#count', { ...on(), scope: { tenant: 'acme' } })).toBe(1);
  });

  it('the scope reaches the engine: another scope does not see the row this one wrote', async () => {
    const record = { id: '1', url: 'https://x', hits: 2 };
    await run('@storage/store.port.json#put', { ...on(), record, scope: { tenant: 'acme' } });
    expect(await run('@storage/store.port.json#count', { ...on(), scope: { tenant: 7 } })).toBe(0);
    expect(await run('@storage/store.port.json#get', { ...on(), key: '1', scope: { tenant: 7 } })).toEqual({
      record: undefined,
    });
  });

  it('newKey takes no scope: a key is unique across every scope, so there is none to mint it under', async () => {
    expect(typeof (await run('@storage/store.port.json#newKey', on()))).toBe('string');
  });

  it('a collection that declares no scope takes none, and is refused nothing for arriving without one', async () => {
    entries.scoped = undefined;
    expect(await run('@storage/store.port.json#count', on({}))).toBe(0);
  });

  it('a scope handed to a collection that keeps none fails the node rather than widening the operation', async () => {
    entries.scoped = undefined;
    await expect(run('@storage/store.port.json#count', { ...on(), scope: { tenant: 'acme' } })).rejects.toThrow(
      /scope: 'entries' keeps no scope, and this operation carries one/,
    );
  });
});

/**
 * What a handler does with `env.atomic`, which is the whole of this plugin's part in RFC 0004: it joins the
 * scope once per connection and runs on the engine the transaction handed back. The scope here is the one
 * the runtime puts on `env`, written out rather than imported, so what is tested is the handler's use of the
 * contract and not the runtime's implementation of it.
 */
describe('an operation inside an atomic graph', () => {
  const opened: Participant[] = [];

  /** The scope the runtime hands down: one participant per connection, memoised on the promise. */
  const scope = (): Atomic => {
    const joined = new Map<string, Promise<Participant>>();
    return {
      join<T extends Participant>(connection: string, open: () => Promise<T>): Promise<T> {
        let pending = joined.get(connection);
        if (!pending) {
          pending = open().then(participant => {
            opened.push(participant);
            return participant;
          });
          joined.set(connection, pending);
        }
        return pending as Promise<T>;
      },
    };
  };

  beforeEach(() => {
    opened.length = 0;
  });

  it('runs on the transaction, so what it writes is not kept until the scope commits', async () => {
    env.atomic = scope();
    const record = { id: '1', url: 'https://x', hits: 2 };
    await run('@storage/store.port.json#put', on({ record }));
    expect(await run('@storage/store.port.json#count', on({}))).toBe(1);

    const outside = { ...env, atomic: undefined };
    const counted = plugin.handlers['@storage/store.port.json#count'];
    expect(await counted({ in: on({}), ctx: { env: outside, nodePath: [], attach: () => {} } } as never)).toBe(0);

    await opened[0].commit();
    expect(await counted({ in: on({}), ctx: { env: outside, nodePath: [], attach: () => {} } } as never)).toBe(1);
  });

  it('joins once, so two operations of one connection are one transaction', async () => {
    env.atomic = scope();
    await run('@storage/store.port.json#put', on({ record: { id: '1', url: 'https://x', hits: 2 } }));
    await run('@storage/store.port.json#put', on({ record: { id: '2', url: 'https://y', hits: 3 } }));
    expect(opened).toHaveLength(1);
    expect(await run('@storage/store.port.json#count', on({}))).toBe(2);
  });

  it('refuses rather than writing outside the transaction the graph declared', async () => {
    engines(env).register(
      KIND,
      new (class extends MemoryEngine {
        begin = undefined;
      })(),
    );
    env.atomic = scope();
    await expect(
      run('@storage/store.port.json#put', on({ record: { id: '1', url: 'https://x', hits: 2 } })),
    ).rejects.toThrow(/cannot take part in a transaction, so an atomic graph cannot write through it/);
  });
});
