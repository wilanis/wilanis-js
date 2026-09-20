/**
 * The eight operations, each the same three steps: read the collection off the store document, find the engine
 * registered for its connection's kind, and ask it. Nothing here knows how records are kept, and nothing here
 * decides what a filter may say -- the grammar is parsed in `where.ts` so every engine judges one alike.
 */
import type { Atomic } from '@wilanis/core';
import type { Handler } from '@wilanis/engine';
import type { At, Engine, Order, Query, Transaction } from './engine.js';
import { ensureStore } from './ensure.js';
import { collectionAt, engineFor, scopedAt, storeFor } from './store.js';
import { whereOf } from './where.js';

type Input = Record<string, unknown>;
type Ctx = { env: Record<string, unknown> };

/** One scope as it reaches an engine: the collection's scoped columns, each holding one value. */
export type Scope = Record<string, string | number>;

/**
 * The scope an operation carries, held to the collection's own words before anything is kept or read. The
 * compiler fills it at every site over a scoped collection from the store's reads, so in a checked tree it
 * arrives fitting; a read of an edge types `unknown`, and a tree reloaded under a store that gained a scope
 * has sites that were lowered without one, so the judgement is made here as `where`'s is -- honestly, at the
 * value -- rather than assumed from the check that passed.
 *
 * A collection declaring no scope takes none: the compiler writes nothing there and X214 refuses a document
 * that does, so anything arriving is a run against a tree that was never checked.
 */
function scopeOf(given: unknown, columns: string[], name: string): Scope | undefined {
  if (columns.length === 0) {
    if (given !== undefined) throw new Error(`scope: '${name}' keeps no scope, and this operation carries one`);
    return undefined;
  }
  if (!given || typeof given !== 'object' || Array.isArray(given))
    throw new Error(`scope: '${name}' is scoped by ${columns.join(', ')}, and this operation carries no scope`);
  const scope: Scope = {};
  for (const column of columns) {
    const value = (given as Record<string, unknown>)[column];
    if (typeof value !== 'string' && typeof value !== 'number')
      throw new Error(`scope: '${name}' is scoped by '${column}', which holds a string or a number`);
    scope[column] = value;
  }
  const extra = Object.keys(given).filter(key => !columns.includes(key));
  if (extra.length > 0)
    throw new Error(`scope: '${name}' keeps no column '${extra[0]}' (scoped by: ${columns.join(', ')})`);
  return scope;
}

/**
 * What an operation reached: the collection, whoever keeps it, and the scope it was carried under, judged.
 * Handing the scope on is the engine contract's, which takes it beside the key, the filter and the record;
 * until it does, this plugin's part is to have judged it, which is what makes a scope that does not fit the
 * collection's words fail the node here rather than reach a statement.
 */
interface Reached {
  at: At;
  engine: Engine;
  scope: Scope | undefined;
}

/**
 * What every operation starts from: the collection it names, whoever keeps it, and the scope it carries --
 * judged here, once, so the six operations that take one judge it alike and `newKey`, which takes none,
 * says so in one word rather than by omission.
 *
 * Inside an atomic graph the engine is the transaction's own. The scope opens one on the first call and
 * hands back the same one to every later call on that connection, so the whole graph's records move
 * together; outside one, `env.atomic` is absent and nothing changes.
 */
async function at(input: Input, ctx: Ctx, unscoped?: 'takes no scope'): Promise<Reached> {
  const collection = collectionAt(ctx.env, input.store, input.collection);
  const columns = unscoped ? [] : scopedAt(ctx.env, input.store, input.collection);
  const scope = scopeOf(input.scope, columns, collection.name);
  const engine = engineFor(ctx.env, collection);
  const atomic = ctx.env.atomic as Atomic | undefined;
  if (!atomic) return { at: collection, engine, scope };
  if (!engine.begin)
    throw new Error(
      `the engine keeping '${collection.connection}' cannot take part in a transaction, so an atomic graph cannot write through it`,
    );
  const joined = await atomic.join<Transaction>(collection.connection, async () => {
    const opened = await engine.begin?.(collection);
    if (!opened)
      throw new Error(`the engine keeping '${collection.connection}' opened no transaction for an atomic graph`);
    return opened;
  });
  return { at: collection, engine: joined.engine, scope };
}

/** The orderings a find asks for, held to the one shape they may have. */
function orderOf(given: unknown): Order[] | undefined {
  if (given === undefined || given === null) return undefined;
  if (!Array.isArray(given)) throw new Error('order: a list of { by, dir }');
  return given.map(one => {
    const entry = (one ?? {}) as Partial<Order>;
    if (typeof entry.by !== 'string') throw new Error("order: every entry names the field it orders 'by'");
    return { by: entry.by, dir: entry.dir === 'desc' ? 'desc' : 'asc' };
  });
}

/** How much of the answer a find takes: a count, a skip, or neither. */
function countOf(given: unknown, name: string): number | undefined {
  if (given === undefined || given === null) return undefined;
  if (typeof given !== 'number' || !Number.isInteger(given) || given < 0)
    throw new Error(`${name}: a whole number of records, or nothing`);
  return given;
}

/** An object a write is given, held to being one before it reaches an engine. */
function objectOf(given: unknown, name: string): Record<string, unknown> {
  if (!given || typeof given !== 'object' || Array.isArray(given)) throw new Error(`${name}: an object`);
  return given as Record<string, unknown>;
}

const get: Handler = async ({ in: input, ctx }) => {
  const { at: where, engine } = await at(input, ctx);
  return engine.get(where, input.key);
};

const find: Handler = async ({ in: input, ctx }) => {
  const { at: where, engine } = await at(input, ctx);
  const query: Query = {
    where: whereOf(input.where, where.shape),
    order: orderOf(input.order),
    limit: countOf(input.limit, 'limit'),
    offset: countOf(input.offset, 'offset'),
  };
  return engine.find(where, query);
};

const count: Handler = async ({ in: input, ctx }) => {
  const { at: where, engine } = await at(input, ctx);
  return engine.count(where, whereOf(input.where, where.shape));
};

const put: Handler = async ({ in: input, ctx }) => {
  const { at: where, engine } = await at(input, ctx);
  return engine.put(where, objectOf(input.record, 'record'), input.replace !== false);
};

const patch: Handler = async ({ in: input, ctx }) => {
  const { at: where, engine } = await at(input, ctx);
  const changes = objectOf(input.changes, 'changes');
  if (where.key in changes)
    throw new Error(`patch: '${where.key}' is the key of this collection, and a key is never patched`);
  return engine.patch(where, input.key, changes);
};

const remove: Handler = async ({ in: input, ctx }) => {
  const { at: where, engine } = await at(input, ctx);
  return engine.remove(where, input.key);
};

/**
 * A key, minted by whoever keeps the records. It carries no scope and the port declares none: a key is unique
 * across every scope of the collection, so one tenant can never be handed a key another already holds.
 */
const newKey: Handler = async ({ in: input, ctx }) => {
  const { at: where, engine } = await at(input, ctx, 'takes no scope');
  return engine.newKey(where);
};

/**
 * What preparing the store created, or zeros. The work is `ensure.ts`'s, over the one planner: this reads the
 * store off the tree and finds whoever keeps it, which is what every operation of this plugin does, and asks.
 *
 * The counts are what was *created*, never what the store declares, so a second run answers zeros and so does
 * an engine with nothing to create -- that is what makes them worth printing at startup: a line that says
 * three collections were made says something a line saying three are declared does not.
 */
const ensure: Handler = async ({ in: input, ctx }) => {
  const store = storeFor(ctx.env, input.store);
  return ensureStore(engineFor(ctx.env, store.on), store, ctx.env);
};

/** Every operation this plugin grants, by the path#operation a graph names. */
export const handlers: Record<string, Handler> = {
  '@storage/store.port.json#get': get,
  '@storage/store.port.json#find': find,
  '@storage/store.port.json#count': count,
  '@storage/store.port.json#put': put,
  '@storage/store.port.json#patch': patch,
  '@storage/store.port.json#remove': remove,
  '@storage/store.port.json#newKey': newKey,
  '@storage/storage.port.json#ensure': ensure,
};
