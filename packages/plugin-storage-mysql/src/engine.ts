/**
 * Records in MySQL, through Kysely over mysql2. One pool per connection, made at the first operation and
 * destroyed by the teardown `postLoad` hands back (`pools.ts`); a transaction holds one session of it.
 *
 * What this engine answers is what @storage asks of every engine, and the shared suite is what "alike" means:
 * the same filter answers the same records here, in memory, in PostgreSQL and in SQLite. What it does
 * differently is everything below the interface -- a collection is an InnoDB table, a field is a column, and a
 * constraint the store declares is a constraint the database holds.
 *
 * MySQL has no `RETURNING`. `put` answers the record it wrote (`writes.ts`); `patch` is the `UPDATE` and a
 * `SELECT` by key, and `remove` a `SELECT ... FOR UPDATE` by key and the `DELETE`, each pair in one short
 * transaction -- or in the transaction already open, for an engine `begin` made.
 */
import type {
  At,
  Engine,
  On,
  PatchAnswer,
  Put,
  Query,
  Record_,
  RemoveAnswer,
  Scope,
  Transaction,
  Where,
  Written,
} from '@wilanis/plugin-storage';
import type { Kysely } from 'kysely';
import { typeOf } from './columns.js';
import { ensureTables } from './ensure.js';
import { conditionOf, orderingsOf } from './filter.js';
import { reserve, seedKeys, uuidv7 } from './keys.js';
import { type Pools, short } from './pools.js';
import { changedOf, columnsOf, keyIn, recordOf, rowOf } from './rows.js';
import { isIdentity, type Settings } from './settings.js';
import { Unrecorded } from './unrecorded.js';
import { removeViolation, writeViolation } from './violations.js';
import { insertNew, rowAt, upsert } from './writes.js';

type Row = Record<string, unknown>;

/** The most rows MySQL is asked for where a find skips some and takes the rest: it reads no `OFFSET` without a `LIMIT`. */
const EVERY_ROW = Number.MAX_SAFE_INTEGER;

/**
 * A collection asked about under a scope fails the node rather than answering every scope's rows: keeping a
 * scope (RFC 0015) is RFC 0022's eighth step for this engine, and an engine that ignored one would hand one
 * tenant another's records.
 */
function unscoped(at: At, scope: Scope | undefined): void {
  if (scope !== undefined)
    throw new Error(`'${at.name}' is kept under a scope, and the mysql engine keeps no scope yet (RFC 0022, step 8)`);
}

/** An @storage engine keeping records in the InnoDB tables of one MySQL database. */
export class MysqlEngine extends Unrecorded implements Engine {
  /**
   * `on` is the session a transaction runs on, absent everywhere else. An engine made with one is the same
   * engine in every respect but where its statements go: to that session, so every call is inside the
   * transaction it began.
   */
  constructor(
    private readonly pools: Pools,
    private readonly settings: Settings,
    private readonly on?: Kysely<never>,
  ) {
    super();
  }

  /** Where this connection's statements run: the transaction's session, or the pool. */
  private db(at: On): Kysely<never> {
    return this.on ?? this.pools.for(at);
  }

  /** Run statements that read and write together: in the transaction already open, or in a short one of their own. */
  private together<T>(at: On, work: (db: Kysely<never>) => Promise<T>): Promise<T> {
    return this.on ? work(this.on) : short(this.pools.for(at), work);
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
    return { record: recordOf(await rowAt(this.db(at), at, key), at) };
  }

  /** Every record the query matches, in the order asked for and cut to the page asked for. */
  async find(at: At, query: Query) {
    unscoped(at, query.scope);
    let select = this.selecting(at, query.where);
    for (const one of orderingsOf(query.order, at.shape)) select = select.orderBy(one as never) as never;
    if (query.limit !== undefined || query.offset !== undefined)
      select = select.limit(query.limit ?? EVERY_ROW) as never;
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
    const answer = (await query.executeTakeFirst()) as { n: number | string } | undefined;
    return Number(answer?.n ?? 0);
  }

  /**
   * Write the whole record under its own key; with `replace` false, write nothing where one is there. A
   * `unique` or a `refs` the database refuses is answered as the `violated` the port promises.
   */
  async put(at: At, given: Record_, { replace, scope }: Put) {
    unscoped(at, scope);
    const values = rowOf(given, at);
    return this.answering(at, { conflict: false }, async db => {
      if (replace) await upsert(db, at, values);
      else if (!(await insertNew(db, at, values))) return { conflict: true };
      return { record: recordOf(values, at), conflict: false };
    });
  }

  /**
   * Run one write, and answer a `unique` or a `refs` the database refused as the `violated` the port promises,
   * beside what the operation answers when nothing was written (`refused`). Anything else the write throws
   * passes up. `put` and `patch` share it, so the two name a violation alike.
   */
  private async answering<T>(
    at: At,
    refused: T,
    write: (db: Kysely<never>) => Promise<T>,
  ): Promise<T | (T & { violated: string })> {
    try {
      return await write(this.db(at));
    } catch (error) {
      const violated = writeViolation(error, at);
      if (violated) return { ...refused, violated };
      throw error;
    }
  }

  /**
   * The record after the change, or `record` absent where the collection holds none under that key: the
   * `UPDATE` and the `SELECT` by key in one transaction. A change that repeats a declared `unique` or points a
   * `refs` at no record writes nothing and answers `violated`, named as `put` names it.
   */
  async patch(at: At, key: unknown, changes: Record_, written?: Written): Promise<PatchAnswer> {
    unscoped(at, written?.scope);
    const values = changedOf(changes, at);
    if (!Object.keys(values).length) return this.get(at, key);
    return this.answering<PatchAnswer>(at, {}, () =>
      this.together(at, async db => {
        await db
          .updateTable(at.name as never)
          .set(values as never)
          .where(at.key as never, '=', keyIn(at, key) as never)
          .execute();
        return { record: recordOf(await rowAt(db, at, key), at) };
      }),
    );
  }

  /**
   * Remove the record under that key and answer it: the row read and locked, then deleted, in one transaction.
   * A record another table still references is kept by the database's own foreign key (`ON DELETE RESTRICT`),
   * and the collection holding it is answered as `referencedBy`.
   */
  async remove(at: At, key: unknown, scope?: Scope): Promise<RemoveAnswer> {
    unscoped(at, scope);
    try {
      return await this.together(at, async db => {
        const before = recordOf(await rowAt(db, at, key, true), at);
        if (!before) return { removed: false };
        await db
          .deleteFrom(at.name as never)
          .where(at.key as never, '=', keyIn(at, key) as never)
          .execute();
        return { record: before, removed: true };
      });
    } catch (error) {
      const referencedBy = removeViolation(error, at);
      if (!referencedBy) throw error;
      return { record: (await this.get(at, key)).record, removed: false, referencedBy };
    }
  }

  /**
   * A key no record has: a uuidv7 where the key is a string, a number reserved from `wilanis_keys` where it is
   * a number under `identity`. Any other pairing is what X242 refuses at check time, so what is left here is
   * the honest run-time message for a plugin loaded without its rules.
   */
  async newKey(at: At) {
    const type = typeOf(at.shape, at.key)?.kind;
    const identity = isIdentity(this.settings);
    if (type === 'string' && !identity) return uuidv7();
    if (type === 'number' && identity) {
      const seed = `${at.connection} ${at.name}`;
      if (!this.pools.seeded.has(seed)) await seedKeys(this.pools.for(at), at.name);
      this.pools.seeded.add(seed);
      return this.together(at, db => reserve(db, at));
    }
    throw new Error(
      `newKey: keyType '${this.settings.keyType ?? 'uuidv7'}' answers no key for '${at.key}', which is ${type ?? 'of no known type'}`,
    );
  }

  /**
   * Create every table, column and constraint the store declares that is not there yet, and count each. It runs
   * on the pool even for an engine `begin` made, since MySQL commits whatever transaction a session holds
   * before a `CREATE` or an `ALTER`.
   */
  async ensure(collections: At[]) {
    if (!collections.length) return { collections: 0, columns: 0, constraints: 0 };
    return ensureTables(this.pools.for(collections[0]), collections, this.settings);
  }

  /** `START TRANSACTION` on a session of the connection's pool, and the engine that runs on it. */
  async begin(at: At): Promise<Transaction> {
    const trx = await this.pools.transaction(at);
    return {
      engine: new MysqlEngine(this.pools, this.settings, trx),
      commit: () => this.pools.end(trx, 'commit'),
      rollback: () => this.pools.end(trx, 'rollback'),
    };
  }
}
