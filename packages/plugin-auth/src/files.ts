/**
 * files.port.json: the guard's memory in files, one JSON file per record under <dir>/<collection>/. It is what a
 * host's binding of state.port.json delegates to for one process, or several sharing a volume; the answers are
 * @storage/store.port.json's, so a binding can move to a store without the guard noticing.
 */
import { isAbsolute, join } from 'node:path';
import type { Handler } from '@wilanis/engine';
import type { Env } from './settings.js';
import { type Store, storeAt } from './store.js';

/** Where records are kept when a delegation names no dir. */
export const DEFAULT_DIR = '.wilanis/auth';

/** The store and collection one call names, the dir taken relative to the tree. */
function named(input: Record<string, unknown>, env: Env): { store: Store; collection: string } {
  const dir = typeof input.dir === 'string' ? input.dir : DEFAULT_DIR;
  const store = storeAt(isAbsolute(dir) ? dir : join(env.root ?? process.cwd(), dir));
  return { store, collection: String(input.collection) };
}

/** A record, or an answer with none. */
const answer = (record: unknown) => (record === undefined ? {} : { record });

/** One record by its key. */
const get: Handler = async ({ in: input, ctx }) => {
  const { store, collection } = named(input, ctx.env as Env);
  return answer(store.get(collection, String(input.key)));
};

/** Write one record whole, under its id, and answer it. */
const put: Handler = async ({ in: input, ctx }) => {
  const { store, collection } = named(input, ctx.env as Env);
  const record = input.record as { id?: unknown };
  if (!record || typeof record.id !== 'string') throw new Error('record: expected an object with a string id');
  store.put(collection, record.id, record);
  return { record };
};

/** Remove one record by its key, and answer it as it was. */
const remove: Handler = async ({ in: input, ctx }) => {
  const { store, collection } = named(input, ctx.env as Env);
  const record = store.get(collection, String(input.key));
  store.delete(collection, String(input.key));
  return answer(record);
};

/** Every record whose field equals the value: a scan over the collection's files. */
const find: Handler = async ({ in: input, ctx }) => {
  const { store, collection } = named(input, ctx.env as Env);
  const field = String(input.field);
  return store
    .list<Record<string, unknown>>(collection)
    .filter(record => String(record[field]) === String(input.equals));
};

/** The handlers of files.port.json, by operation. */
export const files = { get, put, remove, find };
