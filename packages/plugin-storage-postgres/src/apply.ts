/**
 * One plan applied to one connection: `BEGIN`, the statements in step order, the `wilanis_migrations` rows,
 * `COMMIT` (RFC 0017). PostgreSQL's DDL is transactional, which is what makes "one plan, one transaction" a
 * promise: a step that fails half way -- a row written between the count and the constraint -- rolls the whole
 * connection back, and the record is untouched, so the database and its record are never out of step.
 *
 * The record is written inside the same transaction as the steps and never beside it. That is the whole of why
 * a plan that failed leaves nothing behind to confuse the next one.
 */
import type { Applied, Applying, Recording, Step } from '@wilanis/plugin-storage';
import type { Kysely } from 'kysely';
import { ensureRecord, type Written, write } from './record.js';
import { applyStep } from './steps.js';

/** What each collection a step touched is said to have done, by the collection it is about. */
function saidBy(steps: Step[]): Map<string, string[]> {
  const said = new Map<string, string[]>();
  for (const step of steps) {
    const lines = said.get(step.target) ?? [];
    lines.push(step.says);
    said.set(step.target, lines);
  }
  return said;
}

/**
 * The name a `renameCollection` leaves behind. Its own row has to say the collection is gone, or the record
 * would answer for both names and the next plan would see a collection that is not there any more.
 */
function vacated(steps: Step[]): string[] {
  return steps.filter(step => step.do === 'renameCollection' && step.from).map(step => step.from as string);
}

/** What each collection the plan touched has to say about itself afterwards, as the record keeps it. */
function written(steps: Step[], record: Recording): Written[] {
  const said = saidBy(steps);
  const rows: Written[] = [];
  for (const [collection, declared] of Object.entries(record))
    rows.push({ collection, declared, steps: said.get(collection) ?? [] });
  const named = new Set(rows.map(one => one.collection));
  for (const collection of [...said.keys(), ...vacated(steps)])
    if (!named.has(collection)) {
      rows.push({ collection, declared: null, steps: said.get(collection) ?? [] });
      named.add(collection);
    }
  return rows;
}

/**
 * Apply every step and write the record, in one transaction. The steps run in the order the plan gave them,
 * which is the order that makes them possible: a table exists before a column is added to it, and a column
 * carries its name now before a constraint over it is created.
 */
export async function applyPlan(
  db: Kysely<never>,
  where: { schema: string; connection: string },
  plan: { steps: Step[]; record: Recording },
  applying: Applying,
): Promise<Applied | undefined> {
  const { schema, connection } = where;
  await ensureRecord(db, schema);
  if (!plan.steps.length && !Object.keys(plan.record).length) return undefined;
  const rows = written(plan.steps, plan.record);
  let wrote = { id: 0, appliedAt: new Date().toISOString() };
  await db.transaction().execute(async trx => {
    const on = trx as never as Kysely<never>;
    for (const step of plan.steps) await applyStep(on, schema, step, { declared: plan.record });
    wrote = await write(on, schema, rows, applying);
  });
  return {
    id: wrote.id,
    appliedAt: wrote.appliedAt,
    by: applying.by,
    tree: applying.tree,
    connection,
    targets: rows.map(one => one.collection),
    steps: Object.fromEntries(rows.map(one => [one.collection, one.steps])),
  };
}
