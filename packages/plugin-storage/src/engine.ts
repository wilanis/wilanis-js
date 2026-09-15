/**
 * What an engine is, and how @storage finds one. An engine keeps records; it is a plugin of its own, and it
 * depends on this package for the contract while this package depends on no engine -- the arrow points the
 * way every other arrow in the workspace does.
 *
 * The seam is the hook plugins already have: an engine's `postLoad` registers itself, under the connection
 * kind it grants, in a table the environment carries. The table is created on first use by whichever side
 * reaches it first, so nothing has to be said in `project.json` about the order the plugins are named in.
 */
import type { Participant, Type } from '@wilanis/core';
import type { Where } from './where.js';

/** One record, as it is kept and as it comes back: an object of the collection's shape. */
export type Record_ = Record<string, unknown>;

/**
 * One reference between two collections of a store: a field of `from` holds the key of `to`. Every collection
 * carries both the references it makes and the ones made to it, so `put` can judge what it writes and
 * `remove` what would be orphaned without either one reading the store document again.
 */
export interface Ref {
  /** the collection the field belongs to */
  from: string;
  /** the field of it that holds the other collection's key */
  field: string;
  /** the collection whose key that field holds */
  to: string;
}

/** One ordering of a find: the field, and the direction. */
export interface Order {
  by: string;
  dir?: 'asc' | 'desc';
}

/** What a find asks for beyond the collection: which records, in what order, and how much of the answer. */
export interface Query {
  where?: Where;
  order?: Order[];
  limit?: number;
  offset?: number;
}

/**
 * A collection as an engine sees it: where its records live, what it is called there, the shape they have and
 * the field that identifies one. A collection is named by the pair (connection, name), never by the store
 * document, so two features declaring the same name over one connection mean the same collection.
 */
export interface At {
  /** the connection document's canonical path */
  connection: string;
  /** the connection kind, so an engine kept per kind knows what it was reached as */
  kind: string;
  /** the connection's settings, secrets already substituted */
  settings: Record<string, unknown>;
  /** the collection's name, which is the name the records are kept under */
  name: string;
  /** the record type */
  shape: Type;
  /** the field of the shape that identifies a record */
  key: string;
  /** the combinations no two records may repeat, each one constraint over those fields together */
  unique: string[][];
  /** the references this collection makes: a field of it holding another collection's key */
  refs: Ref[];
  /** the references made to it, by whichever collections of the store hold its key */
  referenced: Ref[];
  /**
   * field -> what a row already there receives when `ensure` adds that field's column. It is about existing
   * rows and nothing else: a `put` always gives the whole record, so no engine ever reads this on a write.
   */
  defaults: Record<string, unknown>;
}

/** What an `ensure` made: what it created, never what was already there. */
export interface Made {
  /** collections created */
  collections: number;
  /** columns created, in tables new and old */
  columns: number;
  /** constraints created */
  constraints: number;
}

/** What a put answers: the record as stored, or the constraint that stopped it. */
export interface PutAnswer {
  record?: Record_;
  conflict: boolean;
  violated?: string;
}

/** What a remove answers: the record that was removed, or the collection still referencing it. */
export interface RemoveAnswer {
  record?: Record_;
  removed: boolean;
  referencedBy?: string;
}

/** What @storage asks of whoever keeps the records. No SQL, no dialect, no driver: values in, values out. */
export interface Engine {
  /** The record under that key, or `record` absent where there is none. */
  get(at: At, key: unknown): Promise<{ record?: Record_ }>;
  /** Every record the query matches, in the order it asks for. */
  find(at: At, query: Query): Promise<Record_[]>;
  /** How many records the filter matches. */
  count(at: At, where: Where | undefined): Promise<number>;
  /**
   * Write the whole record under its own key; with `replace` false, write nothing where one is already there.
   * A declared `unique` another record already holds, or a `refs` naming a record that is not there, is
   * answered as `violated` rather than thrown: a constraint the store declares is the opposite of unforeseen.
   */
  put(at: At, record: Record_, replace: boolean): Promise<PutAnswer>;
  /** Change some fields of the record under that key, or answer `record` absent where there is none. */
  patch(at: At, key: unknown, changes: Record_): Promise<{ record?: Record_ }>;
  /**
   * Remove the record under that key and answer it, or `record` absent where there was none. A record another
   * still references by a declared `refs` is kept, and the collection that references it is answered.
   */
  remove(at: At, key: unknown): Promise<RemoveAnswer>;
  /** A key no record of the collection has, of the type the collection's key field declares. */
  newKey(at: At): Promise<unknown>;
  /**
   * Create every collection that is not there yet and leave alone every one that is, and say how much was
   * made. The counts are the engine's own account of what it did -- zero on a second run, and zero everywhere
   * for an engine with nothing to create. What `@storage/storage.port.json#ensure` answers a graph is still
   * `collections`, the number the store declares; widening that is RFC 0003 step 6's.
   */
  ensure(collections: At[]): Promise<Made | undefined>;
  /**
   * Begin a transaction on one connection and answer what runs inside it: an engine of the same shape whose
   * every call is part of the transaction, and the way to end it. An engine that cannot do this answers
   * nothing, and @storage refuses the run rather than writing outside the transaction a graph declared.
   *
   * @storage calls this at most once per atomic run, through `env.atomic`: the scope memoises it, so an
   * engine is never asked to nest one transaction inside another.
   */
  begin?(at: At): Promise<Transaction | undefined>;
}

/** A transaction an engine opened: the engine that runs inside it, and the two ways it can end. */
export interface Transaction extends Participant {
  /** The same engine, every call of it inside the transaction. */
  engine: Engine;
}

/** The engines registered under one environment, by the connection kind each was registered for. */
export class Engines {
  private readonly byKind = new Map<string, Engine>();

  /** Take an engine in, under the canonical path of the connection kind its plugin grants. */
  register(kind: string, engine: Engine): void {
    this.byKind.set(kind, engine);
  }

  /** The engine registered for a connection kind, or nothing where no plugin registered one. */
  for(kind: string): Engine | undefined {
    return this.byKind.get(kind);
  }

  /** Every kind an engine registered for, so a message can say what this tree can reach. */
  get kinds(): string[] {
    return [...this.byKind.keys()];
  }
}

/** Every table in play, one per environment, so nothing is global and a reload starts clean. */
const tables = new WeakMap<object, Engines>();

/**
 * What one environment is keyed by. The embedder hands a handler `{ ...env, blobs }` whenever a run carries a
 * blob scope -- the http listener does on every request -- so the object a handler is given is not the object
 * an engine registered on. `connections` is built once for the tree by `buildEnv` and carried by every copy,
 * so it names the environment where the copy does not. An environment without one is keyed by itself.
 */
function keyOf(env: object): object {
  const connections = (env as { connections?: unknown }).connections;
  return connections && typeof connections === 'object' ? connections : env;
}

/**
 * The engines of one environment, created on first use by whichever side reaches it first. @storage builds
 * nothing in its own `postLoad`, so an engine that registers before @storage is loaded finds no emptier a
 * table than one that registers after. A handler reaching it through a copy of the environment finds the
 * table the engine registered in, since both are keyed by the tree's `connections`.
 */
export function engines(env: object): Engines {
  const key = keyOf(env);
  let table = tables.get(key);
  if (!table) {
    table = new Engines();
    tables.set(key, table);
  }
  return table;
}
