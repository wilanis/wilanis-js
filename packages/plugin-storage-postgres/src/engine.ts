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
import type { At, Engine, Query, Record_, Where } from '@wilanis/plugin-storage';
import type { Kysely } from 'kysely';
import { fieldsOf, folded, isJson } from './columns.js';
import { ensureTables } from './ensure.js';
import { conditionOf, orderingsOf } from './filter.js';
import { refName, uniqueName } from './names.js';
import { poolFor, type Settings } from './pool.js';

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
  constructor(private readonly settings: Settings) {}

  /** The database this collection lives in, and the table it is, qualified by the connection's schema. */
  private db(at: At): { db: Kysely<never>; table: string } {
    const { db, schema } = poolFor(at, this.settings);
    return { db, table: `${schema}.${folded(at.name)}` };
  }

  /** A select of every column of the collection, filtered as the caller asked. */
  private selecting(at: At, where: Where | undefined) {
    const { db, table } = this.db(at);
    const query = db.selectFrom(table as never).select(columns(at) as never);
    return where ? query.where(eb => conditionOf(eb as never, where, at.shape) as never) : query;
  }

  /** The record under that key, or `record` absent where the collection holds none. */
  async get(at: At, key: unknown) {
    const found = await this.selecting(at, undefined)
      .where(folded(at.key) as never, '=', key as never)
      .executeTakeFirst();
    return { record: record(found as Record<string, unknown> | undefined, at) };
  }

  /** Every record the query matches, in the order asked for and cut to the page asked for. */
  async find(at: At, query: Query) {
    let select = this.selecting(at, query.where);
    for (const one of orderingsOf(query.order, at.shape))
      select = select.orderBy(folded(one.by) as never, one.dir) as never;
    if (query.limit !== undefined) select = select.limit(query.limit) as never;
    if (query.offset !== undefined) select = select.offset(query.offset) as never;
    const rows = (await select.execute()) as Record<string, unknown>[];
    return rows.map(one => record(one, at) as Record_);
  }

  /** How many records the filter matches. */
  async count(at: At, where: Where | undefined) {
    const { db, table } = this.db(at);
    let query = db.selectFrom(table as never).select(eb => eb.fn.countAll().as('n'));
    if (where) query = query.where(eb => conditionOf(eb as never, where, at.shape) as never) as never;
    const answer = (await query.executeTakeFirst()) as { n: string | number } | undefined;
    return Number(answer?.n ?? 0);
  }

  /**
   * Write the whole record under its own key. A `unique` the store declares is held by the database, and the
   * violation comes back as an error this engine turns into the `violated` the port promises -- a constraint
   * is answered, not thrown, and which one answered is read off the constraint's own name.
   */
  async put(at: At, given: Record_, replace: boolean) {
    const { db, table } = this.db(at);
    const values = row(given, at);
    const key = folded(at.key);
    try {
      const insert = db.insertInto(table as never).values(values as never);
      const written = replace
        ? await insert
            .onConflict(oc => oc.column(key as never).doUpdateSet(values as never))
            .returning(columns(at) as never)
            .executeTakeFirst()
        : await insert
            .onConflict(oc => oc.column(key as never).doNothing())
            .returning(columns(at) as never)
            .executeTakeFirst();
      if (!written) return { conflict: true };
      return { record: record(written as Record<string, unknown>, at), conflict: false };
    } catch (error) {
      const violated = violation(error, at);
      if (violated) return { conflict: false, violated };
      throw error;
    }
  }

  /** The record after the change, or `record` absent where the collection holds none under that key. */
  async patch(at: At, key: unknown, changes: Record_) {
    const { db, table } = this.db(at);
    const values = changed(changes, at);
    if (!Object.keys(values).length) return this.get(at, key);
    const written = await db
      .updateTable(table as never)
      .set(values as never)
      .where(folded(at.key) as never, '=', key as never)
      .returning(columns(at) as never)
      .executeTakeFirst();
    return { record: record(written as Record<string, unknown> | undefined, at) };
  }

  /**
   * Remove the record under that key and answer it. A record another table still references is kept by the
   * database's own foreign key, and the refusal comes back as the `referencedBy` the port promises.
   */
  async remove(at: At, key: unknown) {
    const { db, table } = this.db(at);
    try {
      const gone = await db
        .deleteFrom(table as never)
        .where(folded(at.key) as never, '=', key as never)
        .returning(columns(at) as never)
        .executeTakeFirst();
      const before = record(gone as Record<string, unknown> | undefined, at);
      return before ? { record: before, removed: true } : { removed: false };
    } catch (error) {
      const referencedBy = violation(error, at);
      if (!referencedBy) throw error;
      return { record: (await this.get(at, key)).record, removed: false, referencedBy };
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
}

/**
 * The constraint a database error names, spelled the way the store declares it, or nothing where the error is
 * not a constraint at all. Postgres names the constraint it broke, and `ensure` names every constraint it
 * creates after the declaration, so the round trip is what lets a violation be answered rather than thrown.
 */
function violation(error: unknown, at: At): string | undefined {
  const code = (error as { code?: string }).code;
  const constraint = (error as { constraint?: string }).constraint ?? '';
  if (code === '23505') {
    const fields = at.unique.find(one => constraint === uniqueName(at.name, one));
    return fields ? `unique [${fields.join(', ')}]` : `unique [${at.key}]`;
  }
  if (code !== '23503') return undefined;
  const ref =
    at.refs.find(one => constraint === refName(one.from, one.field)) ??
    at.referenced.find(one => constraint === refName(one.from, one.field));
  return ref ? `refs ${ref.from}.${ref.field} -> ${ref.to}` : `refs ${constraint}`;
}
