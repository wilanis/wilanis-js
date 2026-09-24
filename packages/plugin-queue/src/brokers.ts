/**
 * What a broker is, and how @queue finds one: the contract a broker plugin answers, and the table it registers
 * in. @queue speaks no broker's language -- it hands a broker bodies and headers, and is handed deliveries --
 * so an in-process array, a table in the tree's database and a hosted queue are each a package that answers
 * this, and none is a change here.
 *
 * The seam is the one storage engines use (`engines(env)` in @wilanis/plugin-storage): a broker's `postLoad`
 * registers itself under the connection kind it grants, in a table the environment carries, created on first
 * use by whichever side reaches it first -- so the order plugins are named in `project.json` cannot bite, and a
 * reload, which builds a new environment, starts with a table of its own.
 */
import type { Atomic } from '@wilanis/core';

/** One message as a broker hands it to the worker. */
export interface Delivery {
  /** The broker's id for the message, the same on every delivery of it. */
  id: string;
  /** 1 on the first delivery, one more on each redelivery. */
  attempt: number;
  headers: Record<string, string>;
  /** The message as it was published: a JSON value, which the broker encodes however it keeps messages. */
  body: unknown;
}

/** What becomes of a message once its run has ended: done with, delivered again later, or parked for an operator. */
export type Outcome = 'ack' | 'retry' | 'dead';

/** What the worker answers a broker for one delivery: the outcome, and for a retry how long to wait before the next. */
export interface Answer {
  outcome: Outcome;
  /** For `retry`: the least time before the message is delivered again, in milliseconds. */
  backoffMs?: number;
}

/** One message as the worker hands it to a broker to publish. */
export interface Message {
  body: unknown;
  headers: Record<string, string>;
  /** The least time before the message may be delivered, in milliseconds; absent, at once. */
  delayMs?: number;
}

/** What handles one delivery: the worker's run of the trigger, answering the message's outcome. */
export type Handle = (delivery: Delivery) => Promise<Answer>;

/**
 * What a broker does for one connection of the kind it registered. The connection is the canonical path of a
 * connection document; the broker reads `env.connections[connection]` for its settings where it has any.
 */
export interface Broker {
  /** Create what the broker needs to keep queues on the connection, altering nothing that exists; idempotent. */
  ensure(connection: string): Promise<void>;
  /**
   * Put one message on the queue, answering the id every delivery of it will carry.
   *
   * `atomic` is the transaction of the atomic graph the publish runs in, and is handed only where the
   * connection's kind is marked `storage`: the queue is then kept in the store, and the broker keeps the
   * message on the transaction's session through `atomic.join(connection, ...)`, so it exists exactly when the
   * graph's writes commit. One transaction is one connection, so the broker joins with what the storage engine
   * of that connection begins, and a store call after the publish is handed the same participant. A broker of
   * any other kind is never handed one -- X405 refuses the atomic graph, and the handler the run that reaches it
   * -- so a broker that keeps no queue in a store may leave the parameter off.
   */
  publish(connection: string, queue: string, message: Message, atomic?: Atomic): Promise<{ id: string }>;
  /**
   * Hand every message of the queue to `handle`, at most `concurrency` at once, and do with each what the answer
   * says: `ack` forgets it, `retry` delivers it again with `attempt` one higher no sooner than `backoffMs` from
   * now, `dead` parks it where an operator can find it. A `handle` that throws is taken as `retry` with no
   * backoff, so a broker never loses a message to the worker's own failure.
   *
   * Answers the way to stop: calling it takes no further message, and it resolves once every delivery in
   * flight has been answered and what the answer says has been done.
   */
  consume(
    connection: string,
    queue: string,
    handle: Handle,
    opts: { concurrency: number },
  ): Promise<() => Promise<void>>;
}

/** The brokers registered under one environment, by the connection kind each was registered for. */
export class Brokers {
  private readonly byKind = new Map<string, Broker>();

  /** Take a broker in, under the canonical path of the connection kind its plugin grants. */
  register(kind: string, broker: Broker): void {
    this.byKind.set(kind, broker);
  }

  /** The broker registered for a connection kind, or nothing where no plugin registered one. */
  for(kind: string): Broker | undefined {
    return this.byKind.get(kind);
  }

  /** Every kind a broker registered for, so a message can say what this tree can reach. */
  get kinds(): string[] {
    return [...this.byKind.keys()];
  }
}

/** Every table in play, one per environment, so nothing is global and a reload starts clean. */
const tables = new WeakMap<object, Brokers>();

/**
 * What one environment is keyed by. The embedder hands a handler `{ ...env, blobs }` whenever a run carries a
 * blob scope, so the object a handler is given is not the object a broker registered on; `connections` is built
 * once for the tree and carried by every copy, so it names the environment where the copy does not. It is the
 * key `engines(env)` uses, for the same reason.
 */
function keyOf(env: object): object {
  const connections = (env as { connections?: unknown }).connections;
  return connections && typeof connections === 'object' ? connections : env;
}

/**
 * The brokers of one environment, created on first use by whichever side reaches it first. @queue builds
 * nothing in a `postLoad` of its own, so a broker that registers before @queue is loaded finds no emptier a
 * table than one that registers after.
 */
export function brokers(env: object): Brokers {
  const key = keyOf(env);
  let table = tables.get(key);
  if (!table) {
    table = new Brokers();
    tables.set(key, table);
  }
  return table;
}

/** A connection as a handler reads it off the environment: its kind, canonical, and its settings. */
interface Connection {
  kind: string;
  settings: Record<string, unknown>;
}

/** One broker connection resolved: the canonical path a broker is asked about, its kind, and the broker. */
export interface Reached {
  connection: string;
  kind: string;
  broker: Broker;
}

/**
 * The broker behind a connection a document names: the connection resolved as every handler resolves one
 * (`env.canon`, then `env.connections`), and the broker registered for its kind. The checker has judged the
 * tree by now, so a connection that is not one, or a kind no broker answers, is a plugin that did not load --
 * and the message names what to add rather than what to edit.
 */
export function brokerFor(env: Record<string, unknown>, named: unknown, asking: string): Reached {
  const canon = (env.canon as ((ref: string) => string) | undefined) ?? ((ref: string) => ref);
  const connection = canon(String(named));
  const found = (env.connections as Record<string, Connection> | undefined)?.[connection];
  if (!found) throw new Error(`'${asking}' was given connection '${named}', which is not a connection of this tree`);
  const broker = brokers(env).for(found.kind);
  if (broker) return { connection, kind: found.kind, broker };
  const registered = brokers(env).kinds.join(', ') || 'none';
  throw new Error(
    `no broker for connection '${connection}', of kind '${found.kind}': add the package that grants that kind to project.json -> plugins, which registers a broker from its postLoad (registered: ${registered})`,
  );
}
