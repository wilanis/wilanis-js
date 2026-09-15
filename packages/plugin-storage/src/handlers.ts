/**
 * The eight operations, each the same three steps: read the collection off the store document, find the engine
 * registered for its connection's kind, and ask it. Nothing here knows how records are kept, and nothing here
 * decides what a filter may say -- the grammar is parsed in `where.ts` so every engine judges one alike.
 */
import type { Atomic } from '@wilanis/core';
import type { Handler } from '@wilanis/engine';
import type { At, Engine, Order, Query, Transaction } from './engine.js';
import { collectionAt, collectionsOf, engineFor } from './store.js';
import { whereOf } from './where.js';

type Input = Record<string, unknown>;
type Ctx = { env: Record<string, unknown> };

/**
 * What every operation starts from: the collection it names, and whoever keeps it.
 *
 * Inside an atomic graph the engine is the transaction's own. The scope opens one on the first call and
 * hands back the same one to every later call on that connection, so the whole graph's records move
 * together; outside one, `env.atomic` is absent and nothing changes.
 */
async function at(input: Input, ctx: Ctx): Promise<{ at: At; engine: Engine }> {
  const collection = collectionAt(ctx.env, input.store, input.collection);
  const engine = engineFor(ctx.env, collection);
  const scope = ctx.env.atomic as Atomic | undefined;
  if (!scope) return { at: collection, engine };
  if (!engine.begin)
    throw new Error(
      `the engine keeping '${collection.connection}' cannot take part in a transaction, so an atomic graph cannot write through it`,
    );
  const joined = await scope.join<Transaction>(collection.connection, async () => {
    const opened = await engine.begin?.(collection);
    if (!opened)
      throw new Error(`the engine keeping '${collection.connection}' opened no transaction for an atomic graph`);
    return opened;
  });
  return { at: collection, engine: joined.engine };
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

const newKey: Handler = async ({ in: input, ctx }) => {
  const { at: where, engine } = await at(input, ctx);
  return engine.newKey(where);
};

const NOTHING_MADE = { collections: 0, columns: 0, constraints: 0 };

/**
 * What the engine made ready, or zeros. The counts are what was *created*, never what the store declares, so a
 * second run answers zeros and so does an engine with nothing to create -- that is what makes them worth
 * printing at startup: a line that says three collections were made says something a line saying three are
 * declared does not.
 */
const ensure: Handler = async ({ in: input, ctx }) => {
  const collections = collectionsOf(ctx.env, input.store);
  if (!collections.length) return { ...NOTHING_MADE };
  const made = await engineFor(ctx.env, collections[0]).ensure(collections);
  return { ...NOTHING_MADE, ...made };
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
