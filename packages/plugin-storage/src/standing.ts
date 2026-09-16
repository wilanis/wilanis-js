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
 * The collections this plan brings into existence itself. A `create` is the first step of its collection and
 * every later step of the same plan is against a table that does not exist yet, so asking a database to count
 * rows in one is asking about a relation it has never heard of -- which is not zero rows, it is an error.
 */
function beingCreated(steps: Step[]): Set<string> {
  return new Set(steps.filter(step => step.do === 'create').map(step => step.target));
}

/**
 * How many rows stand in this step's way. A step of a collection the same plan opens with `create` has none by
 * construction: the table is not there to hold a row, and the guarantees that follow the `create` are over
 * columns made empty a moment earlier. The engine is not asked, because there is nothing yet to ask it about.
 */
async function rowsFor(engine: Engine, on: On, step: Step, fresh: Set<string>): Promise<number> {
  if (!counts(step) || fresh.has(step.target)) return 0;
  return engine.rows(on, step);
}

/**
 * Every step classed, with the row count the engine answered where the count changes the answer. `attempts` is
 * handed to the classing because which casts an engine writes is that engine's table and no count answers it:
 * a pair it refuses is refused on an empty table exactly as on a full one.
 */
export async function classedSteps(engine: Engine, on: On, steps: Step[]): Promise<Classed[]> {
  const fresh = beingCreated(steps);
  const out: Classed[] = [];
  for (const step of steps) {
    const rows = await rowsFor(engine, on, step, fresh);
    out.push(classed(step, rows, { attempts: (was, becomes) => engine.attempts(was, becomes) }));
  }
  return out;
}
