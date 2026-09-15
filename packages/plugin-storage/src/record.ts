/**
 * The migration half of the engine contract (RFC 0017, step 4): what an engine is asked about the record it
 * keeps, and what it is asked to do with a plan the planner in `plan.ts` produced.
 *
 * It lives beside `engine.ts` rather than in it because the two answer different questions -- one is what a
 * graph asks of a store, the other what `wilanis migrate` asks of a database -- and because a file under the
 * house limit splits along the families it holds. Nothing here mentions SQL, a table or a column: an engine
 * answers a `Declared` and takes a `Step`, and what either is on that engine is that engine's alone.
 */
import type { Declared, Step } from './plan.js';

/**
 * The connection an engine is asked about: its canonical path, and the settings that reach it. The path comes
 * first, as RFC 0017 says and as `At.connection` is the first thing a storage operation names; the settings
 * ride with it because a plan may be a connection's first contact, and an engine that has opened nothing yet
 * has nowhere else to read the url from. It is `At`'s connection half exactly, so every caller already holds
 * one.
 */
export interface On {
  /** the connection document's canonical path, which is what a record is kept per */
  connection: string;
  /** the connection kind, so an engine kept per kind knows what it was reached as */
  kind: string;
  /** the connection's settings, secrets already substituted */
  settings: Record<string, unknown>;
}

/**
 * One plan that applied, as the record keeps it: which migration it was, when, by whom, from which tree, and
 * the collections it touched. `history` answers these latest first, and `--history` prints them.
 */
export interface Applied {
  /** the migration's number on this connection, rising with every plan that applied */
  id: number;
  /** when it applied, as an ISO instant */
  appliedAt: string;
  /** who ran it: the operating-system user and host, unless the caller said otherwise */
  by: string;
  /** the tree it came from, which is `project.json -> name` */
  tree: string;
  /** the connection it applied to, so a history read across connections stays readable */
  connection: string;
  /** the collections it touched, in the order the plan named them */
  targets: string[];
  /** what it did to each, as the plan printed it, by collection */
  steps?: Record<string, string[]>;
}

/**
 * What an `apply` is told about the run it is recording, so the engine writes a row it did not have to invent.
 * The engine fills `id` and `appliedAt`, which are the database's to say.
 */
export interface Applying {
  by: string;
  tree: string;
}

/**
 * The record as one plan leaves it: the declaration each touched collection now has, or `null` where the
 * collection was dropped. It is written inside the same transaction as the steps, so a database never holds a
 * record of a change it did not make.
 */
export type Recording = Record<string, Declared | null>;

/**
 * What an engine keeping a record answers about it. Every member takes the connection first and mentions no
 * SQL: the questions are about collections, fields and rows, which is what a plan is made of.
 *
 * An engine that keeps nothing between processes answers nothing, zero, and does nothing -- there is no
 * record to read and no plan to apply -- so the contract is optional on `Engine` and complete here.
 */
export interface Recorder {
  /** The record's current entry for a collection, or nothing when it was never recorded on this connection. */
  recorded(on: On, collection: string): Promise<Declared | undefined>;
  /** What the catalog holds for a collection, lowered to `Declared`, or nothing when there is no table. */
  inspect(on: On, collection: string): Promise<Declared | undefined>;
  /** How many rows stand in a step's way: rows of a collection, rows holding a value, rows violating a constraint, rows that would not cast. */
  rows(on: On, step: Step): Promise<number>;
  /** Apply the steps of one connection and write the record, in one transaction where the engine can; throws having applied nothing otherwise. */
  apply(on: On, steps: Step[], record: Recording, applying: Applying): Promise<Applied | undefined>;
  /** Every applied plan on this connection, latest first. */
  history(on: On): Promise<Applied[]>;
}

/** The connection half of anything that names one, so a caller holding an `At` has an `On` already. */
export function onOf(at: On): On {
  return { connection: at.connection, kind: at.kind, settings: at.settings };
}
