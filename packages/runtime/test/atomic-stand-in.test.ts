/**
 * One transaction across a stand-in (#653), run. Under production `jobs.connection.json` stands for
 * `customers-postgres.connection.json`, so the planted atomic graph that writes a customer and publishes a removal
 * to jobs writes one connection twice: the store call and the publish must join one transaction, and commit or
 * roll back together. Before, the store joined under `customers-postgres.connection.json` and the publish under
 * `jobs.connection.json`, and the second join failed the run with "an atomic graph reached two connections".
 *
 * No database runs here, so what the postgres kind keeps is kept in memory: the memory engine is registered for the
 * postgres kind, and beside it a broker that keeps a message as a record in whatever transaction the engine began,
 * joined under the connection the environment hands it -- the part of the table broker a transaction is about.
 * Everything else is the tree's own: the compiler's scope, @storage's and @queue's handlers, and the environment
 * built under production. The same graph against PostgreSQL is in `plugin-storage-postgres`, behind its URL.
 */
import { rmSync } from 'node:fs';
import { runGraph } from '@wilanis/compiler';
import type { Atomic } from '@wilanis/core';
import { type Broker, brokers, type Message } from '@wilanis/plugin-queue';
import { type At, engines, type Transaction } from '@wilanis/plugin-storage';
import { MemoryEngine } from '@wilanis/plugin-storage-memory';
import { afterEach, describe, expect, it } from 'vitest';
import { embedderFor, postLoad } from '../src/index.js';
import { loadedEditingAll } from './example-harness.js';
import { BOUND, PLANTED } from './stand-in-tree.js';

const POSTGRES = '@storage-postgres/postgres.connection-kind.json';
const JOBS = '@connections/jobs.connection.json';
/** The context a signed-in customer of tenant acme is read from: all the scoped store asks of it is the tenant. */
const ACME = { session: { attributes: { tenant: 'acme' } } };

/** The environment's connections, as a handler reads them. */
type Connections = Record<string, { kind: string; settings: Record<string, unknown>; path: string }>;

/** A broker of the postgres kind whose queue is a collection of the store, kept in the store's own transaction. */
class InTheStore implements Broker {
  private made = 0;

  constructor(
    private readonly env: Record<string, unknown>,
    private readonly store: MemoryEngine,
  ) {}

  async ensure(): Promise<void> {}

  async consume(): Promise<() => Promise<void>> {
    throw new Error('nothing consumes here');
  }

  /** Keep the message through the transaction's engine, joined under the connection the name reaches. */
  async publish(connection: string, queue: string, message: Message, atomic?: Atomic): Promise<{ id: string }> {
    const at = this.queueOn(connection);
    const engine = atomic
      ? (await atomic.join<Transaction>(at.connection, () => this.store.begin(at))).engine
      : this.store;
    this.made++;
    const id = `m${this.made}`;
    await engine.put(at, { id, queue, body: message.body }, { replace: false });
    return { id };
  }

  /** Every message the connection keeps, committed. */
  kept(connection: string): Promise<unknown[]> {
    return this.store.find(this.queueOn(connection), {});
  }

  /** The queue's collection, on the connection the environment says the name reaches. */
  private queueOn(connection: string): At {
    const { kind, settings, path } = (this.env.connections as Connections)[connection];
    return {
      connection: path,
      kind,
      settings,
      name: 'wilanis_queue',
      shape: { kind: 'unknown' },
      key: 'id',
      unique: [],
      refs: [],
      referenced: [],
      defaults: {},
    };
  }
}

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

/** The copy with the planted graph, served under production over memory, and a way to fire the customer port. */
async function underProduction() {
  const { load, dir } = loadedEditingAll(PLANTED, BOUND);
  const emb = embedderFor(load, {
    profile: 'production',
    env: { ...process.env, CUSTOMERS_DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none' },
  });
  const down = await postLoad(load, emb, () => {});
  const blobs = emb.blobs.scope();
  const env = emb.envFor(blobs);
  const store = new MemoryEngine();
  const broker = new InTheStore(env, store);
  engines(env).register(POSTGRES, store);
  brokers(env).register(POSTGRES, broker);
  const run = (op: string, input: Record<string, unknown> = {}) =>
    runGraph(emb.operation(`@customers/domain/customer.port.json#${op}`), {
      initial: { in: input, context: ACME },
      env,
    });
  close = async () => {
    await blobs.release();
    await down();
    rmSync(dir, { recursive: true, force: true });
  };
  return { run, broker };
}

/** A customer of the tier, whole: a gold one carries a note, as the example's invariant asks. */
const customer = (tier: string) => ({ id: `c-${tier}`, name: 'Ada', email: `${tier}@example.com`, tier, note: 'met' });

describe('an atomic graph writing a store and publishing through its stand-in, under production', () => {
  it('keeps the customer and the message announcing them, together, when the graph answers', async () => {
    const { run, broker } = await underProduction();
    const kept = await run('keep', customer('bronze'));
    expect(kept.status).toBe('done');
    expect(((await run('listAll')).output as { id: string }[]).map(one => one.id)).toEqual(['c-bronze']);
    expect(await broker.kept(JOBS)).toEqual([{ id: 'm1', queue: 'removals', body: { id: 'c-bronze' } }]);
  });

  it('keeps neither when the graph refuses after both were written', async () => {
    const { run, broker } = await underProduction();
    const declined = await run('keep', customer('gold'));
    expect(declined.status).toBe('failed');
    expect(String(declined.nodes.op?.error)).toContain('a gold customer is kept elsewhere');
    expect((await run('listAll')).output).toEqual([]);
    expect(await broker.kept(JOBS)).toEqual([]);
  });
});
