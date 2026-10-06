/**
 * The turns this process takes on each file. SQLite lets one writer hold a file at a time, and a second writer
 * waits on SQLite's busy handler for up to `busyTimeoutMs`. That wait works between processes. It cannot work
 * inside one: better-sqlite3 is synchronous, so the busy handler sleeps on the event loop, and the handle that
 * holds the lock is waiting on that same event loop to commit. The wait would freeze the process, then fail
 * with 'database is locked'.
 *
 * So a writer of this process waits its turn here, asynchronously, before it reaches the file. It waits for as
 * long as `busyTimeoutMs` says, then fails with SQLite's own words. The setting thus means one thing whoever
 * holds the lock, and a transaction left open by mistake fails the writers behind it rather than hanging them.
 * A transaction takes the turn before its `BEGIN IMMEDIATE` and hands it on when it ends. Every statement on a
 * connection's shared handle takes it for as long as Kysely holds that handle. Two atomic graphs of one process therefore
 * serialise at the file, and a statement outside a transaction never meets another run's open one. The turns
 * are the process's, keyed by the file's resolved path, since the lock they stand for is the file's and not
 * one load's. A writer in another process still meets SQLite's own lock, and waits on its busy handler.
 */
import type { DatabaseConnection, Driver, SqliteDialectConfig, TransactionSettings } from 'kysely';
import { SqliteDialect } from 'kysely';

/** The last turn asked for on each file: a new one starts when it ends. */
const turns = new Map<string, Promise<void>>();

/** What a writer that waited its whole `busyTimeoutMs` for this process's turn fails with. */
const locked = (file: string, waitMs: number) =>
  new Error(
    `database is locked: another transaction of this process held '${file}' for the ${waitMs} ms busyTimeoutMs allows`,
  );

/**
 * Wait for this process's turn on the file, up to `waitMs`, and answer the function that hands it on. A writer
 * that gives up still passes the turn along when the one before it ends, so nobody behind it waits for it.
 */
export async function turnOn(file: string, waitMs: number): Promise<() => void> {
  const before = turns.get(file) ?? Promise.resolve();
  let release = () => {};
  const mine = new Promise<void>(resolve => {
    release = resolve;
  });
  const last = before.then(() => mine);
  turns.set(file, last);
  const handOn = () => {
    release();
    if (turns.get(file) === last) turns.delete(file);
  };
  let timer: NodeJS.Timeout | undefined;
  const gaveUp = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(locked(file, waitMs)), waitMs);
  });
  try {
    await Promise.race([before, gaveUp]);
    return handOn;
  } catch (error) {
    void before.then(handOn);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Kysely's SQLite driver, taking the file's turn each time it hands out its one connection. */
class TurnTakingDriver implements Driver {
  /** Hands on the turn the connection now handed out holds. There is one connection, so there is one turn. */
  private handOn = () => {};

  /** `inner` is Kysely's own driver over the handle, open on `file`; `waitMs` is how long a turn is waited for. */
  constructor(
    private readonly inner: Driver,
    private readonly file: string,
    private readonly waitMs: number,
  ) {}

  /** Open the handle, as Kysely's driver does. */
  init(): Promise<void> {
    return this.inner.init();
  }

  /**
   * The handle's one connection, once Kysely's own queue and then the file's turn have reached this caller. A
   * turn not reached in time hands the connection back and fails the statement.
   */
  async acquireConnection(): Promise<DatabaseConnection> {
    const connection = await this.inner.acquireConnection();
    try {
      this.handOn = await turnOn(this.file, this.waitMs);
    } catch (error) {
      await this.inner.releaseConnection(connection);
      throw error;
    }
    return connection;
  }

  /** Hand on the file's turn, then the connection. */
  async releaseConnection(connection: DatabaseConnection): Promise<void> {
    this.handOn();
    await this.inner.releaseConnection(connection);
  }

  /** Begin a Kysely transaction on the connection, as Kysely's driver does. */
  beginTransaction(connection: DatabaseConnection, settings: TransactionSettings): Promise<void> {
    return this.inner.beginTransaction(connection, settings);
  }

  /** Commit a Kysely transaction on the connection, as Kysely's driver does. */
  commitTransaction(connection: DatabaseConnection): Promise<void> {
    return this.inner.commitTransaction(connection);
  }

  /** Roll back a Kysely transaction on the connection, as Kysely's driver does. */
  rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    return this.inner.rollbackTransaction(connection);
  }

  /** Close the handle, as Kysely's driver does. */
  destroy(): Promise<void> {
    return this.inner.destroy();
  }
}

/** Kysely's SQLite dialect, whose every statement waits for this process's turn on the file. */
export class TurnTakingDialect extends SqliteDialect {
  /** `file` is the resolved path the handle in `config` is open on; `waitMs` is how long a turn is waited for. */
  constructor(
    config: SqliteDialectConfig,
    private readonly file: string,
    private readonly waitMs: number,
  ) {
    super(config);
  }

  /** Kysely's driver, wrapped to take the file's turn. */
  override createDriver(): Driver {
    return new TurnTakingDriver(super.createDriver(), this.file, this.waitMs);
  }
}
