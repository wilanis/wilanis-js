/**
 * Records in one SQLite file, through Kysely over better-sqlite3. One handle per connection for every statement
 * outside a transaction, opened on first use and closed by the teardown `postLoad` hands back; a transaction
 * opens a handle of its own (`handles.ts`).
 *
 * What this engine answers is what @storage asks of every engine, and the shared suite is what "alike" means:
 * the same filter answers the same records here, in memory and in PostgreSQL. What it does differently is
 * everything below the interface -- a collection is a table, a field is a column, and a constraint the store
 * declares is a constraint the file holds.
 *
 * The driver is synchronous: a statement runs to its end on the event loop. That is the price of SQLite, and
 * the reason this kind is the development database rather than the production one.
 */
import type { At, Engine, Put, Query, Record_, Scope, Transaction, Where, Written } from '@wilanis/plugin-storage';
import type { Kysely } from 'kysely';
import { typeOf } from './columns.js';
import { ensureTables } from './ensure.js';
import { conditionOf, orderingsOf } from './filter.js';
import { type Handles, locked } from './handles.js';
import { reserve, uuidv7 } from './keys.js';
import { changedOf, columnsOf, keyIn, recordOf, rowOf } from './rows.js';
import { isIdentity, type Settings } from './settings.js';
import { Unrecorded } from './unrecorded.js';
import { removeViolation, writeViolation } from './violations.js';

type Row = Record<string, unknown>;

/**
 * A collection asked about under a scope fails the node rather than answering every scope's rows: keeping a
 * scope (RFC 0015) is RFC 0022's sixth step for this engine, and an engine that ignored one would hand one
 * tenant another's records.
 */
function unscoped(at: At, scope: Scope | undefined): void {
  if (scope !== undefined)
    throw new Error(`'${at.name}' is kept under a scope, and the sqlite engine keeps no scope yet (RFC 0022, step 6)`);
}

/** An @storage engine keeping records in the tables of one SQLite file. */
export class SqliteEngine extends Unrecorded implements Engine {
  /**
   * `on` is the handle a transaction runs on, absent everywhere else. An engine made with one is the same
   * engine in every respect but where its statements go: to that handle, so every call is inside the
   * transaction it began.
   */
  constructor(
    private readonly handles: Handles,
    private readonly settings: Settings,
    private readonly on?: Kysely<never>,
  ) {
    super();
  }

  /** The handle this collection's statements run on. */
  private db(at: At): Kysely<never> {
    return this.on ?? this.handles.for(at);
  }

  /** A select of every column of the collection, filtered as the caller asked. */
  private selecting(at: At, where: Where | undefined) {
    const query = this.db(at)
      .selectFrom(at.name as never)
      .select(columnsOf(at) as never);
    return where ? query.where(eb => conditionOf(eb as never, where, at.shape) as never) : query;
  }

  /** The record under that key, or `record` absent where the collection holds none. */
  async get(at: At, key: unknown, scope?: Scope) {
    unscoped(at, scope);
    const found = await this.selecting(at, undefined)
      .where(at.key as never, '=', keyIn(at, key) as never)
      .executeTakeFirst();
    return { record: recordOf(found as Row | undefined, at) };
  }

  /** Every record the query matches, in the order asked for and cut to the page asked for. */
  async find(at: At, query: Query) {
    unscoped(at, query.scope);
    let select = this.selecting(at, query.where);
    for (const one of orderingsOf(query.order, at.shape)) select = select.orderBy(one as never) as never;
    if (query.limit !== undefined || query.offset !== undefined) select = select.limit(query.limit ?? -1) as never;
    if (query.offset !== undefined) select = select.offset(query.offset) as never;
    const rows = (await select.execute()) as Row[];
    return rows.map(one => recordOf(one, at) as Record_);
  }

  /** How many records the filter matches. */
  async count(at: At, where: Where | undefined, scope?: Scope) {
    unscoped(at, scope);
    let query = this.db(at)
      .selectFrom(at.name as never)
      .select(eb => eb.fn.countAll().as('n'));
    if (where) query = query.where(eb => conditionOf(eb as never, where, at.shape) as never) as never;
    const answer = (await query.executeTakeFirst()) as { n: number } | undefined;
    return Number(answer?.n ?? 0);
  }

  /**
   * Write the whole record under its own key; with `replace` false, write nothing where one is there. A
   * `unique` or a `refs` the file refuses is answered as the `violated` the port promises, read back from
   * what SQLite says it refused.
   */
  async put(at: At, given: Record_, { replace, scope }: Put) {
    unscoped(at, scope);
    const db = this.db(at);
    const values = rowOf(given, at);
    try {
      const written = await db
        .insertInto(at.name as never)
        .values(values as never)
        .onConflict(oc =>
          replace ? oc.column(at.key as never).doUpdateSet(values as never) : oc.column(at.key as never).doNothing(),
        )
        .returning(columnsOf(at) as never)
        .executeTakeFirst();
      if (!written) return { conflict: true };
      return { record: recordOf(written as Row, at), conflict: false };
    } catch (error) {
      const violated = await writeViolation(error, db, at, given);
      if (violated) return { conflict: false, violated };
      throw error;
    }
  }

  /** The record after the change, or `record` absent where the collection holds none under that key. */
  async patch(at: At, key: unknown, changes: Record_, written?: Written) {
    unscoped(at, written?.scope);
    const values = changedOf(changes, at);
    if (!Object.keys(values).length) return this.get(at, key);
    const after = await this.db(at)
      .updateTable(at.name as never)
      .set(values as never)
      .where(at.key as never, '=', keyIn(at, key) as never)
      .returning(columnsOf(at) as never)
      .executeTakeFirst();
    return { record: recordOf(after as Row | undefined, at) };
  }

  /**
   * Remove the record under that key and answer it. A record another table still references is kept by the
   * file's own foreign key (`ON DELETE RESTRICT`), and the collection holding it is answered as `referencedBy`.
   */
  async remove(at: At, key: unknown, scope?: Scope) {
    unscoped(at, scope);
    const db = this.db(at);
    try {
      const gone = await db
        .deleteFrom(at.name as never)
        .where(at.key as never, '=', keyIn(at, key) as never)
        .returning(columnsOf(at) as never)
        .executeTakeFirst();
      const before = recordOf(gone as Row | undefined, at);
      return before ? { record: before, removed: true } : { removed: false };
    } catch (error) {
      const referencedBy = await removeViolation(error, db, at, key);
      if (!referencedBy) throw error;
      return { record: (await this.get(at, key)).record, removed: false, referencedBy };
    }
  }

  /**
   * A key no record has: a uuidv7 where the key is a string, a number reserved from `wilanis_keys` where it is
   * a number under `identity`. Any other pairing is what X232 refuses at check time, so what is left here is
   * the honest run-time message for a plugin loaded without its rules.
   */
  async newKey(at: At) {
    const type = typeOf(at.shape, at.key)?.kind;
    const identity = isIdentity(this.settings);
    if (type === 'string' && !identity) return uuidv7();
    if (type === 'number' && identity)
      return this.on ? reserve(this.on, at) : locked(this.db(at), held => reserve(held, at));
    throw new Error(
      `newKey: keyType '${this.settings.keyType ?? 'uuidv7'}' answers no key for '${at.key}', which is ${type ?? 'of no known type'}`,
    );
  }

  /** Create every table, column and constraint the store declares that is not there yet, and count each. */
  async ensure(collections: At[]) {
    if (!collections.length) return { collections: 0, columns: 0, constraints: 0 };
    if (this.on) return ensureTables(this.on, collections, this.settings);
    return locked(this.db(collections[0]), held => ensureTables(held, collections, this.settings));
  }

  /**
   * `BEGIN IMMEDIATE` on a handle of the transaction's own, and the engine that runs on it. The write lock is
   * taken at once, so a second writer waits on the file, up to `busyTimeoutMs`, rather than failing at commit;
   * the handle is closed when the transaction ends either way.
   */
  async begin(at: At): Promise<Transaction> {
    const trx = await this.handles.transaction(at);
    return {
      engine: new SqliteEngine(this.handles, this.settings, trx),
      commit: () => this.handles.end(trx, 'commit'),
      rollback: () => this.handles.end(trx, 'rollback'),
    };
  }
}
