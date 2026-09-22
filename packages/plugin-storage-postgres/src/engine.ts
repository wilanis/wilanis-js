/**
 * Records in PostgreSQL, through Kysely. One pool per connection document, made on first use and destroyed by
 * the teardown `postLoad` hands back, so a tree that never reaches a store opens no socket.
 *
 * What this engine answers is what @storage asks of every engine, and the shared suite is what "alike" means:
 * the same filter answers the same records here and in memory. What it does differently is everything below
 * the interface -- a collection is a table, a field is a column, and a constraint the store declares is a
 * constraint the database holds.
 */
import { randomUUID } from 'node:crypto';
import { conforms } from '@wilanis/core';
import type {
  Applied,
  Applying,
  At,
  Declared,
  Engine,
  FieldType,
  On,
  Put,
  Query,
  Record_,
  Recording,
  Scope,
  Step,
  Transaction,
  Where,
  Written,
} from '@wilanis/plugin-storage';
import type { Kysely, OnConflictBuilder } from 'kysely';
import { applyPlan } from './apply.js';
import { attempts } from './casts.js';
import { fieldsOf, folded, isJson } from './columns.js';
import { countFor } from './counting.js';
import { ensureTables } from './ensure.js';
import { conditionOf, orderingsOf } from './filter.js';
import { inspectTable } from './inspect.js';
import { refName, scopedUniqueName, uniqueName } from './names.js';
import { poolFor, type Settings } from './pool.js';
import { currentOf, ensureRecord, historyOf } from './record.js';
import { ensureScope, scopeColumns, scopeValues, within } from './scoping.js';

/** What a row becomes on its way back out: the record the shape describes, or the reason it is not one. */
function record(row: Record<string, unknown> | undefined, at: At): Record_ | undefined {
  if (!row) return undefined;
  const out: Record_ = {};
  for (const field of fieldsOf(at.shape)) {
    const value = row[folded(field.name)];
    if (value === null || value === undefined) continue;
    out[field.name] = field.type.kind === 'number' ? Number(value) : value;
  }
  const bad = conforms(out, at.shape, at.name);
  if (bad) throw new Error(`${at.name}: a row this collection holds is no longer of its shape: ${bad}`);
  return out;
}

/**
 * What a record becomes on its way in: a column per field of the shape, JSON where the column is jsonb. Every
 * field is written, absent ones as null -- a `put` writes the whole record, so a field the caller left out is
 * a field the stored record no longer has, not one that keeps whatever was there before.
 */
function row(given: Record_, at: At): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fieldsOf(at.shape)) {
    const value = given[field.name];
    out[folded(field.name)] = value === undefined ? null : column(value, field.type);
  }
  return out;
}

/** One value as its column holds it: JSON where the column is jsonb, the value itself everywhere else. */
const column = (value: unknown, type: import('@wilanis/core').Type) => (isJson(type) ? JSON.stringify(value) : value);

/**
 * What a patch sets: only the fields it names. This is the difference between the two writes -- a `put` gives
 * the whole record and an absence means the field is gone, while a `patch` leaves every field it does not name
 * exactly as it was, and never removes one.
 */
function changed(changes: Record_, at: At): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fieldsOf(at.shape)) {
    if (!(field.name in changes)) continue;
    const value = changes[field.name];
    out[folded(field.name)] = value === undefined ? null : column(value, field.type);
  }
  return out;
}

/** The columns a select asks for: every field the shape has, and nothing the table may also hold. */
const columns = (at: At) => fieldsOf(at.shape).map(field => folded(field.name));

/** An @storage engine keeping records in PostgreSQL tables. */
export class PostgresEngine implements Engine {
  /**
   * `on` is the one session a transaction runs on, absent everywhere else. An engine made with one is the
   * same engine in every respect but where its statements go: to that session rather than to the pool, so
   * every call of it is inside the transaction that session began.
   */
  constructor(
    private readonly settings: Settings,
    private readonly on?: Kysely<never>,
  ) {}

  /** The database this collection lives in, and the table it is, qualified by the connection's schema. */
  private db(at: At): { db: Kysely<never>; table: string; schema: string } {
    const { db, schema } = poolFor(at, this.settings);
    return { db: this.on ?? db, table: `${schema}.${folded(at.name)}`, schema };
  }

  /**
   * A select of every column of the collection, filtered as the caller asked and narrowed to the scope. A
   * scope adds one equality per column it names; no scope adds nothing at all, which is how a view -- and a
   * collection that keeps no scope -- sees every row.
   */
  private selecting(at: At, where: Where | undefined, scope: Scope | undefined) {
    const { db, table } = this.db(at);
    const query = db.selectFrom(table as never).select(columns(at) as never);
    const filtered = where ? query.where(eb => conditionOf(eb as never, where, at.shape) as never) : query;
    return filtered.where(eb => within(eb as never, scope) as never);
  }

  /** The record under that key within the scope, or `record` absent where the collection holds none. */
  async get(at: At, key: unknown, scope?: Scope) {
    const found = await this.selecting(at, undefined, scope)
      .where(folded(at.key) as never, '=', key as never)
      .executeTakeFirst();
    return { record: record(found as Record<string, unknown> | undefined, at) };
  }

  /** Every record of the scope the query matches, in the order asked for and cut to the page asked for. */
  async find(at: At, query: Query) {
    let select = this.selecting(at, query.where, query.scope);
    for (const one of orderingsOf(query.order, at.shape))
      select = select.orderBy(folded(one.by) as never, one.dir) as never;
    if (query.limit !== undefined) select = select.limit(query.limit) as never;
    if (query.offset !== undefined) select = select.offset(query.offset) as never;
    const rows = (await select.execute()) as Record<string, unknown>[];
    return rows.map(one => record(one, at) as Record_);
  }

  /** How many records of the scope the filter matches. */
  async count(at: At, where: Where | undefined, scope?: Scope) {
    const { db, table } = this.db(at);
    let query = db.selectFrom(table as never).select(eb => eb.fn.countAll().as('n'));
    if (where) query = query.where(eb => conditionOf(eb as never, where, at.shape) as never) as never;
    query = query.where(eb => within(eb as never, scope) as never) as never;
    const answer = (await query.executeTakeFirst()) as { n: string | number } | undefined;
    return Number(answer?.n ?? 0);
  }

  /**
   * Write the whole record under its own key. A `unique` the store declares is held by the database, and the
   * violation comes back as an error this engine turns into the `violated` the port promises -- a constraint
   * is answered, not thrown, and which one answered is read off the constraint's own name.
   *
   * The scope columns are written beside the record, whatever the record says -- it cannot say anything,
   * since they are not its fields. A key already held under another scope is a `conflict` even with
   * `replace`: the upsert's update is itself narrowed to the scope, so the row of another one is not touched
   * and nothing comes back, which is the key being global to the collection said in SQL.
   */
  async put(at: At, given: Record_, { replace, scope }: Put) {
    const { db, table, schema } = this.db(at);
    await ensureScope(db, { schema, table: folded(at.name), lasting: !this.on }, at, scope);
    const values = { ...row(given, at), ...scopeValues(scope) };
    const key = folded(at.key);
    try {
      const written = await db
        .insertInto(table as never)
        .values(values as never)
        .onConflict(oc =>
          replace ? this.replacing(oc as never, at, values, scope) : oc.column(key as never).doNothing(),
        )
        .returning(columns(at) as never)
        .executeTakeFirst();
      if (!written) return { conflict: true };
      return { record: record(written as Record<string, unknown>, at), conflict: false };
    } catch (error) {
      const violated = violation(error, at, scope);
      if (violated) return { conflict: false, violated };
      throw error;
    }
  }

  /**
   * The `do update` of a replacing put, narrowed to the scope it is written under. Without a scope it
   * replaces whatever is under the key; with one it replaces only the row of that scope, so a key another
   * scope holds falls through the conflict untouched and `put` answers it as the conflict it is.
   */
  private replacing(oc: OnConflictBuilder<never, never>, at: At, values: Record<string, unknown>, scope?: Scope) {
    const update = oc.column(folded(at.key) as never).doUpdateSet(values as never);
    const table = folded(at.name);
    return scopeColumns(scope).length ? update.where(eb => within(eb as never, scope, table) as never) : update;
  }

  /**
   * The record after the change, or `record` absent where the collection holds none under that key within
   * the scope. A scope column is never among the changes -- it is not a field of the shape -- so the row
   * stays under the scope it was written with.
   */
  async patch(at: At, key: unknown, changes: Record_, written?: Written) {
    const { db, table } = this.db(at);
    const values = changed(changes, at);
    if (!Object.keys(values).length) return this.get(at, key, written?.scope);
    const after = await db
      .updateTable(table as never)
      .set(values as never)
      .where(folded(at.key) as never, '=', key as never)
      .where(eb => within(eb as never, written?.scope) as never)
      .returning(columns(at) as never)
      .executeTakeFirst();
    return { record: record(after as Record<string, unknown> | undefined, at) };
  }

  /**
   * Remove the record under that key within the scope and answer it. A record another table still references
   * is kept by the database's own foreign key, and the refusal comes back as the `referencedBy` the port
   * promises; a key of another scope matches nothing, so a remove of it removes nothing.
   */
  async remove(at: At, key: unknown, scope?: Scope) {
    const { db, table } = this.db(at);
    try {
      const gone = await db
        .deleteFrom(table as never)
        .where(folded(at.key) as never, '=', key as never)
        .where(eb => within(eb as never, scope) as never)
        .returning(columns(at) as never)
        .executeTakeFirst();
      const before = record(gone as Record<string, unknown> | undefined, at);
      return before ? { record: before, removed: true } : { removed: false };
    } catch (error) {
      const referencedBy = violation(error, at);
      if (!referencedBy) throw error;
      return { record: (await this.get(at, key, scope)).record, removed: false, referencedBy };
    }
  }

  /**
   * A key no record has: a uuid where the key is a string, one past the highest where it is a number. Which of
   * the two is the plugin's `keyType`, and X222 refuses at check time a collection whose key the choice cannot
   * answer, so what is left here is the honest run-time message for a plugin loaded without its rules.
   */
  async newKey(at: At) {
    const type = at.shape.kind === 'object' ? at.shape.fields[at.key]?.type : undefined;
    if (type?.kind === 'string' && this.settings.keyType !== 'identity') return randomUUID();
    if (type?.kind === 'number' && this.settings.keyType === 'identity') {
      const { db, table } = this.db(at);
      const highest = (await db
        .selectFrom(table as never)
        .select(eb => eb.fn.max(folded(at.key) as never).as('top'))
        .executeTakeFirst()) as { top: number | null } | undefined;
      return Number(highest?.top ?? 0) + 1;
    }
    throw new Error(
      `newKey: keyType '${this.settings.keyType ?? 'uuidv7'}' answers no key for '${at.key}', which is ${type?.kind ?? 'of no known type'}`,
    );
  }

  /** Create every table, column and constraint the store declares that is not there yet, and count each. */
  async ensure(collections: At[]) {
    if (!collections.length) return { collections: 0, columns: 0, constraints: 0 };
    const { db } = this.db(collections[0]);
    return ensureTables(db, collections, this.settings);
  }

  /** The connection's pool and the schema its tables sit in, for the five members that name no collection. */
  private at(on: On): { db: Kysely<never>; schema: string } {
    const { db, schema } = poolFor(on, this.settings);
    return { db: this.on ?? db, schema };
  }

  /**
   * The record's current entry for a collection, or nothing where this connection never recorded it. The
   * record's own table is made on first contact, so a database that has never seen it answers nothing rather
   * than failing on a table that is not there.
   */
  async recorded(on: On, collection: string): Promise<Declared | undefined> {
    const { db, schema } = this.at(on);
    await ensureRecord(db, schema);
    return currentOf(db, schema, folded(collection));
  }

  /** What the catalog holds for a collection, lowered to `Declared`, or nothing where there is no table. */
  async inspect(on: On, collection: string): Promise<Declared | undefined> {
    const { db, schema } = this.at(on);
    return inspectTable(db, schema, folded(collection));
  }

  /** How many rows stand in this step's way, as the one count its shape asks for. */
  async rows(on: On, step: Step): Promise<number> {
    const { db, schema } = this.at(on);
    const key = step.do === 'ref' && step.to ? (await inspectTable(db, schema, folded(step.to)))?.key : undefined;
    return countFor(db, schema, step, key);
  }

  /**
   * Apply the steps of one connection and write the record, in one transaction: a step that fails half way
   * rolls the whole connection back, and the record is untouched.
   */
  async apply(on: On, steps: Step[], record: Recording, applying: Applying): Promise<Applied | undefined> {
    const { db, schema } = this.at(on);
    return applyPlan(db, { schema, connection: on.connection }, { steps, record }, applying);
  }

  /**
   * Whether this engine writes a cast between these two types at all, which is `casts.ts`'s one table. A pair
   * it answers `false` for is refused before it is counted: a cast that cannot be written is no more possible
   * on an empty table than on a full one, and the operator reads `refused` rather than a fault.
   */
  attempts(was: FieldType, becomes: FieldType): boolean {
    return attempts(was, becomes);
  }

  /**
   * The name a collection is kept under here, which is the folded one: PostgreSQL folds an unquoted
   * identifier, so `auditLog` and `auditlog` are one table, the record keys its rows by the folded name
   * (`apply.ts`) and `history` answers it. Saying so is what keeps a plan from reading the record's spelling
   * beside the tree's and dropping the table one of them names.
   */
  named(collection: string): string {
    return folded(collection);
  }

  /** A database keeps what a plan applies for as long as the database is there, so every connection is planned. */
  keeps(): boolean {
    return true;
  }

  /** Every plan that applied on this connection, latest first, as the record kept it. */
  async history(on: On): Promise<Applied[]> {
    const { db, schema } = this.at(on);
    await ensureRecord(db, schema);
    return historyOf(db, schema, on.connection);
  }

  /**
   * BEGIN on one session of the connection's pool, and answer the engine that runs on it. The session is the
   * pool's until the transaction ends, which is what keeps a concurrent run from seeing what this one has
   * written: exclusivity is the pool's, and ordinary isolation does the rest.
   */
  async begin(at: At): Promise<Transaction> {
    const { db } = poolFor(at, this.settings);
    const trx = await db.startTransaction().execute();
    return {
      engine: new PostgresEngine(this.settings, trx as unknown as Kysely<never>),
      commit: () => trx.commit().execute(),
      rollback: () => trx.rollback().execute(),
    };
  }
}

/**
 * The constraint a database error names, spelled the way the store declares it, or nothing where the error is
 * not a constraint at all. Postgres names the constraint it broke, and `ensure` names every constraint it
 * creates after the declaration, so the round trip is what lets a violation be answered rather than thrown.
 *
 * A scoped collection holds the same `unique` under a name of its own, since the constraint is over the scope
 * columns and the declared fields together; both spellings are read back as the one declaration the store
 * wrote, so a graph is told which `unique` it repeated and never which columns the database put in front of it.
 */
function violation(error: unknown, at: At, scope?: Scope): string | undefined {
  const code = (error as { code?: string }).code;
  const constraint = (error as { constraint?: string }).constraint ?? '';
  const columns = scopeColumns(scope);
  if (code === '23505') {
    const fields = at.unique.find(
      one => constraint === uniqueName(at.name, one) || constraint === scopedUniqueName(at.name, columns, one),
    );
    return fields ? `unique [${fields.join(', ')}]` : `unique [${at.key}]`;
  }
  if (code !== '23503') return undefined;
  const ref =
    at.refs.find(one => constraint === refName(one.from, one.field)) ??
    at.referenced.find(one => constraint === refName(one.from, one.field));
  return ref ? `refs ${ref.from}.${ref.field} -> ${ref.to}` : `refs ${constraint}`;
}
