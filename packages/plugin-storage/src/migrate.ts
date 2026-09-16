/**
 * `@storage`'s `migrate` member (RFC 0017, step 7): the join between the one planner and `wilanis migrate`.
 * `ensure` is the other caller of that planner, and this one differs from it in exactly three ways -- it plans
 * every store of the tree rather than one, it prints before it applies, and it takes the operator's word for a
 * destructive step. Everything between the two declarations is `plan.ts`'s, as it is there.
 *
 * What the runtime sees is a `Plan`: targets ordered by connection path, each with steps carrying a class, a
 * line of text and what would be lost. It never sees a collection, a column or a `Step` of this plugin's own
 * union -- `lowerStep` is the one place the two vocabularies meet, and `target` is the collection, `at` the
 * field, exactly as the contract says.
 *
 * `apply` never plans again. The runtime hands back the targets whose every step it allows, and this applies
 * what it planned for each of them: a second plan against a database a moment later is a second judgement, and
 * the operator allowed the one they read. What was planned is kept per environment, the way `engines(env)` is.
 */
import { hostname, userInfo } from 'node:os';
import type { Applied, MigrateContext, Plan, PlanStep, PlanTarget } from '@wilanis/core';
import { driftOf } from './drift.js';
import type { Engine } from './engine.js';
import { keyOf } from './engine.js';
import { type Gathered, gathered } from './migrate-stores.js';
import { type Declared, declaredOfStore, marksOfStore, plan as planOf, type Stale, type Step } from './plan.js';
import type { Classed } from './plan-class.js';
import type { Applying, Recording } from './record.js';
import { classedSteps, everKnown, type Standing, standing } from './standing.js';
import { engineFor } from './store.js';

/** What an engine that keeps nothing between processes is said to be, rather than planned a `create` nobody keeps. */
const NOTHING_KEPT = 'nothing is kept between processes, so there is nothing to migrate';

/** The verb a stale mark is printed under: it is a line about the tree, and never a step an engine is given. */
const STALE = 'stale';

/** One connection's plan as this plugin holds it, so `apply` runs what was printed and never a second judgement. */
interface Held {
  on: Gathered['on'];
  steps: Step[];
  record: Recording;
}

/** What was planned under one environment, by connection: kept the way `engines(env)` is, so a reload starts clean. */
const planned = new WeakMap<object, Map<string, Held>>();

/**
 * The plans held for one environment, made on first use, so `plan` and `apply` of one run meet the same table.
 * Keyed the way the engines are, since the runtime builds a context per call and a copy of the environment is
 * the same environment: what `plan` wrote there is what `apply` a moment later reads.
 */
function holding(env: object): Map<string, Held> {
  const key = keyOf(env);
  let table = planned.get(key);
  if (!table) {
    table = new Map();
    planned.set(key, table);
  }
  return table;
}

/**
 * One of this plugin's steps as the runtime reads it. The class comes from the *Guide* table once the engine
 * has counted; a refused step carries its reason, which is the first thing the runtime reads and the only one
 * it needs -- a refused step refuses its whole connection whatever class it would otherwise have been.
 */
function lowerStep(one: Classed): PlanStep {
  return {
    do: one.step.do,
    target: one.step.target,
    at: one.step.at,
    class: one.class === 'refused' ? 'destructive' : one.class,
    says: one.step.says,
    loses: one.step.loses,
    rows: one.rows || undefined,
    refused: one.refused,
  };
}

/**
 * A mark that has done its work, as a line the runtime prints and no engine is ever given. A `renamed` the
 * record has already answered is not a change to make -- the column is renamed and the tree is right -- and
 * what is left is a line in the store document saying so. It is carried as an additive step with the edit in
 * `refused`, so the operator reads what to remove and the connection still applies everything else.
 */
function lowerStale(one: Stale): PlanStep {
  return { do: STALE, target: one.target, at: one.at, class: 'additive', says: one.says, refused: one.hint };
}

/** A connection nothing was planned for: an engine that keeps nothing, or a record the database moved away from. */
function unplanned(one: Gathered, why: { skipped?: string; drifted?: string[] }): PlanTarget {
  return { connection: one.on.connection, engine: one.engine, steps: [], ...why };
}

/**
 * Whether the record may be planned from, and the record to plan from. A collection the record holds and the
 * catalog disagrees with is drift: someone altered the table by hand, or a migration outside the tree ran, and
 * a plan from a record that is wrong would be wrong in ways the diff cannot see.
 *
 * `--adopt` is the operator saying the database is right and the record is behind, so the drifted collections
 * leave the record and join the catalog's: each is planned an `adopt` from what the table actually holds, then
 * the field steps against that, and the record is written from there.
 */
function judged(held: Standing, adopt: boolean): { drifted: string[]; recorded: Record<string, Declared> } {
  const drifted: string[] = [];
  const recorded = { ...held.recorded };
  for (const [name, record] of Object.entries(held.recorded)) {
    const said = driftOf(name, record, held.catalog[name]);
    if (!said.length) continue;
    drifted.push(...said);
    if (adopt) delete recorded[name];
  }
  return { drifted: adopt ? [] : drifted, recorded };
}

/** The record as this plan would leave it: every collection a step touched, under the declaration it now has. */
function recordingOf(declared: Record<string, Declared>, steps: Step[]): Recording {
  const record: Recording = {};
  for (const step of steps) if (declared[step.target]) record[step.target] = declared[step.target];
  return record;
}

/** One connection planned: the steps the two declarations differ by, counted by the engine and classed. */
async function targetOf(one: Gathered, engine: Engine, ctx: MigrateContext): Promise<PlanTarget> {
  if (!engine.keeps()) return unplanned(one, { skipped: NOTHING_KEPT });
  const declaring = one.lowering.declaring;
  const names = await everKnown(engine, one.on, Object.keys(declaring.collections));
  const held = await standing(engine, one.on, names, true);
  const { drifted, recorded } = judged(held, ctx.adopt);
  if (drifted.length) return unplanned(one, { drifted });
  const declared = declaredOfStore(declaring, one.lowering.shapeOf);
  const found = ctx.adopt ? { ...held.catalog, ...held.found } : held.found;
  const plan = planOf(recorded, declared, marksOfStore(declaring), found);
  const judgedSteps = await classedSteps(engine, one.on, plan.steps);
  const steps = judgedSteps.map(judgment => judgment.step);
  holding(ctx.env).set(one.on.connection, { on: one.on, steps, record: recordingOf(declared, steps) });
  return {
    connection: one.on.connection,
    engine: one.engine,
    steps: [...judgedSteps.map(lowerStep), ...plan.stale.map(lowerStale)],
  };
}

/** Whoever keeps this connection's records, or the reason nobody does, said as the line a target is skipped with. */
function reached(ctx: MigrateContext, one: Gathered): Engine | string {
  try {
    return engineFor(ctx.env, one.on);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * The plan for every store of the tree, one target per connection, ordered by canonical path. A connection
 * whose engine failed to register is skipped with the reason rather than throwing the whole command over: the
 * other connections are still worth planning, and the operator reads what stopped this one.
 */
export async function planStores(ctx: MigrateContext): Promise<Plan> {
  const targets: PlanTarget[] = [];
  for (const one of gathered(ctx)) {
    const engine = reached(ctx, one);
    targets.push(typeof engine === 'string' ? unplanned(one, { skipped: engine }) : await targetOf(one, engine, ctx));
  }
  return { targets };
}

/** Who a migration this command applied is recorded as having been run by, and from which tree. */
function applying(ctx: MigrateContext): Applying {
  return { by: `${userInfo().username}@${hostname()}`, tree: ctx.registry.project?.doc.name ?? 'unknown' };
}

/**
 * Apply the plan the runtime handed back: the targets whose every step it allows, each on its own connection
 * and in its own transaction, in the canonical-path order they were planned in. What comes back is one
 * `Applied` per connection that recorded something, which is what makes `2 connections: 1 applied, 1 refused`
 * printable -- and an engine that recorded nothing answers nothing rather than an empty row.
 */
export async function applyStores(ctx: MigrateContext, plan: Plan): Promise<Applied[]> {
  const table = holding(ctx.env);
  const applied: Applied[] = [];
  for (const target of plan.targets) {
    const held = table.get(target.connection);
    if (!held?.steps.length) continue;
    const engine = engineFor(ctx.env, held.on);
    const answer = await engine.apply(held.on, held.steps, held.record, applying(ctx));
    if (answer) applied.push(answer);
  }
  return applied;
}

/** Every plan every connection of the tree has a record of, connection by connection in canonical-path order. */
export async function historyOfStores(ctx: MigrateContext): Promise<Applied[]> {
  const out: Applied[] = [];
  for (const one of gathered(ctx)) {
    const engine = reached(ctx, one);
    if (typeof engine === 'string' || !engine.keeps()) continue;
    out.push(...(await engine.history(one.on)));
  }
  return out;
}
