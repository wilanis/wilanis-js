/**
 * The planner: the steps from what a database has recorded to what the tree declares (RFC 0017). Pure, and
 * engine-free -- no connection is opened here and no row is counted, so one planner serves every engine and a
 * record written by one engine version reads the same in the next.
 *
 * What goes in is two declarations and the marks the store carries that are not state; what comes out is the
 * steps between them, each with the wording the runtime prints. The class of a step -- additive,
 * transformative, destructive, refused -- is decided once rows are counted, which is the engine's; the planner
 * emits the step, says what it does and names what it would lose.
 */
import type { Collection, Type } from '@wilanis/core';
import { collectionSteps, fieldAndConstraintSteps } from './plan-steps.js';

/**
 * A collection as a store document declares it, with the two marks RFC 0017 adds to the schema. It is written
 * here rather than taken from `Collection` because the planner reads the marks before the schema carries them
 * (#234): `Collection` is assignable to this, so a store loaded by the tree is read without a cast, and the
 * two optional members fall away the moment core declares them.
 */
export type Declares = Collection & { renamed?: Record<string, string>; was?: string };

/** A store document as the planner reads it: the connection its collections live behind, and those collections. */
export interface Declaring {
  connection: string;
  collections: Record<string, Declares>;
}

/**
 * A collection as a database needs to know it: lowered from the store and the shape, engine-neutral, and what
 * the record keeps. `defaults` is not in it -- a default is applied when a column is added and dropped at
 * once, so it is an instruction to a step and not a fact about the table.
 */
export interface Declared {
  key: string;
  fields: Record<string, DeclaredField>;
  unique: string[][];
  refs: Record<string, { collection: string; onRemove: 'refuse' }>;
}

/** One field of a collection as a database holds it: the type it is kept in, and whether a row may leave it empty. */
export interface DeclaredField {
  type: FieldType;
  required: boolean;
}

/** The types a column may be, as every engine understands them: a shape, a list or `unknown` is kept as json. */
export type FieldType = 'string' | 'number' | 'boolean' | 'json';

/** What the store says about a collection that is not state: what to rename, and what a row already there receives. */
export interface CollectionMarks {
  renamed?: Record<string, string>;
  was?: string;
  defaults?: Record<string, unknown>;
}

/** Every collection's marks, by the collection's name now. */
export type Marks = Record<string, CollectionMarks>;

/** What a step does, in the plugin's own words. The runtime sees only `target`, `at`, `says` and `loses`. */
export type Does =
  | 'create'
  | 'renameCollection'
  | 'adopt'
  | 'drop'
  | 'rename'
  | 'add'
  | 'remove'
  | 'retype'
  /** a changed key: its own verb and not a `retype`, since an engine keyed on `do` would read that as a cast */
  | 'rekey'
  | 'require'
  | 'relax'
  | 'unique'
  | 'ununique'
  | 'ref'
  | 'unref';

/**
 * One thing an engine would do. `target` is the collection, `at` the part of it a field or constraint step is
 * about, `says` the line the plan prints, and `loses` what the data would cost where the step has a cost.
 * `refused` is set only where no count can make the step possible -- a changed key, a `renamed` the record
 * cannot answer -- and carries the hint that says what to edit instead.
 */
export interface Step {
  do: Does;
  target: string;
  at?: string;
  says: string;
  loses?: string;
  /** the value existing rows receive, where the store declares one for a column being added or made required */
  default?: unknown;
  /** what a `rename` or a `renameCollection` renames from, so an engine needs no second look at the marks */
  from?: string;
  /** the type a `retype` moves from and to, so an engine knows which cast to attempt */
  was?: FieldType;
  /** the fields a `unique` or `ununique` is over */
  over?: string[];
  /** the collection a `ref` or `unref` points at */
  to?: string;
  refused?: string;
}

/** What the planner has to say about a mark that has done its work, beside the steps. */
export interface Stale {
  target: string;
  at?: string;
  says: string;
  hint: string;
}

/** A plan for one connection: the steps, and the marks that may now be removed from the store. */
export interface Planned {
  steps: Step[];
  stale: Stale[];
}

/**
 * The column type a field of this type is kept in: scalars as themselves, everything else as json.
 *
 * This mapping is `columnOf` in `packages/plugin-storage-postgres/src/columns.ts` said engine-neutrally, and the
 * two must agree on which types are scalar and which are kept as JSON -- a field this calls `json` is the one
 * that engine calls `jsonb`. Step 5 of RFC 0017 (#237, #238) moves the catalog comparison out of `ensure` into
 * `inspect`, and the two meet there; until then a change to either belongs in both.
 */
export function fieldTypeOf(type: Type): FieldType {
  if (type.kind === 'string' || type.kind === 'number' || type.kind === 'boolean') return type.kind;
  return 'json';
}

/** One collection lowered to what a database needs to know, from its declaration and the shape it names. */
export function declaredOf(collection: Declares, shape: Type): Declared {
  const fields: Record<string, DeclaredField> = {};
  if (shape.kind === 'object')
    for (const [name, field] of Object.entries(shape.fields))
      fields[name] = { type: fieldTypeOf(field.type), required: field.required !== false };
  const refs: Declared['refs'] = {};
  for (const [field, ref] of Object.entries(collection.refs ?? {}))
    refs[field] = { collection: ref.collection, onRemove: 'refuse' };
  return { key: collection.key, fields, unique: collection.unique ?? [], refs };
}

/** What the store says about one collection that is not state, ready for the planner. */
export function marksOf(collection: Declares): CollectionMarks {
  return { renamed: collection.renamed, was: collection.was, defaults: collection.defaults };
}

/** Every collection of a store lowered, by name: what the tree declares for one connection. */
export function declaredOfStore(store: Declaring, shapeOf: (of: string) => Type): Record<string, Declared> {
  const declared: Record<string, Declared> = {};
  for (const [name, collection] of Object.entries(store.collections))
    declared[name] = declaredOf(collection, shapeOf(collection.of));
  return declared;
}

/** Every collection's marks of a store, by name: what the planner reads beside the two declarations. */
export function marksOfStore(store: Declaring): Marks {
  const marks: Marks = {};
  for (const [name, collection] of Object.entries(store.collections)) marks[name] = marksOf(collection);
  return marks;
}

/** Which recorded collection a declared one continues, where `was` names one that is no longer declared. */
function continues(name: string, recorded: Record<string, Declared>, marks: Marks, declared: Record<string, Declared>) {
  const was = marks[name]?.was;
  if (!was || !(was in recorded) || was in declared) return undefined;
  return was;
}

/**
 * A `was` that has done its work: the collection is recorded under its own name and the record no longer holds
 * the one the mark names, so the rename applied on an earlier run. Answered on the run after the
 * `renameCollection`, never on the run that plans it, as `renamed` is.
 */
function applied(name: string, recorded: Record<string, Declared>, marks: Marks): string | undefined {
  const was = marks[name]?.was;
  if (!was || !(name in recorded) || was in recorded) return undefined;
  return was;
}

/** Every recorded collection some declared one continues through `was`, so it is renamed and never dropped. */
function claimed(recorded: Record<string, Declared>, declared: Record<string, Declared>, marks: Marks): Set<string> {
  const taken = new Set<string>();
  for (const name of Object.keys(declared)) {
    const was = continues(name, recorded, marks, declared);
    if (was) taken.add(was);
  }
  return taken;
}

/** How a collection comes to exist here: the record it continues, or the table the catalog holds and nothing else. */
interface Standing {
  recorded?: Declared;
  found?: Declared;
  /** the recorded collection this one continues, where `was` names one the record holds and the tree no longer declares */
  was?: string;
  /** a `was` the record no longer holds, so the rename has applied and the mark may go */
  applied?: string;
}

/** The steps for one declared collection: how it comes to exist, then the field and constraint steps over it. */
function stepsFor(name: string, standing: Standing, to: Declared, marks: CollectionMarks): Planned {
  const opening = collectionSteps(name, standing);
  if (!opening.against) return { steps: opening.steps, stale: opening.stale };
  const rest = fieldAndConstraintSteps(name, opening.against, to, marks);
  return { steps: [...opening.steps, ...rest.steps], stale: [...opening.stale, ...rest.stale] };
}

/**
 * The steps from `recorded` to `declared` for the collections of one connection, before any row is counted,
 * with the marks that have done their work. `found` is what the engine's catalog holds for a collection the
 * record has never seen, so a database that predates the record joins it as an `adopt` rather than a `create`.
 * Collections are walked in declaration order and the drops follow, so a plan reads the way the store does.
 */
export function plan(
  recorded: Record<string, Declared>,
  declared: Record<string, Declared>,
  marks: Marks,
  found: Record<string, Declared> = {},
): Planned {
  const taken = claimed(recorded, declared, marks);
  const steps: Step[] = [];
  const stale: Stale[] = [];
  for (const [name, to] of Object.entries(declared)) {
    const was = continues(name, recorded, marks, declared);
    const standing: Standing = {
      recorded: recorded[was ?? name],
      found: found[name],
      was,
      applied: applied(name, recorded, marks),
    };
    const one = stepsFor(name, standing, to, marks[name] ?? {});
    steps.push(...one.steps);
    stale.push(...one.stale);
  }
  for (const name of Object.keys(recorded))
    if (!(name in declared) && !taken.has(name))
      steps.push({ do: 'drop', target: name, says: `drop collection ${name}`, loses: `every row of ${name}` });
  return { steps, stale };
}

export type { Standing };
