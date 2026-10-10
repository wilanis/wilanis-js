/**
 * The run's signal reaches the engine (#798). Every handler hands the engine the run it is part of -- as the
 * `signal` of the options it already builds, or as the trailing `Run` of a call that takes none -- so an engine
 * can stop between two statements once the run is cancelled (RFC 0012). What an engine does with it is the
 * engine's and the suite's; this is the forwarding alone.
 */
import { type Type, TypeResolver } from '@wilanis/core';
import { MemoryEngine } from '@wilanis/plugin-storage-memory';
import { beforeEach, describe, expect, it } from 'vitest';
import plugin, {
  type At,
  betweenStatements,
  engines,
  type Put,
  type Query,
  type Run,
  type Written,
} from '../src/index.js';

const KIND = '@fake/fake.connection-kind.json';
const CONNECTION = '@connections/records.connection.json';
const STORE = '@features/customers/data/customers.store.json';
const SHAPE = '@features/customers/domain/Customer.shape.json';

const types = new TypeResolver(() => undefined);
const ENTRY: Type = types.inline({ fields: { id: { type: 'string' }, url: { type: 'string' } } });
const storeDoc = { connection: CONNECTION, collections: { entries: { of: SHAPE, key: 'id' } } };

/** The memory engine, noting the signal each call was handed. */
class Noting extends MemoryEngine {
  signals: (AbortSignal | undefined)[] = [];
  override get(at: At, key: unknown, scope?: undefined, run?: Run) {
    this.signals.push(run?.signal);
    return super.get(at, key, scope);
  }
  override find(at: At, query: Query) {
    this.signals.push(query.signal);
    return super.find(at, query);
  }
  override count(at: At, where: undefined, scope?: undefined, run?: Run) {
    this.signals.push(run?.signal);
    return super.count(at, where, scope);
  }
  override put(at: At, record: Record<string, unknown>, put: Put) {
    this.signals.push(put.signal);
    return super.put(at, record, put);
  }
  override patch(at: At, key: unknown, changes: Record<string, unknown>, written?: Written) {
    this.signals.push(written?.signal);
    return super.patch(at, key, changes, written);
  }
  override remove(at: At, key: unknown, scope?: undefined, run?: Run) {
    this.signals.push(run?.signal);
    return super.remove(at, key, scope);
  }
  override newKey(at: At, run?: Run) {
    this.signals.push(run?.signal);
    return super.newKey(at);
  }
  override begin(at: At, run?: Run) {
    this.signals.push(run?.signal);
    return super.begin(at);
  }
}

let env: Record<string, unknown>;
let engine: Noting;
const signal = new AbortController().signal;
const run = (op: string, input: Record<string, unknown>) =>
  plugin.handlers[op]({ in: input, ctx: { env, signal, nodePath: [], attach: () => {} } } as never);
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
  engine = new Noting();
  engines(env).register(KIND, engine);
});

describe('every handler hands the engine the signal of the run it is part of', () => {
  it.each([
    ['get', { key: '1' }],
    ['find', {}],
    ['count', {}],
    ['put', { record: { id: '1', url: 'https://x' } }],
    ['patch', { key: '1', changes: { url: 'https://y' } }],
    ['remove', { key: '1' }],
    ['newKey', {}],
  ])('%s', async (op, input) => {
    await run(`@storage/store.port.json#${op}`, on(input));
    expect(engine.signals).toEqual([signal]);
  });

  it('and begin, where an atomic graph opens the transaction', async () => {
    env.atomic = { join: (_name: string, open: () => Promise<unknown>) => open() };
    await run('@storage/store.port.json#count', on({}));
    // begin was handed it, and so was the count made inside the transaction's engine
    expect(engine.signals).toEqual([signal]);
  });
});

describe('betweenStatements', () => {
  it('does nothing while the run goes on, and throws the reason once it was cancelled', () => {
    const control = new AbortController();
    expect(() => betweenStatements({ signal: control.signal })).not.toThrow();
    expect(() => betweenStatements(undefined)).not.toThrow();
    control.abort(new Error('the deadline passed'));
    expect(() => betweenStatements({ signal: control.signal })).toThrow('the deadline passed');
  });
});
