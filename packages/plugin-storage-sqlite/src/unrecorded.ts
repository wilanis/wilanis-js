/**
 * The migration half of the engine contract (RFC 0017), answered as an engine that keeps no record yet. The
 * planner's five members, with a table rebuild for a `retype` inside the one transaction, are RFC 0022's
 * sixth step; until it lands this engine reads no record, finds no table, counts no row and applies nothing.
 *
 * What it says about itself is chosen so that nothing reads the gap as a database that is empty. `keeps`
 * answers false, so `wilanis migrate` skips a connection of this kind and says so, rather than planning a
 * `create` of tables the file already holds. `apply` refuses, naming the step, so a startup step that would
 * prepare a store through `@storage/storage.port.json#ensure` fails the start in the open rather than answering
 * that it made nothing and leaving the first write to fail on a missing table.
 */
import type { Applied, Declared, FieldType, On, Recorder, Step } from '@wilanis/plugin-storage';

/** The Recorder members of an engine whose planner has not landed. */
export abstract class Unrecorded implements Recorder {
  /** Nothing is recorded: this engine writes no record yet. */
  async recorded(_on: On, _collection: string): Promise<Declared | undefined> {
    return undefined;
  }

  /** Nothing is read from the catalog for a plan yet. */
  async inspect(_on: On, _collection: string): Promise<Declared | undefined> {
    return undefined;
  }

  /** No row is counted for a plan yet. */
  async rows(_on: On, _step: Step): Promise<number> {
    return 0;
  }

  /** A plan is refused, naming the step that makes this engine apply one. */
  async apply(on: On): Promise<Applied | undefined> {
    throw new Error(
      `connection '${on.connection}': the sqlite engine applies no migration plan yet (RFC 0022, step 6), so ` +
        'a store over it is not prepared through @storage/storage.port.json#ensure',
    );
  }

  /** No plan has applied: none can yet. */
  async history(_on: On): Promise<Applied[]> {
    return [];
  }

  /** False until the planner lands, so `wilanis migrate` skips the connection and says so. */
  keeps(): boolean {
    return false;
  }

  /**
   * The name a collection is kept under, folded: SQLite compares identifiers without case, so `auditLog` and
   * `auditlog` are one table, and saying so keeps a plan from reading them as two.
   */
  named(collection: string): string {
    return collection.toLowerCase();
  }

  /** No cast is written: nothing is applied yet. */
  attempts(_was: FieldType, _becomes: FieldType): boolean {
    return false;
  }
}
