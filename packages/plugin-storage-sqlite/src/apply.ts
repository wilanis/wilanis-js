/**
 * One plan applied to one file: a handle of its own, `BEGIN IMMEDIATE`, the statements in step order, the
 * `wilanis_migrations` rows, `COMMIT` (RFC 0017). SQLite's DDL is transactional, so this engine's kind says
 * `transactionalDdl: true`, and "one plan, one transaction" is a promise: a step that fails half way -- a table
 * rebuild included, after its drop and its rename -- rolls the whole plan back, and the record is untouched.
 *
 * The record is written inside the same transaction as the steps and never beside it, so a plan that failed
 * leaves nothing behind to confuse the next one.
 */
import type { Applied, Applying, On, Recording, Step } from '@wilanis/plugin-storage';
import type { Handles } from './handles.js';
import { ensureKeys } from './keys.js';
import { folded } from './names.js';
import { ensureRecord, type Written, write } from './record.js';
import { applyStep } from './steps.js';

/**
 * Every row of the record is keyed by the folded name, which is the name SQLite compares a table by: `auditLog`
 * and `auditlog` are one table, and X233 refuses a store that means two by them. `recorded` asks by the folded
 * name too, so whichever spelling a plan was made under, the record answers it.
 */
const key = (collection: string) => folded(collection);

/** What each collection a step touched is said to have done, by the collection it is about. */
function saidBy(steps: Step[]): Map<string, string[]> {
  const said = new Map<string, string[]>();
  for (const step of steps) {
    const lines = said.get(key(step.target)) ?? [];
    lines.push(step.says);
    said.set(key(step.target), lines);
  }
  return said;
}

/** The names a `renameCollection` leaves behind: each one's row has to say the collection is gone. */
function vacated(steps: Step[]): string[] {
  return steps.filter(step => step.do === 'renameCollection' && step.from).map(step => key(step.from as string));
}

/** What each collection the plan touched says about itself afterwards, as the record keeps it. */
function written(steps: Step[], record: Recording): Written[] {
  const said = saidBy(steps);
  const rows: Written[] = Object.entries(record).map(([collection, declared]) => ({
    collection: key(collection),
    declared,
    steps: said.get(key(collection)) ?? [],
  }));
  const named = new Set(rows.map(one => one.collection));
  for (const collection of [...said.keys(), ...vacated(steps)])
    if (!named.has(collection)) {
      rows.push({ collection, declared: null, steps: said.get(collection) ?? [] });
      named.add(collection);
    }
  return rows;
}

/** Where a plan applies and who runs it: the handles of the file, its connection, the runner, and the key type. */
export interface Site {
  handles: Handles;
  on: On;
  applying: Applying;
  identity: boolean;
}

/**
 * Apply every step and write the record, in one transaction on a handle of the plan's own. The steps run in the
 * order the plan gave them, which is the order that makes them possible. A plan with nothing to do and nothing
 * to record writes no row and answers nothing.
 */
export async function applyPlan(plan: { steps: Step[]; record: Recording }, where: Site): Promise<Applied | undefined> {
  if (!plan.steps.length && !Object.keys(plan.record).length) return undefined;
  const rows = written(plan.steps, plan.record);
  const wrote = await where.handles.migrating(where.on, async db => {
    await ensureRecord(db);
    if (where.identity) await ensureKeys(db);
    for (const step of plan.steps) await applyStep(db, step, { declared: plan.record, identity: where.identity });
    return write(db, rows, where.applying);
  });
  return {
    id: wrote.id,
    appliedAt: wrote.appliedAt,
    by: where.applying.by,
    tree: where.applying.tree,
    connection: where.on.connection,
    targets: rows.map(one => one.collection),
    steps: Object.fromEntries(rows.map(one => [one.collection, one.steps])),
  };
}
