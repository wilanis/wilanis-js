/**
 * What both callers of the one planner ask the engine (RFC 0017): what every collection already is, and how
 * many rows stand in each step's way. `ensure` asks it at startup and `wilanis migrate` asks it from the
 * command line, and neither may ask it differently -- a step `ensure` calls additive and `migrate` calls
 * destructive would be two tables, not one, and the *Guide* table is one.
 *
 * It sits beside the planner rather than inside it because the planner is pure: nothing here decides anything,
 * it only puts the engine's answers in front of `plan.ts` and `plan-class.ts`, which decide.
 */
import type { Engine } from './engine.js';
import type { Declared, Step } from './plan.js';
import { type Classed, classed, counts } from './plan-class.js';
import type { On } from './record.js';

/** What every collection of a connection already is: the record's reading, and the catalog's. */
export interface Standing {
  /** what the record holds for a collection, by name; a collection it has never seen is absent */
  recorded: Record<string, Declared>;
  /** the catalog's reading of a collection the record has never seen: what an `adopt` is planned from */
  found: Record<string, Declared>;
  /** the catalog's reading of a collection the record *has* seen: what drift is judged against */
  catalog: Record<string, Declared>;
}

/**
 * What every collection of the store already is, as the connection knows it: the record first, and the catalog
 * beside it. A table the record does not hold is what the planner turns into an `adopt`, which is additive --
 * so a database that predates the record, or that an older `ensure` built, joins the record on first contact
 * rather than being refused.
 *
 * `catalog` is asked for only where the caller says it reads one, because it is a query per recorded
 * collection and only one caller has anything to do with the answer: drift is the pair of the record and the
 * catalog, and `wilanis migrate` judges it while a startup step judges the plan alone.
 */
export async function standing(engine: Engine, on: On, names: string[], reading = false): Promise<Standing> {
  const held: Standing = { recorded: {}, found: {}, catalog: {} };
  for (const name of names) await stand(engine, on, name, { held, reading });
  return held;
}

/**
 * One collection read into the standing: the record, and the catalog where the caller reads one or where the
 * record has nothing to say. Which of the three tables the catalog's reading lands in is what the record
 * answered -- a table the record has seen is what drift is judged against, and one it has not is an `adopt`.
 */
async function stand(engine: Engine, on: On, name: string, into: { held: Standing; reading: boolean }) {
  const kept = await engine.recorded(on, name);
  if (kept) into.held.recorded[name] = kept;
  if (kept && !into.reading) return;
  const table = await engine.inspect(on, name);
  if (!table) return;
  if (kept) into.held.catalog[name] = table;
  else into.held.found[name] = table;
}

/**
 * Every collection this connection has ever recorded, beside the ones the tree declares now. A `drop` is
 * planned for a collection the record holds and the tree no longer does, so the record has to be asked about
 * more than the store mentions -- and what it was ever asked to apply anything to is what its own history
 * names.
 *
 * A name the history answers is the name the *engine* keeps, which is not always the name the tree wrote: an
 * engine that folds an unquoted identifier records `auditLog` as `auditlog`, and taking both would leave one
 * of them undeclared and plan a `drop` of the table the other one is. So the two are compared through
 * `named`, and the tree's spelling wins where they are one collection -- the plan reads as the store does,
 * and only a name the tree really has stopped declaring is left over to be dropped.
 */
export async function everKnown(engine: Engine, on: On, declared: string[]): Promise<string[]> {
  const names = new Map(declared.map(name => [engine.named(name), name]));
  for (const record of await engine.history(on))
    for (const target of record.targets) {
      const under = engine.named(target);
      if (!names.has(under)) names.set(under, target);
    }
  return [...names.values()];
}

/**
 * What the steps of a plan before this one have done to the names, read as the plan goes. Every count is asked
 * of the database as it stands before the plan, since a plan is classed before it runs, so a step has to be
 * asked about in the names the database has *now*: a column a `rename` gives a new name is still under its old
 * one, a collection a `renameCollection` renames is still under its `from`, and a collection a `create` makes, or
 * a column an `add` makes, is not there at all.
 */
class Before {
  private readonly created = new Set<string>();
  private readonly collections = new Map<string, string>();
  private readonly fields = new Map<string, Map<string, string>>();
  private readonly added = new Map<string, Set<string>>();

  /** Take a step in, once it has been counted, so the steps after it are asked about in the right names. */
  note(step: Step): void {
    if (step.do === 'create') this.created.add(step.target);
    else if (step.do === 'renameCollection' && step.from) this.collections.set(step.target, this.collection(step.from));
    else if (step.do === 'rename' && step.at && step.from)
      this.renamesOf(step.target).set(step.at, this.field(step.target, step.from));
    else if (step.do === 'add' && step.at) this.addedTo(step.target).add(step.at);
  }

  /** Whether the plan makes this collection itself, so the database has no table for it yet. */
  isCreated(collection: string): boolean {
    return this.created.has(collection);
  }

  /** Whether the plan adds this column itself, so every row the database holds leaves it empty. */
  isAdded(collection: string, field: string): boolean {
    return this.added.get(collection)?.has(field) ?? false;
  }

  /** The step as the database names what it is about before the plan: its collection, its column, its target. */
  asked(step: Step): Step {
    const field = (name: string) => this.field(step.target, name);
    const asked: Step = { ...step, target: this.collection(step.target) };
    if (step.at !== undefined) asked.at = field(step.at);
    if (step.over) asked.over = step.over.map(field);
    if (step.to) asked.to = this.collection(step.to);
    return asked;
  }

  private collection(name: string): string {
    return this.collections.get(name) ?? name;
  }

  private field(collection: string, name: string): string {
    return this.fields.get(collection)?.get(name) ?? name;
  }

  private renamesOf(collection: string): Map<string, string> {
    const held = this.fields.get(collection) ?? new Map<string, string>();
    this.fields.set(collection, held);
    return held;
  }

  private addedTo(collection: string): Set<string> {
    const held = this.added.get(collection) ?? new Set<string>();
    this.added.set(collection, held);
    return held;
  }
}

/** Whether a guarantee is over a column the same plan adds: every row leaves it empty, and empty breaks no guarantee. */
function overAdded(step: Step, before: Before): boolean {
  if (step.do === 'unique') return (step.over ?? []).some(field => before.isAdded(step.target, field));
  return step.do === 'ref' && before.isAdded(step.target, step.at ?? '');
}

/**
 * How many rows stand in this step's way, asked of the database in the names it has before the plan. A step of
 * a collection the plan creates has none: the table is not there to hold a row. A guarantee over a column the
 * plan adds has none either. A `ref` to a collection the plan creates is broken by every row that names a
 * record, since the target will hold none; that is the rows holding a value, which is what a `remove` counts,
 * so the engine is asked that and nothing new.
 */
async function rowsFor(engine: Engine, on: On, step: Step, before: Before): Promise<number> {
  if (!counts(step) || before.isCreated(step.target) || overAdded(step, before)) return 0;
  const asked = before.asked(step);
  if (step.do === 'ref' && step.to && before.isCreated(step.to))
    return engine.rows(on, { do: 'remove', target: asked.target, at: asked.at, says: asked.says });
  return engine.rows(on, asked);
}

/**
 * Every step classed, with the row count the engine answered where the count changes the answer. `attempts` is
 * handed to the classing because which casts an engine writes is that engine's table and no count answers it:
 * a pair it refuses is refused on an empty table exactly as on a full one. The steps are walked in plan order,
 * each counted before it is noted, so each is asked about in the names the steps before it leave untouched.
 */
export async function classedSteps(engine: Engine, on: On, steps: Step[]): Promise<Classed[]> {
  const before = new Before();
  const out: Classed[] = [];
  for (const step of steps) {
    const rows = await rowsFor(engine, on, step, before);
    out.push(classed(step, rows, { attempts: (was, becomes) => engine.attempts(was, becomes) }));
    before.note(step);
  }
  return out;
}
