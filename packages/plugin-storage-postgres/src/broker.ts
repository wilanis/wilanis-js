/**
 * The table broker: @queue's `Broker`, answered with one table in the database a connection of this kind
 * reaches (RFC 0009, *The table broker*). A tree whose stores are kept here needs no second service to have a
 * queue: a queue trigger names the same connection the stores name, and its messages are rows beside theirs.
 *
 * What makes it the store's own rather than a broker that happens to share a database is the transaction. A
 * publish inside an atomic graph joins the transaction that graph's store calls run in -- through the same
 * `atomic.join` on the same connection, opened by this plugin's engine whichever of the two reaches it first --
 * so the message exists exactly when the graph's writes commit: the transactional outbox, with no document
 * naming it.
 *
 * The acknowledgement is not in that transaction, and the RFC says why: the worker acknowledges after the run
 * has answered, so a process that dies between the two leaves the message to be delivered again. At least once,
 * as the kind declares.
 */
import type { Atomic } from '@wilanis/core';
import type { Broker, Handle, Message } from '@wilanis/plugin-queue';
import type { Transaction } from '@wilanis/plugin-storage';
import { TableConsumer } from './consumer.js';
import type { Opened, PostgresEngine } from './engine.js';
import { Listeners } from './listener.js';
import { poolFor, type Settings } from './pool.js';
import { ensureQueue, parkedOn, payloadOf, putMessage, type Table } from './queue-table.js';

/** How long a delivery holds its message before another worker may take it, where the plugin's settings say nothing. */
const VISIBILITY_SECONDS = 30;

/** The connections an environment carries, with their kinds and their settings, secrets substituted. */
type Connections = Record<string, { kind: string; settings: Record<string, unknown> }>;

/**
 * A table the statement named that is not there, said as the step that makes it: the queue table is made by
 * `ensure` and by nothing else, so a tree that publishes or consumes before a startup step prepared the
 * connection is told which step it is missing rather than handed PostgreSQL's words for it.
 */
async function prepared<T>(connection: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if ((error as { code?: unknown }).code !== '42P01') throw error;
    throw new Error(
      `'${connection}' has no queue table: prepare it with @queue/queue.port.json#ensure, from a startup step through a domain operation, before anything publishes to it or consumes it`,
    );
  }
}

/** The broker for every connection of the postgres kind in one environment. */
export class TableBroker implements Broker {
  private readonly listeners = new Listeners();

  /** `env` is read at each call for the connection's settings; `engine` is the one this plugin registered. */
  constructor(
    private readonly env: object,
    private readonly settings: Settings,
    private readonly engine: PostgresEngine,
  ) {}

  /** Create the queue table and its index on the connection, where they are not there; alter nothing that is. */
  async ensure(connection: string): Promise<void> {
    await ensureQueue(this.tableOn(connection));
  }

  /** Keep one message on the queue, on the atomic graph's transaction where there is one; answers its id. */
  async publish(connection: string, queue: string, message: Message, atomic?: Atomic): Promise<{ id: string }> {
    const table = atomic ? await this.inTransaction(connection, atomic) : this.tableOn(connection);
    const put = { queue, body: message.body, headers: message.headers, delayMs: message.delayMs ?? 0 };
    return { id: await prepared(connection, () => putMessage(table, put)) };
  }

  /** Hand the queue's messages to `handle`, at most `concurrency` at once; answers the way to stop and drain. */
  async consume(
    connection: string,
    queue: string,
    handle: Handle,
    opts: { concurrency: number },
  ): Promise<() => Promise<void>> {
    const table = this.tableOn(connection);
    const visibilityMs = (this.settings.queueVisibility ?? VISIBILITY_SECONDS) * 1000;
    const consumer = new TableConsumer({ table, queue, visibilityMs }, handle, opts.concurrency);
    const url = String(this.connectionOf(connection).settings.url);
    await prepared(connection, () =>
      consumer.start(wake => this.listeners.listen(connection, url, payloadOf(table.schema, queue), wake)),
    );
    return () => consumer.stop();
  }

  /** What was parked as dead on a queue of the connection, in the order it was parked, as an operator reads it. */
  parked(connection: string, queue: string): Promise<{ id: string; body: unknown }[]> {
    return prepared(connection, () => parkedOn(this.tableOn(connection), queue));
  }

  /** Close every listening session this broker opened, as the plugin's teardown does. */
  close(): Promise<void> {
    return this.listeners.close();
  }

  /** A connection of this tree, as the environment carries it. */
  private connectionOf(connection: string): { connection: string; kind: string; settings: Record<string, unknown> } {
    const conn = (this.env as { connections?: Connections }).connections?.[connection];
    if (!conn) throw new Error(`queue on '${connection}': not a connection of this tree`);
    return { connection, kind: conn.kind, settings: conn.settings };
  }

  /** The table a connection's messages are kept in, reached through the connection's pool. */
  private tableOn(connection: string): Table {
    return poolFor(this.connectionOf(connection), this.settings);
  }

  /**
   * The table on the atomic graph's transaction: the one already open on the connection, or one this engine
   * opens now and every store call after this publish then joins.
   */
  private async inTransaction(connection: string, atomic: Atomic): Promise<Table> {
    const on = this.connectionOf(connection);
    const joined = await atomic.join<Transaction>(connection, () => this.engine.begin(on));
    const trx = (joined as Partial<Opened>).trx;
    if (!trx)
      throw new Error(`the transaction on '${connection}' was opened by another engine, so a publish cannot join it`);
    return { db: trx, schema: poolFor(on, this.settings).schema };
  }
}
