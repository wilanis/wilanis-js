/**
 * Every store of the tree lowered and gathered by the connection it sits on (RFC 0017, *Several connections*).
 * A plan is per connection because a transaction is, and two stores of two features may name one connection --
 * so what is planned is never a store but the collections every store of that connection declares together.
 *
 * Nothing here opens anything or asks an engine a question: it reads the documents the tree already holds,
 * through the same `storeFor` every operation of this plugin reads a store with, and hands the planner what it
 * takes. What a connection is called to a reader is here too, since a target says which engine it is against.
 */
import type { ConnectionDoc, Loaded, MigrateContext, StoreDoc } from '@wilanis/core';
import type { Lowering } from './ensure.js';
import type { Declaring } from './plan.js';
import type { On } from './record.js';
import { storeFor } from './store.js';

/** One connection and everything every store of the tree declares over it, ready for the one planner. */
export interface Gathered {
  on: On;
  /** what the operator reads as the engine behind it: the connection kind, and the plugin that grants it */
  engine: string;
  lowering: Lowering;
}

/**
 * A lowering whose collections are this module's own object and never the store document's, so gathering a
 * second store onto a connection adds to the gathering and never to the tree the runtime is still holding.
 */
function taken(lowering: Lowering): Lowering {
  const declaring: Declaring = { ...lowering.declaring, collections: { ...lowering.declaring.collections } };
  return { ...lowering, declaring };
}

/**
 * Which engine keeps these records, as a reader sees it: the connection kind, and the plugin that grants it.
 * Who implements a thing is never a code detail, so a target says the package the way a native port does.
 */
function engineSaid(store: Loaded<StoreDoc>, ctx: MigrateContext): string {
  const connection = ctx.scope.get('connection', store.doc.connection);
  const kindRef = (connection?.doc as ConnectionDoc | undefined)?.kind;
  const kind = kindRef ? ctx.scope.get('connection-kind', kindRef) : undefined;
  if (!kind) return 'no engine';
  return kind.native ? `${kind.path}, granted by ${kind.native}` : kind.path;
}

/**
 * The stores a plan is made of, one entry per connection, in the order of the canonical paths -- which is the
 * order the runtime prints and applies them in, so what a connection's plan is judged against is what the
 * operator read a line earlier.
 *
 * A store whose connection the tree does not hold is skipped rather than thrown over: the checker refuses such
 * a tree (R001, X203) long before `migrate` loads it, so reaching one here means a plugin failed to load and
 * the other connections are still worth planning.
 */
export function gathered(ctx: MigrateContext): Gathered[] {
  const byConnection = new Map<string, Gathered>();
  for (const store of ctx.registry.all('store')) {
    const lowering = lowered(ctx, store);
    if (!lowering) continue;
    const held = byConnection.get(lowering.on.connection);
    if (held) Object.assign(held.lowering.declaring.collections, lowering.declaring.collections);
    else byConnection.set(lowering.on.connection, { on: lowering.on, engine: engineSaid(store, ctx), lowering });
  }
  return [...byConnection.values()].sort((one, other) => one.on.connection.localeCompare(other.on.connection));
}

/** One store lowered, or nothing where the tree cannot answer for it -- which the checker refused before this ran. */
function lowered(ctx: MigrateContext, store: Loaded<StoreDoc>): Lowering | undefined {
  try {
    return taken(storeFor(ctx.env, store.path));
  } catch {
    return undefined;
  }
}
