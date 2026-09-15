/**
 * The steps of one collection: how it comes to exist, then what changed inside it. The planner in `plan.ts`
 * walks the collections and this module says what each one costs, in the five points RFC 0017 lists.
 *
 * Nothing here opens a connection or counts a row: every step that depends on data says what it would lose and
 * leaves the count to the engine. What is refused here is refused by the declarations alone -- a changed key,
 * a `renamed` naming a field the record does not hold -- and no count can make it possible.
 */
import type { CollectionMarks, Declared, DeclaredField, Planned, Stale, Standing, Step } from './plan.js';
import { constraintSteps } from './plan-constraints.js';

/** How a collection comes to exist, and the record the rest of its steps are read against. */
export interface Opening extends Planned {
  against?: Declared;
}

/** The names a hint may offer, so a reader sees what the record actually holds. */
const listed = (names: string[]) => (names.length ? names.join(', ') : 'none');

/**
 * Point 1: a declared collection with no record. It is `create` where the catalog has no table either,
 * `renameCollection` where `was` names a record no longer declared, and `adopt` where the engine found a table
 * the record has never seen -- the record is written from the catalog and the field steps run against that.
 */
export function collectionSteps(name: string, standing: Standing): Opening {
  const { recorded, found, was } = standing;
  if (recorded && was)
    return {
      steps: [{ do: 'renameCollection', target: name, from: was, says: `rename collection ${was} → ${name}` }],
      stale: [],
      against: recorded,
    };
  if (recorded) return { steps: [], stale: staleWas(name, standing), against: recorded };
  if (found)
    return {
      steps: [{ do: 'adopt', target: name, says: `adopt collection ${name} (from the database as it stands)` }],
      stale: [],
      against: found,
    };
  return { steps: [{ do: 'create', target: name, says: `create collection ${name}` }], stale: [], against: undefined };
}

/**
 * A `was` that has done its work: the collection is recorded under its own name and the record no longer holds
 * the one the mark names, so the rename has applied and the mark is a lie to the next fresh database. Said on
 * the run *after* the `renameCollection`, as `renamed` says `done` on the run after its `rename`.
 */
function staleWas(name: string, standing: Standing): Stale[] {
  const was = standing.applied;
  if (!was) return [];
  return [
    {
      target: name,
      says: `was.${name} has been applied`,
      hint: `remove "was": "${was}" from the ${name} collection once every database has applied it`,
    },
  ];
}

/**
 * Point 3: a key identifies, so re-keying is a new collection and no count can make the step safe. Its own verb
 * rather than a `retype`: nothing is cast here, and an engine that dispatches on `do` must not read this as one.
 */
function keySteps(name: string, from: Declared, to: Declared): Step[] {
  if (from.key === to.key) return [];
  return [
    {
      do: 'rekey',
      target: name,
      at: to.key,
      says: `key ${from.key} → ${to.key}`,
      refused: `a key identifies, and re-keying is a new collection: declare it, copy the rows with a one-off graph fired by a command-line trigger, and drop ${name}`,
    },
  ];
}

/**
 * Which recorded field a declared one continues, where `renamed` says so and the record can answer it: RFC
 * 0017's point 4, "the old name in the record and the new one not". Where the record holds both the mark has
 * done its work already -- renaming onto a column that exists is not a rename -- so the field reads as itself.
 */
function renameOf(field: string, from: Declared, to: Declared, marks: CollectionMarks): string | undefined {
  const old = marks.renamed?.[field];
  if (!old || !(old in from.fields) || old in to.fields || field in from.fields) return undefined;
  return old;
}

/** A `renamed` the record cannot answer: the old name is not there and no count will put it there. */
function refusedRename(name: string, field: string, old: string, from: Declared): Step {
  return {
    do: 'rename',
    target: name,
    at: field,
    from: old,
    says: `rename ${old} → ${field}`,
    refused: `the record of ${name} has no field '${old}' to rename (it holds: ${listed(Object.keys(from.fields))})`,
  };
}

/**
 * What one `renamed` entry means against a record: the rename is still to do, it has been done already, or the
 * record cannot answer it. A mark naming a field the shape does not have is C0nn's at check time, not a step's.
 */
function renameStanding(field: string, from: Declared, to: Declared, marks: CollectionMarks) {
  if (!(field in to.fields)) return 'none';
  if (renameOf(field, from, to, marks)) return 'todo';
  if (field in from.fields) return 'done';
  return 'refused';
}

/** Point 4, the `renamed` marks: the renames a record can answer, the ones it cannot, and the ones already done. */
function renameSteps(name: string, from: Declared, to: Declared, marks: CollectionMarks): Planned {
  const steps: Step[] = [];
  const stale: Stale[] = [];
  for (const [field, old] of Object.entries(marks.renamed ?? {})) {
    const standing = renameStanding(field, from, to, marks);
    if (standing === 'todo')
      steps.push({ do: 'rename', target: name, at: field, from: old, says: `rename ${old} → ${field}` });
    if (standing === 'done') stale.push(staleRename(name, field, old));
    if (standing === 'refused') steps.push(refusedRename(name, field, old, from));
  }
  return { steps, stale };
}

/** A `renamed` that has done its work: the column carries its name now, and a fresh database has nothing to rename. */
function staleRename(name: string, field: string, old: string): Stale {
  return {
    target: name,
    at: field,
    says: `renamed.${field} has been applied`,
    hint: `remove "renamed": { "${field}": "${old}" } from the ${name} collection once every database has applied it`,
  };
}

/** A field the record holds under its own name, or under the name `renamed` says it had. */
function standingOf(field: string, from: Declared, to: Declared, marks: CollectionMarks): DeclaredField | undefined {
  const old = renameOf(field, from, to, marks);
  return from.fields[old ?? field];
}

/**
 * A step over a column that may carry a value for the rows already there. A `defaults` the store declares is
 * said in the step's own words, since what a row receives is the difference between a step that can run and one
 * that cannot.
 */
function withDefault(step: Step, value: unknown): Step {
  if (value === undefined) return step;
  return { ...step, default: value, says: `${step.says}, default ${JSON.stringify(value)}` };
}

/**
 * Point 4, an added field: what a row already there receives is the store's `defaults`, and nothing else. A
 * required column with no default has every existing row to answer for and none of them holds a value, so it
 * says what it would cost exactly as `require` does; the step is refused at a count unless allowed as
 * destructive, and step 4 classes it from the count and this line.
 */
function addStep(name: string, field: string, declared: DeclaredField, marks: CollectionMarks): Step {
  const said = declared.required ? 'required' : 'optional';
  const value = marks.defaults?.[field];
  const step: Step = { do: 'add', target: name, at: field, says: `add ${field}  ${declared.type}, ${said}` };
  const costs = declared.required && value === undefined ? { ...step, loses: `rows with no ${field}` } : step;
  return withDefault(costs, value);
}

/** One field the record and the tree both hold, under the name it carries now: what it was, and what it is. */
interface Both {
  field: string;
  was: DeclaredField;
  now: DeclaredField;
}

/** Point 4, a field made required: what the empty rows receive is the store's `defaults`, or they are what it loses. */
function requireStep(name: string, both: Both, marks: CollectionMarks): Step {
  const step: Step = {
    do: 'require',
    target: name,
    at: both.field,
    says: `require ${both.field}`,
    loses: `rows with no ${both.field}`,
  };
  return withDefault(step, marks.defaults?.[both.field]);
}

/** Point 4, a field kept in another type: a cast the engine chooses, and the values no cast can carry. */
function retypeStep(name: string, both: Both): Step {
  const { field, was, now } = both;
  return {
    do: 'retype',
    target: name,
    at: field,
    was: was.type,
    says: `retype ${field}  ${was.type} → ${now.type}`,
    loses: `values of ${field} no cast can carry from ${was.type} to ${now.type}`,
  };
}

/** Point 4, a field both hold: a changed type, a tightened requirement, a relaxed one -- in that order. */
function changedSteps(name: string, both: Both, marks: CollectionMarks): Step[] {
  const { field, was, now } = both;
  const steps: Step[] = [];
  if (was.type !== now.type) steps.push(retypeStep(name, both));
  if (!was.required && now.required) steps.push(requireStep(name, both, marks));
  if (was.required && !now.required) steps.push({ do: 'relax', target: name, at: field, says: `relax ${field}` });
  return steps;
}

/** Point 4, a field the record holds and the tree no longer declares, under either of its names. */
function removeSteps(name: string, from: Declared, to: Declared, marks: CollectionMarks): Step[] {
  const kept = new Set(Object.keys(to.fields).map(field => renameOf(field, from, to, marks) ?? field));
  return Object.keys(from.fields)
    .filter(field => !kept.has(field))
    .map(field => ({
      do: 'remove' as const,
      target: name,
      at: field,
      says: `remove ${field}`,
      loses: `values of ${field} in every row that holds one`,
    }));
}

/** Point 4: every field step of one collection, renames first so the rest read against the names now. */
function fieldSteps(name: string, from: Declared, to: Declared, marks: CollectionMarks): Planned {
  const renames = renameSteps(name, from, to, marks);
  const steps = [...renames.steps];
  for (const [field, declared] of Object.entries(to.fields)) {
    const was = standingOf(field, from, to, marks);
    if (!was) steps.push(addStep(name, field, declared, marks));
    else steps.push(...changedSteps(name, { field, was, now: declared }, marks));
  }
  steps.push(...removeSteps(name, from, to, marks));
  return { steps, stale: renames.stale };
}

/** Points 3, 4 and 5 together: what changed inside a collection both the record and the tree hold. */
export function fieldAndConstraintSteps(name: string, from: Declared, to: Declared, marks: CollectionMarks): Planned {
  const key = keySteps(name, from, to);
  const fields = fieldSteps(name, from, to, marks);
  const constraints = constraintSteps(name, from, to, marks);
  return { steps: [...key, ...fields.steps, ...constraints], stale: fields.stale };
}
