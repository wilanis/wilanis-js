/**
 * `wilanis_migrations`: the record this engine keeps of every plan that applied, in the file the plan applied to
 * (RFC 0017). A file carries its own history, so a fresh one carries none and a copy carries exactly what it
 * held when it was copied.
 *
 * The table is made on first contact, as `wilanis_keys` is, and never by a step of a plan: a plan says what the
 * tree declares, and the record is this engine's own furniture. Nothing drops it. Its rows are the postgres
 * engine's, with `declared` and `steps` as JSON text and `applied_at` as an ISO instant, and one column more:
 * `plan`, the number of the plan that wrote the row. The postgres engine gathers a plan's rows by their
 * instant. A plan on a local file takes well under a millisecond, so two plans can share one instant here, and
 * the number is what tells them apart. It is also the migration's number, `recorded as migration 4`.
 */
import type { Applied, Declared } from '@wilanis/plugin-storage';
import { type Kysely, sql } from 'kysely';

/** The record's table. */
export const MIGRATIONS = 'wilanis_migrations';

/** One row of the record, as `history` reads it. */
interface Row {
  plan: number;
  applied_at: string;
  collection: string;
  steps: string;
  tree: string;
  by: string;
}

/** Make the record's table where the file has none, and leave it alone where it has one. */
export async function ensureRecord(db: Kysely<never>): Promise<void> {
  await sql`
    create table if not exists ${sql.id(MIGRATIONS)} (
      id INTEGER PRIMARY KEY,
      plan INTEGER NOT NULL,
      applied_at TEXT NOT NULL,
      collection TEXT NOT NULL,
      declared TEXT CHECK (declared IS NULL OR json_valid(declared)),
      steps TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(steps)),
      tree TEXT NOT NULL,
      "by" TEXT NOT NULL
    )
  `.execute(db);
}

/** JSON text as the record holds it, read once, or nothing where it does not read. */
function parsed(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The record's current entry for a collection: the `declared` of its latest row, or nothing where the
 * collection has no row at all or its latest one dropped it. A dropped collection's last row holds a null
 * `declared`, which is what makes "recorded and then dropped" different from "never recorded".
 */
export async function currentOf(db: Kysely<never>, collection: string): Promise<Declared | undefined> {
  const answer = await sql<{ declared: string | null }>`
    select declared from ${sql.id(MIGRATIONS)} where collection = ${collection} order by id desc limit 1
  `.execute(db);
  const held = answer.rows[0];
  if (!held) return undefined;
  const declared = parsed(held.declared);
  return declared ? (declared as Declared) : undefined;
}

/** The steps a row holds, as the plan printed them. */
function stepsOf(text: string): string[] {
  const held = parsed(text);
  return Array.isArray(held) ? held.map(String) : [];
}

/** One plan as this engine reads it back: the contract's `Applied`, with its `steps` always filled. */
type Gathered = Applied & { steps: Record<string, string[]> };

/** One row folded into the plan that wrote it. */
function gather(plans: Map<number, Gathered>, row: Row, connection: string): void {
  const plan = plans.get(row.plan) ?? {
    id: Number(row.plan),
    appliedAt: row.applied_at,
    by: row.by,
    tree: row.tree,
    connection,
    targets: [],
    steps: {},
  };
  plan.targets.push(row.collection);
  plan.steps[row.collection] = stepsOf(row.steps);
  plans.set(row.plan, plan);
}

/** Every plan that applied on this connection, latest first: one row per collection a plan touched, gathered by plan. */
export async function historyOf(db: Kysely<never>, connection: string): Promise<Applied[]> {
  const rows = await sql<Row>`
    select plan, applied_at, collection, steps, tree, "by" from ${sql.id(MIGRATIONS)} order by id
  `.execute(db);
  const plans = new Map<number, Gathered>();
  for (const row of rows.rows) gather(plans, row, connection);
  return [...plans.values()].reverse();
}

/** What one plan writes about one collection: its declaration now, or null where the plan dropped it. */
export interface Written {
  collection: string;
  declared: Declared | null;
  steps: string[];
}

/**
 * Write one plan's rows inside the plan's own transaction, so a record is never written for a change that did
 * not apply, and answer the plan's number and instant. The number is one past the last plan's: the plan holds
 * the file's write lock, so no other plan can take the same one.
 */
export async function write(
  db: Kysely<never>,
  written: Written[],
  by: { by: string; tree: string },
): Promise<{ id: number; appliedAt: string }> {
  const last = await sql<{ n: number | null }>`select max(plan) as n from ${sql.id(MIGRATIONS)}`.execute(db);
  const plan = Number(last.rows[0]?.n ?? 0) + 1;
  const at = new Date().toISOString();
  for (const one of written) {
    const declared = one.declared === null ? null : JSON.stringify(one.declared);
    await sql`
      insert into ${sql.id(MIGRATIONS)} (plan, applied_at, collection, declared, steps, tree, "by")
      values (${plan}, ${at}, ${one.collection}, ${declared}, ${JSON.stringify(one.steps)}, ${by.tree}, ${by.by})
    `.execute(db);
  }
  return { id: plan, appliedAt: at };
}
