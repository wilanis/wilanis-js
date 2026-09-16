/**
 * `ensure` over the planner (RFC 0017, step 5): the work behind `@storage/storage.port.json#ensure`, which is
 * one caller of the one planner and `wilanis migrate` is the other. Nothing here compares a column with a
 * catalog -- that comparison is `inspect`'s, on the engine, since step 4 -- so what a startup step prepares
 * and what the command prints are the same steps, judged by the same table.
 *
 * The rule the port promises has not moved: additive everywhere, destructive nowhere. What changed is who
 * decides. A step is classed by RFC 0017's *Guide* table once the engine has counted the rows in its way, and
 * `ensure` applies the plan only where every step came back additive. One that did not is `drift`: thrown and
 * never answered, because drift is not a graph's outcome but a startup failure, and it stops the tree the way
 * an unreachable database does.
 */

import { hostname, userInfo } from 'node:os';
import { basename } from 'node:path';
import type { Type } from '@wilanis/core';
import type { Engine, Made } from './engine.js';
import { type Declared, type Declaring, declaredOfStore, marksOfStore, plan, type Step } from './plan.js';
import { type Classed, classed, counts } from './plan-class.js';
import type { Applying, On, Recording } from './record.js';

/**
 * A store lowered far enough to plan against: the connection it sits on, the collections it declares with
 * their marks, and the way to resolve the shape each names. `storeFor` in `store.ts` reads one off the tree.
 */
export interface Lowering {
  on: On;
  declaring: Declaring;
  shapeOf: (of: string) => Type;
}

/** Nothing made, which is what an engine with nothing to create answers and what a second run answers too. */
export const NOTHING_MADE: Made = { collections: 0, columns: 0, constraints: 0 };

/** Which steps count as a collection, a column or a constraint created, so `ensure` answers what it made. */
const MADE_BY: Record<string, keyof Made> = {
  create: 'collections',
  adopt: 'collections',
  add: 'columns',
  unique: 'constraints',
  ref: 'constraints',
};

/**
 * What every collection of the store already is, as the connection knows it: the record first, and the
 * catalog for the ones the record has never seen. A table the record does not hold is what the planner turns
 * into an `adopt`, which is additive -- so a database that predates the record, or that an older `ensure`
 * built, joins the record on first contact rather than being refused as drift.
 */
async function standing(engine: Engine, on: On, names: string[]) {
  const recorded: Record<string, Declared> = {};
  const found: Record<string, Declared> = {};
  for (const name of names) {
    const kept = await engine.recorded(on, name);
    if (kept) {
      recorded[name] = kept;
      continue;
    }
    const table = await engine.inspect(on, name);
    if (table) found[name] = table;
  }
  return { recorded, found };
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
 * How many rows stand in this step's way. A step of a collection the same plan opens with `create` has none
 * by construction: the table is not there to hold a row, and the guarantees that follow the `create` are over
 * columns made empty a moment earlier. The engine is not asked, because there is nothing yet to ask it about.
 */
async function rowsFor(engine: Engine, on: On, step: Step, fresh: Set<string>): Promise<number> {
  if (!counts(step) || fresh.has(step.target)) return 0;
  return engine.rows(on, step);
}

/**
 * Every step classed, with the row count the engine answered where the count changes the answer. `attempts`
 * is handed to the classing because which casts an engine writes is that engine's table and no count answers
 * it: a pair it refuses is refused on an empty table exactly as on a full one.
 */
async function classedSteps(engine: Engine, on: On, steps: Step[]): Promise<Classed[]> {
  const fresh = beingCreated(steps);
  const out: Classed[] = [];
  for (const step of steps) {
    const rows = await rowsFor(engine, on, step, fresh);
    out.push(classed(step, rows, { attempts: (was, becomes) => engine.attempts(was, becomes) }));
  }
  return out;
}

/** The record as the plan leaves it: every collection the store declares, under the declaration it now has. */
function recording(declared: Record<string, Declared>, steps: Step[]): Recording {
  const record: Recording = {};
  for (const step of steps) if (declared[step.target]) record[step.target] = declared[step.target];
  return record;
}

/** What the applied steps created, counted by what each one makes: a collection, a column or a constraint. */
function madeBy(steps: Step[]): Made {
  const made: Made = { ...NOTHING_MADE };
  for (const step of steps) {
    const what = MADE_BY[step.do];
    if (what) made[what] += 1;
  }
  return made;
}

/**
 * Who a migration this `ensure` applied is recorded as having been run by, and from which tree. A startup
 * step is nobody's hand on a keyboard, so it says so: the operator reading the history sees that the tree
 * prepared itself rather than that a person ran `wilanis migrate`. The tree is named by the directory it is
 * rooted at, which is what `env.serving` knows about it; a run outside a served tree names none.
 */
function applying(root: string | undefined): Applying {
  return { by: `${userInfo().username}@${hostname()} (startup)`, tree: root ? basename(root) : 'unknown' };
}

/**
 * The drift a step that is not additive refuses with: the steps one per line, each with its class and, where
 * the classing said why, the reason. The hint names the command that prints the whole plan and applies it
 * under the operator's eye, which is the one thing a startup step will never do on its own.
 *
 * The profile is not in the hint because a handler cannot know it: it is a compile option the `Embedder`
 * holds and never puts on the environment, so naming one would mean naming a guess. The hint says which
 * flag to add instead of printing a command that would run under the wrong bindings.
 */
function drift(steps: Classed[], root: string | undefined): Error {
  const lines = steps.map(one => `  ${one.step.says}  (${one.class})${one.refused ? ` -- ${one.refused}` : ''}`);
  const where = root ?? 'the tree';
  return new Error(
    `drift: the store declares changes this startup step will not make:\n${lines.join('\n')}\n` +
      `hint: run wilanis migrate ${where} --profile <the profile this tree starts under> ` +
      'to see the whole plan and apply it',
  );
}

/**
 * What a handler can learn about the tree being served: where it is rooted, and how to say something to
 * whoever started it. Both come from `env.serving`, which the runtime sets before it runs a startup step --
 * a run outside one (a graph under test, a rehearsal) has neither, and says so by answering nothing.
 */
function serving(env: Record<string, unknown>): { root?: string; log: (line: string) => void } {
  const held = env.serving as { root?: unknown; log?: (line: string) => void } | undefined;
  const log = held?.log;
  return {
    root: typeof held?.root === 'string' ? held.root : undefined,
    log: typeof log === 'function' ? line => log(line) : () => undefined,
  };
}

/**
 * A table the record has never seen is adopted rather than created, and that is worth a line. An adopt writes
 * the record from the database as it stands: it changes no table, so it is additive and the start goes on --
 * but it is the moment a database that predates the record joins it, and the operator reading the log is
 * the one who can say whether the table it adopted is the one the store meant.
 */
function logAdoptions(steps: Step[], connection: string, log: (line: string) => void): void {
  for (const step of steps)
    if (step.do === 'adopt')
      log(`ensure: ${connection}: ${step.says} -- the record had never seen it, and now holds what the table is`);
}

/**
 * Make the store ready to answer, and say what that created. The steps come from the one planner, the counts
 * and the applying from the engine, and the judgement from the *Guide* table: every step additive and the
 * plan applies; one that is not and the whole store refuses, since a plan is one transaction and half of it
 * is worse than none of it.
 *
 * What is counted is what `apply` says it applied, never what the plan asked for. An engine that keeps
 * nothing between processes records nothing, finds nothing and applies nothing, so it is planned a `create`
 * for every collection and answers that none of them happened -- which is the honest count, and is how
 * `ensure` on such an engine keeps answering zeros over the planner exactly as it did before it.
 */
export async function ensureStore(engine: Engine, store: Lowering, env: Record<string, unknown>): Promise<Made> {
  const names = Object.keys(store.declaring.collections);
  if (!names.length) return { ...NOTHING_MADE };
  const declared = declaredOfStore(store.declaring, store.shapeOf);
  const { recorded, found } = await standing(engine, store.on, names);
  const planned = plan(recorded, declared, marksOfStore(store.declaring), found);
  const judged = await classedSteps(engine, store.on, planned.steps);
  const { root, log } = serving(env);
  if (judged.some(one => one.class !== 'additive')) throw drift(judged, root);
  const steps = judged.map(one => one.step);
  if (!steps.length) return { ...NOTHING_MADE };
  const applied = await engine.apply(store.on, steps, recording(declared, steps), applying(root));
  if (!applied) return { ...NOTHING_MADE };
  logAdoptions(steps, store.on.connection, log);
  return madeBy(steps);
}
