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
import type {
  At,
  Engine,
  PatchAnswer,
  Put,
  Query,
  Record_,
  Scope,
  Transaction,
  Where,
  Written,
} from '@wilanis/plugin-storage';
import type { Kysely, OnConflictBuilder } from 'kysely';
import { typeOf } from './columns.js';
import { ensureTables } from './ensure.js';
import { conditionOf, orderingsOf } from './filter.js';
import { locked } from './handles.js';
import { reserve, uuidv7 } from './keys.js';
import { SqliteRecorder } from './recorder.js';
import { changedOf, columnsOf, keyIn, recordOf, rowOf } from './rows.js';
import { keepScope, scopeColumns, scopeValues, within, withoutScope } from './scoping.js';
import { isIdentity } from './settings.js';
import { removeViolation, writeViolation } from './violations.js';

type Row = Record<string, unknown>;

/** An @storage engine keeping records in the tables of one SQLite file. */
export class SqliteEngine extends SqliteRecorder implements Engine {
  /**
   * The handle this collection's statements run on. An engine made with a transaction's handle (`trx`) is the
   * same engine in every respect but where its statements go: to that handle, so every call is inside the
   * transaction it began.
   */
  private db(at: At): Kysely<never> {
    return this.trx ?? this.handles.for(at);
  }

  /**
   * The handle, with the table made ready to be narrowed by this scope (`scoping.ts`): every statement below
   * carries the predicate, so every one of them has to know the columns are there. A scope column is not part
   * of what the store declares, so `ensure` never makes one and the first statement that names a scope does.
   */
  private async scoped(at: At, scope: Scope | undefined): Promise<Kysely<never>> {
    const db = this.db(at);
    await keepScope({ db, owner: this.handles, lasting: !this.trx }, at, scope);
    return db;
  }

  /**
   * A select of every column of the collection, filtered as the caller asked and narrowed to the scope. No
   * scope adds a predicate that holds of every row, which is how a view -- and an unscoped collection -- sees
   * every row.
   */
  private selecting(at: At, where: Where | undefined, scope: Scope | undefined) {
    const query = this.db(at)
      .selectFrom(at.name as never)
      .select(columnsOf(at) as never)
      .where(eb => within(eb as never, scope) as never);
    return where ? query.where(eb => conditionOf(eb as never, where, at.shape) as never) : query;
  }

  /** The record under that key within the scope, or `record` absent where the collection holds none. */
  async get(at: At, key: unknown, scope?: Scope) {
    await this.scoped(at, scope);
    const found = await this.selecting(at, undefined, scope)
      .where(at.key as never, '=', keyIn(at, key) as never)
      .executeTakeFirst();
    return { record: recordOf(found as Row | undefined, at) };
  }

  /** Every record of the scope the query matches, in the order asked for and cut to the page asked for. */
  async find(at: At, query: Query) {
    await this.scoped(at, query.scope);
    let select = this.selecting(at, query.where, query.scope);
    for (const one of orderingsOf(query.order, at.shape)) select = select.orderBy(one as never) as never;
    if (query.limit !== undefined || query.offset !== undefined) select = select.limit(query.limit ?? -1) as never;
    if (query.offset !== undefined) select = select.offset(query.offset) as never;
    const rows = (await select.execute()) as Row[];
    return rows.map(one => recordOf(one, at) as Record_);
  }

  /** How many records of the scope the filter matches. */
  async count(at: At, where: Where | undefined, scope?: Scope) {
    const db = await this.scoped(at, scope);
    let query = db
      .selectFrom(at.name as never)
      .select(eb => eb.fn.countAll().as('n'))
      .where(eb => within(eb as never, scope) as never);
    if (where) query = query.where(eb => conditionOf(eb as never, where, at.shape) as never) as never;
    const answer = (await query.executeTakeFirst()) as { n: number } | undefined;
    return Number(answer?.n ?? 0);
  }

  /**
   * Write the whole record under its own key; with `replace` false, write nothing where one is there. A
   * `unique` or a `refs` the file refuses is answered as the `violated` the port promises, read back from
   * what SQLite says it refused.
   *
   * The scope columns are written beside the record, whatever the record says -- it cannot say anything, since
   * they are not its fields. A key already held under another scope is a `conflict` even with `replace`: the
   * upsert's update is itself narrowed to the scope, so the row of another one is not touched and nothing is
   * returned.
   */
  async put(at: At, given: Record_, { replace, scope }: Put) {
    await this.scoped(at, scope);
    const values = { ...rowOf(given, at), ...scopeValues(scope) };
    return this.answering(at, { given, scope }, { conflict: false }, async db => {
      const written = await db
        .insertInto(at.name as never)
        .values(values as never)
        .onConflict(oc =>
          replace ? this.replacing(oc as never, at, values, scope) : oc.column(at.key as never).doNothing(),
        )
        .returning(columnsOf(at) as never)
        .executeTakeFirst();
      if (!written) return { conflict: true };
      return { record: recordOf(written as Row, at), conflict: false };
    });
  }

  /**
   * The `do update` of a replacing put, narrowed to the scope it is written under. Without a scope it replaces
   * whatever is under the key; with one it replaces only the row of that scope, so a key another scope holds
   * falls through the conflict untouched and `put` answers it as the conflict it is.
   */
  private replacing(oc: OnConflictBuilder<never, never>, at: At, values: Row, scope?: Scope) {
    const update = oc.column(at.key as never).doUpdateSet(values as never);
    return scopeColumns(scope).length ? update.where(eb => within(eb as never, scope, at.name) as never) : update;
  }

  /**
   * Run one write, and answer a `unique` or a `refs` the file refused as the `violated` the port promises,
   * beside what the operation answers when nothing was written (`refused`). `given` is what the write named --
   * the whole record of a put, the changes of a patch -- since a refused reference is found among its fields;
   * `scope` is what it was written under, which a scoped unique names beside the declared fields and the
   * answer does not. Anything else the write throws passes up. `put` and `patch` share it, so the two name a
   * violation alike.
   */
  private async answering<T>(
    at: At,
    { given, scope }: { given: Record_; scope?: Scope },
    refused: T,
    write: (db: Kysely<never>) => Promise<T>,
  ): Promise<T | (T & { violated: string })> {
    const db = this.db(at);
    try {
      return await write(db);
    } catch (error) {
      const violated = await writeViolation(withoutScope(error, scope), db, at, given);
      if (violated) return { ...refused, violated };
      throw error;
    }
  }

  /**
   * The record after the change, or `record` absent where the collection holds none under that key within the
   * scope. A scope column is never among the changes -- it is not a field of the shape -- so the row stays
   * under the scope it was written with. A change that repeats a declared `unique` or points a `refs` at no
   * record writes nothing and answers `violated`, named as `put` names it.
   */
  async patch(at: At, key: unknown, changes: Record_, written?: Written): Promise<PatchAnswer> {
    const scope = written?.scope;
    await this.scoped(at, scope);
    const values = changedOf(changes, at);
    if (!Object.keys(values).length) return this.get(at, key, scope);
    return this.answering<PatchAnswer>(at, { given: changes, scope }, {}, async db => {
      const after = await db
        .updateTable(at.name as never)
        .set(values as never)
        .where(at.key as never, '=', keyIn(at, key) as never)
        .where(eb => within(eb as never, scope) as never)
        .returning(columnsOf(at) as never)
        .executeTakeFirst();
      return { record: recordOf(after as Row | undefined, at) };
    });
  }

  /**
   * Remove the record under that key within the scope and answer it. A record another table still references
   * is kept by the file's own foreign key (`ON DELETE RESTRICT`), and the collection holding it is answered as
   * `referencedBy`; a key of another scope matches nothing, so a remove of it removes nothing.
   */
  async remove(at: At, key: unknown, scope?: Scope) {
    const db = await this.scoped(at, scope);
    try {
      const gone = await db
        .deleteFrom(at.name as never)
        .where(at.key as never, '=', keyIn(at, key) as never)
        .where(eb => within(eb as never, scope) as never)
        .returning(columnsOf(at) as never)
        .executeTakeFirst();
      const before = recordOf(gone as Row | undefined, at);
      return before ? { record: before, removed: true } : { removed: false };
    } catch (error) {
      const referencedBy = await removeViolation(error, db, at, key);
      if (!referencedBy) throw error;
      return { record: (await this.get(at, key, scope)).record, removed: false, referencedBy };
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
      return this.trx ? reserve(this.trx, at) : locked(this.db(at), held => reserve(held, at));
    throw new Error(
      `newKey: keyType '${this.settings.keyType ?? 'uuidv7'}' answers no key for '${at.key}', which is ${type ?? 'of no known type'}`,
    );
  }

  /** Create every table, column and constraint the store declares that is not there yet, and count each. */
  async ensure(collections: At[]) {
    if (!collections.length) return { collections: 0, columns: 0, constraints: 0 };
    if (this.trx) return ensureTables(this.trx, collections, this.settings);
    return locked(this.db(collections[0]), held => ensureTables(held, collections, this.settings));
  }

  /**
   * `BEGIN IMMEDIATE` on a handle of the transaction's own, and the engine that runs on it. The write lock is
   * taken at once, so a second writer waits, up to `busyTimeoutMs`, rather than failing at commit: one of this
   * process waits for its turn on the file (`turns.ts`), one of another process on SQLite's busy handler. The
   * handle is closed when the transaction ends either way.
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
