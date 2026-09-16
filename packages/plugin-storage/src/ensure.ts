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
 * Every step classed, with the row count the engine answered where the count changes the answer. `attempts`
 * is handed to the classing because which casts an engine writes is that engine's table and no count answers
 * it: a pair it refuses is refused on an empty table exactly as on a full one.
 */
async function classedSteps(engine: Engine, on: On, steps: Step[]): Promise<Classed[]> {
  const out: Classed[] = [];
  for (const step of steps) {
    const rows = counts(step) ? await engine.rows(on, step) : 0;
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
 * prepared itself rather than that a person ran `wilanis migrate`.
 */
function applying(root: string): Applying {
  return { by: `${userInfo().username}@${hostname()} (startup)`, tree: basename(root) };
}

/**
 * The drift a step that is not additive refuses with: the steps one per line, each with its class and, where
 * the classing said why, the reason. The hint names the command that prints the whole plan and applies it
 * under the operator's eye, which is the one thing a startup step will never do on its own.
 */
function drift(steps: Classed[], root: string, profile: string | undefined): Error {
  const lines = steps.map(one => `  ${one.step.says}  (${one.class})${one.refused ? ` -- ${one.refused}` : ''}`);
  const flag = profile ? ` --profile ${profile}` : '';
  return new Error(
    `drift: the store declares changes this startup step will not make:\n${lines.join('\n')}\n` +
      `hint: run wilanis migrate ${root}${flag} to see the whole plan and apply it`,
  );
}

/** What the tree is rooted at and which profile it is running under, as the hint names them back to a reader. */
function where(env: Record<string, unknown>): { root: string; profile: string | undefined } {
  const root = typeof env.root === 'string' ? env.root : '.';
  const profile = typeof env.profile === 'string' ? env.profile : undefined;
  return { root, profile };
}

/** The way a startup step says what it did, where the tree is being served; a run outside one says nothing. */
function logger(env: Record<string, unknown>): (line: string) => void {
  const serving = env.serving as { log?: (line: string) => void } | undefined;
  const log = serving?.log;
  return typeof log === 'function' ? line => log(line) : () => undefined;
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
  const { root, profile } = where(env);
  if (judged.some(one => one.class !== 'additive')) throw drift(judged, root, profile);
  const steps = judged.map(one => one.step);
  if (!steps.length) return { ...NOTHING_MADE };
  const applied = await engine.apply(store.on, steps, recording(declared, steps), applying(root));
  if (!applied) return { ...NOTHING_MADE };
  logAdoptions(steps, store.on.connection, logger(env));
  return madeBy(steps);
}
