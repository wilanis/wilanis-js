/**
 * The migration half of the engine contract (RFC 0017), on a SQLite file: what the record holds
 * (`record.ts`), what the catalog holds (`inspect.ts`), how many rows stand in a step's way (`counting.ts`),
 * the plan applied in one transaction (`apply.ts`), and the plans that applied. `SqliteEngine` extends it, so
 * the store's operations and the planner's questions reach one file through one set of handles.
 *
 * It is a class of its own rather than more members of the engine because the two answer different questions
 * -- one is what a graph asks of a store, the other what `wilanis migrate` asks of a database -- and a file
 * under the house limit splits along the families it holds, as `record.ts` in @storage splits the contract.
 */
import type { Applied, Applying, Declared, FieldType, On, Recorder, Recording, Step } from '@wilanis/plugin-storage';
import type { Kysely } from 'kysely';
import { applyPlan } from './apply.js';
import { attempts } from './casts.js';
import { countFor } from './counting.js';
import type { Handles } from './handles.js';
import { inspectTable } from './inspect.js';
import { folded } from './names.js';
import { currentOf, ensureRecord, historyOf } from './record.js';
import { isIdentity, type Settings } from './settings.js';

/** The Recorder members of the sqlite engine, over the handles one load of a tree opened. */
export abstract class SqliteRecorder implements Recorder {
  /**
   * `trx` is the handle a transaction runs on, absent everywhere else: an engine made inside a transaction
   * reads the record and the catalog as that transaction sees them.
   */
  constructor(
    protected readonly handles: Handles,
    protected readonly settings: Settings,
    protected readonly trx?: Kysely<never>,
  ) {}

  /** The handle a question about this connection is asked on. */
  private reach(on: On): Kysely<never> {
    return this.trx ?? this.handles.for(on);
  }

  /**
   * The record's current entry for a collection, or nothing where this file never recorded it. The record's
   * table is made on first contact, so a file that has never seen it answers nothing rather than failing.
   */
  async recorded(on: On, collection: string): Promise<Declared | undefined> {
    const db = this.reach(on);
    await ensureRecord(db);
    return currentOf(db, folded(collection));
  }

  /** What the catalog holds for a collection, lowered to `Declared`, or nothing where there is no table. */
  async inspect(on: On, collection: string): Promise<Declared | undefined> {
    return inspectTable(this.reach(on), collection);
  }

  /** How many rows stand in this step's way, as the one count its shape asks for. */
  async rows(on: On, step: Step): Promise<number> {
    return countFor(this.reach(on), step);
  }

  /**
   * Apply the steps of one connection and write the record, in one transaction on a handle of the plan's own:
   * a step that fails half way rolls the whole plan back, and the record is untouched. A plan is never applied
   * inside a store's transaction, which would hold the very turn on the file the plan waits for.
   */
  async apply(on: On, steps: Step[], record: Recording, applying: Applying): Promise<Applied | undefined> {
    if (this.trx)
      throw new Error(`connection '${on.connection}': a migration plan is not applied inside a transaction`);
    const identity = isIdentity(this.settings);
    return applyPlan({ steps, record }, { handles: this.handles, on, applying, identity });
  }

  /** Every plan that applied on this connection, latest first, as the record kept it. */
  async history(on: On): Promise<Applied[]> {
    const db = this.reach(on);
    await ensureRecord(db);
    return historyOf(db, on.connection);
  }

  /** A file keeps what a plan applies for as long as the file is there, so every connection is planned. */
  keeps(): boolean {
    return true;
  }

  /**
   * The name a collection is kept under, folded: SQLite compares identifiers without case, so `auditLog` and
   * `auditlog` are one table, the record keys its rows by the folded name, and saying so keeps a plan from
   * reading the record's spelling beside the tree's and dropping the table one of them names.
   */
  named(collection: string): string {
    return folded(collection);
  }

  /** Whether this engine writes a cast between these two types at all, which is `casts.ts`'s one table. */
  attempts(was: FieldType, becomes: FieldType): boolean {
    return attempts(was, becomes);
  }
}
