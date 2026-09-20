/**
 * Records in a Map, for exactly as long as the process runs. One Map per collection -- and a collection is
 * the pair of its connection and its name, as @storage says it is, so two features declaring the same name
 * over one connection meet the same records rather than two sets of them.
 *
 * Nothing here is module state: the maps hang off the instance, and a new instance is registered for every
 * environment, so loading a tree a second time starts empty.
 */
import { randomUUID } from 'node:crypto';
import type { Type } from '@wilanis/core';
import type { At, Engine, Put, Query, Record_, Ref, Scope, Transaction, Where, Written } from '@wilanis/plugin-storage';
import { matches, ordered, paged } from './match.js';

/** The type of the field that identifies a record, so a new key can be one the collection would accept. */
function keyType(at: At): Type | undefined {
  return at.shape.kind === 'object' ? at.shape.fields[at.key]?.type : undefined;
}

/**
 * One row as this engine keeps it: the record, and the scope it was written under, beside it. Beside rather
 * than merged in, because a scope column is not a field of the shape -- so a record read back is exactly the
 * record that was written, and a `find` can never match a scope column through `where`.
 */
interface Row {
  record: Record_;
  scope: Scope | undefined;
}

/**
 * Whether a row belongs to the scope asked for: every column compared, and `undefined` matching every row.
 * `undefined` is the unscoped case -- a collection with no `scoped`, or a view, which sees every row -- and
 * never an empty scope that would match nothing.
 */
function within(row: Row, scope: Scope | undefined): boolean {
  if (!scope) return true;
  return Object.entries(scope).every(([column, value]) => Object.is(row.scope?.[column], value));
}

/** An @storage engine keeping records in maps that live as long as the process, and no longer. */
export class MemoryEngine implements Engine {
  /** How many keys this engine has made, so a number key can be one no record has. */
  private made = 0;

  /**
   * `collections` is connection/name -> the records kept under it, by the text of their key. It is taken
   * rather than made so that a transaction can be this same engine over a copy of it: `begin` hands the copy
   * to a second instance, and committing swaps that copy back into this one.
   */
  constructor(private collections = new Map<string, Map<string, Row>>()) {}

  /** The rows of one collection, made on first use: `ensure` is therefore nothing to do here. */
  private records(at: At): Map<string, Row> {
    const where = `${at.connection}/${at.name}`;
    let kept = this.collections.get(where);
    if (!kept) {
      kept = new Map();
      this.collections.set(where, kept);
    }
    return kept;
  }

  /** The row under that key if it is within the scope, and nothing where it is another scope's or absent. */
  private row(at: At, key: unknown, scope: Scope | undefined): Row | undefined {
    const found = this.records(at).get(String(key));
    return found && within(found, scope) ? found : undefined;
  }

  /** Every row of the collection that belongs to the scope, which is every one of them where there is none. */
  private rowsIn(at: At, scope: Scope | undefined): Row[] {
    return [...this.records(at).values()].filter(row => within(row, scope));
  }

  /**
   * A deep copy, so what a graph does with a record it was given cannot reach what is kept, and what a caller
   * does with the record it handed over cannot either. A shallow copy would share every nested object, which
   * is a store that changes without being written to; records are the JSON a shape describes, so cloning one
   * is defined for everything a collection can hold.
   */
  private static copy(record: Record_ | undefined): Record_ | undefined {
    return record && MemoryEngine.kept(record);
  }

  /** The same copy, of a record there certainly is one of. */
  private static kept(record: Record_): Record_ {
    return structuredClone(record) as Record_;
  }

  /**
   * The record kept under that key, or `record` absent where the collection holds none within the scope. A
   * key of another scope is absent rather than refused: the graph already routes a record that is not there.
   */
  async get(at: At, key: unknown, scope?: Scope) {
    return { record: MemoryEngine.copy(this.row(at, key, scope)?.record) };
  }

  /** Every record of the scope the filter matches, in the order asked for and cut to the page asked for. */
  async find(at: At, query: Query) {
    const matching = this.rowsIn(at, query.scope)
      .map(row => row.record)
      .filter(record => matches(query.where, record));
    return paged(ordered(matching, query.order), query.limit, query.offset).map(record => MemoryEngine.kept(record));
  }

  /** How many records of the scope the filter matches. */
  async count(at: At, where: Where | undefined, scope?: Scope) {
    return this.rowsIn(at, scope).filter(row => matches(where, row.record)).length;
  }

  /** The rows of a collection of the same store, by its name: what a reference is judged against. */
  private beside(at: At, name: string): Map<string, Row> {
    return this.records({ ...at, name });
  }

  /**
   * The first `unique` this record would repeat, spelled as the constraint it broke. A record is compared
   * with every other under its own key excepted, since writing a record over itself repeats nothing.
   *
   * A constraint holds within the scope: the rows of another scope are not compared at all, so `[url, method]`
   * taken under one tenant leaves it free under every other -- which is `[tenant, url, method]` said once,
   * without the store having to spell the scope column into every constraint it declares.
   */
  private repeats(at: At, record: Record_, scope: Scope | undefined): string | undefined {
    const key = String(record[at.key]);
    const others = [...this.records(at)]
      .filter(([under, row]) => under !== key && within(row, scope))
      .map(([, row]) => row.record);
    const constraint = at.unique.find(fields =>
      others.some(other => fields.every(field => Object.is(other[field], record[field]))),
    );
    return constraint && `unique [${constraint.join(', ')}]`;
  }

  /**
   * The first reference this record makes to a record that is not there, spelled as the reference it broke.
   * A reference whose field is absent points at nothing and is nothing to judge -- that is the shape's
   * `required: false`, said once.
   *
   * It is judged by key alone, across every scope, because a key is global to the collection: a reference
   * names a row, and which scope keeps that row is not the referring record's business.
   */
  private dangles(at: At, record: Record_): string | undefined {
    const broken = at.refs.find(ref => {
      const held = record[ref.field];
      return held !== undefined && held !== null && !this.beside(at, ref.to).has(String(held));
    });
    return broken && MemoryEngine.spell(broken);
  }

  /** A reference as a message names it: the field of the collection that holds it, and what it points at. */
  private static spell(ref: Ref): string {
    return `refs ${ref.from}.${ref.field} -> ${ref.to}`;
  }

  /**
   * Write the whole record under its own key; with `replace` false, answer a conflict and write nothing. A
   * `unique` another record already holds, or a `refs` pointing at a record that is not there, is answered as
   * `violated` and nothing is written: the store declared it, so it is no surprise to the graph that wrote it.
   *
   * The scope is written beside the record, whatever the record says -- it cannot say anything, since a scope
   * column is not one of its fields. A key already held under another scope is a `conflict` even with
   * `replace`, because the key is global to the collection: one scope taking another's row is the very thing
   * a scope exists to prevent, and answering `conflict` says so without saying whose the row is.
   */
  async put(at: At, record: Record_, put: Put) {
    const kept = this.records(at);
    const key = String(record[at.key]);
    const held = kept.get(key);
    if (held && !within(held, put.scope)) return { conflict: true };
    if (!put.replace && held) return { conflict: true };
    const violated = this.repeats(at, record, put.scope) ?? this.dangles(at, record);
    if (violated) return { conflict: false, violated };
    kept.set(key, { record: MemoryEngine.kept(record), scope: put.scope });
    return { record: MemoryEngine.kept(record), conflict: false };
  }

  /**
   * The record after the change, or `record` absent where the collection holds none under that key within
   * the scope. The scope it was written under is kept as it was: a patch changes fields of the shape, and a
   * scope column is not one of them.
   */
  async patch(at: At, key: unknown, changes: Record_, written?: Written) {
    const before = this.row(at, key, written?.scope);
    if (!before) return {};
    const after = MemoryEngine.kept({ ...before.record, ...changes });
    this.records(at).set(String(key), { record: after, scope: before.scope });
    return { record: MemoryEngine.kept(after) };
  }

  /** The first collection still holding this key by a declared reference, spelled as that reference. */
  private held(at: At, key: unknown): string | undefined {
    const by = at.referenced.find(ref =>
      [...this.beside(at, ref.from).values()].some(row => String(row.record[ref.field]) === String(key)),
    );
    return by && MemoryEngine.spell(by);
  }

  /**
   * The record that was removed, or `record` absent where there was none within the scope. A record another
   * collection still references is kept and the reference answered, since nothing is ever deleted on a tree's
   * behalf; a key of another scope is absent, so a remove of it removes nothing.
   */
  async remove(at: At, key: unknown, scope?: Scope) {
    const before = MemoryEngine.copy(this.row(at, key, scope)?.record);
    if (!before) return { removed: false };
    const referencedBy = this.held(at, key);
    if (referencedBy) return { record: before, removed: false, referencedBy };
    this.records(at).delete(String(key));
    return { record: before, removed: true };
  }

  /**
   * A key no record of the collection has, of the type the collection's key field declares: a uuid for a
   * string, one past the highest for a number. A key of any other type is the tree's to write, since this
   * engine has nothing to generate that would still be that type.
   *
   * It takes no scope and reads across every one of them, because a key is global to the collection: a
   * number one past the highest of one scope alone would be a key another scope already holds.
   */
  async newKey(at: At) {
    const type = keyType(at);
    if (type?.kind === 'string') return randomUUID();
    if (type?.kind === 'number') {
      const kept = [...this.records(at).values()].map(row => Number(row.record[at.key]));
      this.made = Math.max(this.made, ...kept.filter(Number.isFinite)) + 1;
      return this.made;
    }
    throw new Error(
      `newKey: this engine makes a key for a string or a number, and '${at.key}' is ${type?.kind ?? 'of no known type'}`,
    );
  }

  /** Every collection exists as soon as it is asked for, so there is nothing to create and nothing to alter. */
  async ensure(collections: At[]) {
    for (const at of collections) this.records(at);
    return undefined;
  }

  /**
   * This engine keeps nothing between processes, so there is nothing to record and nothing to migrate: the
   * record is empty, the catalog is empty, no row stands in any step's way, applying a plan is applying it to
   * a database that will not be here tomorrow, and there is no history. `wilanis migrate` reads the five
   * answers below and says so for this connection rather than planning against a record that cannot exist.
   *
   * `ensure` already answers nothing for the same reason: a collection exists as soon as it is asked for.
   */
  async recorded(): Promise<undefined> {
    return undefined;
  }

  /** There is no catalog: a collection is a Map made on first use, which is not a thing to inspect. */
  async inspect(): Promise<undefined> {
    return undefined;
  }

  /** No row stands in any step's way, because no step ever runs here. */
  async rows(): Promise<number> {
    return 0;
  }

  /** Nothing to apply and nothing to record: a plan against records that end with the process is no plan. */
  async apply(): Promise<undefined> {
    return undefined;
  }

  /** No plan ever applied here, so there is nothing to have a history of. */
  async history(): Promise<never[]> {
    return [];
  }

  /**
   * A collection is kept under exactly the name it was given: a Map key folds nothing, so two names that
   * differ only in case are two collections here, as `records` has always treated them.
   */
  named(collection: string): string {
    return collection;
  }

  /**
   * Nothing this engine holds outlives the process, so a plan against it would be a plan nobody could apply.
   * `wilanis migrate` reads this and skips the connection with a line saying why, rather than printing a
   * `create` per collection that the next process would print again.
   */
  keeps(): boolean {
    return false;
  }

  /**
   * This engine writes no cast, because it applies no step: a record kept in a Map is whatever was put there,
   * and nothing here ever rewrites one type as another. Answering `false` is of no consequence -- no plan of
   * this engine's is ever classed -- and it is the honest answer rather than a claim it would attempt one.
   */
  attempts(): boolean {
    return false;
  }

  /** A copy deep enough that writing through one map cannot reach the other: the records too, not just the maps. */
  private static forked(collections: Map<string, Map<string, Row>>): Map<string, Map<string, Row>> {
    return new Map([...collections].map(([where, kept]) => [where, new Map(kept)]));
  }

  /** Take the records of another engine as this one's own, which is what committing a transaction means here. */
  private adopt(collections: Map<string, Map<string, Row>>): void {
    this.collections = collections;
  }

  /**
   * Begin by copying every collection and answering an engine over the copy: the transaction writes there and
   * this one is untouched, so a rollback is keeping what was already kept and costs nothing to do. Committing
   * swaps the copy in. A record is copied on the way in and out of a collection already, so forking the maps
   * is the whole of the isolation -- what the two sides share is records neither of them mutates.
   *
   * It is copy-on-begin rather than copy-on-write because a Map of the records a process holds is small by
   * construction: this engine keeps nothing past the process, and a store too big to copy wants the other one.
   */
  async begin(_at: At): Promise<Transaction> {
    const forked = MemoryEngine.forked(this.collections);
    const engine = new MemoryEngine(forked);
    return {
      engine,
      commit: async () => this.adopt(forked),
      rollback: async () => undefined,
    };
  }
}
