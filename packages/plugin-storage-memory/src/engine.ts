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
import type { At, Engine, Query, Record_, Ref, Transaction, Where } from '@wilanis/plugin-storage';
import { matches, ordered, paged } from './match.js';

/** The type of the field that identifies a record, so a new key can be one the collection would accept. */
function keyType(at: At): Type | undefined {
  return at.shape.kind === 'object' ? at.shape.fields[at.key]?.type : undefined;
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
  constructor(private collections = new Map<string, Map<string, Record_>>()) {}

  /** The records of one collection, made on first use: `ensure` is therefore nothing to do here. */
  private records(at: At): Map<string, Record_> {
    const where = `${at.connection}/${at.name}`;
    let kept = this.collections.get(where);
    if (!kept) {
      kept = new Map();
      this.collections.set(where, kept);
    }
    return kept;
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

  /** The record kept under that key, or `record` absent where the collection holds none. */
  async get(at: At, key: unknown) {
    return { record: MemoryEngine.copy(this.records(at).get(String(key))) };
  }

  /** Every record the filter matches, in the order asked for and cut to the page asked for. */
  async find(at: At, query: Query) {
    const matching = [...this.records(at).values()].filter(record => matches(query.where, record));
    return paged(ordered(matching, query.order), query.limit, query.offset).map(record => MemoryEngine.kept(record));
  }

  /** How many records the filter matches. */
  async count(at: At, where: Where | undefined) {
    return [...this.records(at).values()].filter(record => matches(where, record)).length;
  }

  /** The records of a collection of the same store, by its name: what a reference is judged against. */
  private beside(at: At, name: string): Map<string, Record_> {
    return this.records({ ...at, name });
  }

  /**
   * The first `unique` this record would repeat, spelled as the constraint it broke. A record is compared
   * with every other under its own key excepted, since writing a record over itself repeats nothing.
   */
  private repeats(at: At, record: Record_): string | undefined {
    const key = String(record[at.key]);
    const others = [...this.records(at)].filter(([under]) => under !== key).map(([, kept]) => kept);
    const constraint = at.unique.find(fields =>
      others.some(other => fields.every(field => Object.is(other[field], record[field]))),
    );
    return constraint && `unique [${constraint.join(', ')}]`;
  }

  /**
   * The first reference this record makes to a record that is not there, spelled as the reference it broke.
   * A reference whose field is absent points at nothing and is nothing to judge -- that is the shape's
   * `required: false`, said once.
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
   */
  async put(at: At, record: Record_, replace: boolean) {
    const kept = this.records(at);
    const key = String(record[at.key]);
    if (!replace && kept.has(key)) return { conflict: true };
    const violated = this.repeats(at, record) ?? this.dangles(at, record);
    if (violated) return { conflict: false, violated };
    kept.set(key, MemoryEngine.kept(record));
    return { record: MemoryEngine.kept(record), conflict: false };
  }

  /** The record after the change, or `record` absent where the collection holds none under that key. */
  async patch(at: At, key: unknown, changes: Record_) {
    const kept = this.records(at);
    const before = kept.get(String(key));
    if (!before) return {};
    const after = MemoryEngine.kept({ ...before, ...changes });
    kept.set(String(key), after);
    return { record: MemoryEngine.kept(after) };
  }

  /** The first collection still holding this key by a declared reference, spelled as that reference. */
  private held(at: At, key: unknown): string | undefined {
    const by = at.referenced.find(ref =>
      [...this.beside(at, ref.from).values()].some(record => String(record[ref.field]) === String(key)),
    );
    return by && MemoryEngine.spell(by);
  }

  /**
   * The record that was removed, or `record` absent where there was none. A record another collection still
   * references is kept and the reference answered, since nothing is ever deleted on a tree's behalf.
   */
  async remove(at: At, key: unknown) {
    const kept = this.records(at);
    const before = MemoryEngine.copy(kept.get(String(key)));
    if (!before) return { removed: false };
    const referencedBy = this.held(at, key);
    if (referencedBy) return { record: before, removed: false, referencedBy };
    kept.delete(String(key));
    return { record: before, removed: true };
  }

  /**
   * A key no record of the collection has, of the type the collection's key field declares: a uuid for a
   * string, one past the highest for a number. A key of any other type is the tree's to write, since this
   * engine has nothing to generate that would still be that type.
   */
  async newKey(at: At) {
    const type = keyType(at);
    if (type?.kind === 'string') return randomUUID();
    if (type?.kind === 'number') {
      const kept = [...this.records(at).values()].map(record => Number(record[at.key]));
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

  /** A copy deep enough that writing through one map cannot reach the other: the records too, not just the maps. */
  private static forked(collections: Map<string, Map<string, Record_>>): Map<string, Map<string, Record_>> {
    return new Map([...collections].map(([where, kept]) => [where, new Map(kept)]));
  }

  /** Take the records of another engine as this one's own, which is what committing a transaction means here. */
  private adopt(collections: Map<string, Map<string, Record_>>): void {
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
