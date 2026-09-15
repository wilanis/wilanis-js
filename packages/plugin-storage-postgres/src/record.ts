/**
 * `wilanis_migrations`: the record this engine keeps of every plan that applied, in the database the plan
 * applied to (RFC 0017). A database carries its own history, so a fresh one carries none and a restored backup
 * carries exactly what it held when it was taken.
 *
 * The table is created on first contact, as `wilanis_schedule` is, and never by a step of a plan: a plan says
 * what the tree declares, and the record is this engine's own furniture. Nothing drops it.
 */

import type { Declared } from '@wilanis/plugin-storage';
import { type Kysely, sql } from 'kysely';

/** One row of the record, as the database reports it. */
interface Row {
  id: string | number;
  applied_at: Date | string;
  collection: string;
  declared: unknown;
  steps: unknown;
  tree: string;
  by: string;
}

/** The record's table, qualified by the connection's schema. */
const table = (schema: string) => sql`${sql.ref(schema)}.${sql.ref('wilanis_migrations')}`;

/**
 * Create the record's table where the schema has none, and leave it alone where it has one. Called before
 * anything reads or writes the record, so no caller has to know whether this is a database's first contact.
 */
export async function ensureRecord(db: Kysely<never>, schema: string): Promise<void> {
  await sql`
    create table if not exists ${table(schema)} (
      id bigint generated always as identity primary key,
      applied_at timestamptz not null default now(),
      collection text not null,
      declared jsonb,
      steps jsonb not null default '[]'::jsonb,
      tree text not null,
      by text not null
    )
  `.execute(db);
}

/** Every row of the record, latest first: what `history` reads and what the current entries are found in. */
async function rowsOf(db: Kysely<never>, schema: string): Promise<Row[]> {
  const answer = (await sql<Row>`
    select id, applied_at, collection, declared, steps, tree, by
    from ${table(schema)}
    order by id desc
  `.execute(db)) as { rows: Row[] };
  return answer.rows;
}

/** A jsonb column as the driver hands it back: an object already, or text this parses once. */
function parsed(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/**
 * The record's current entry for a collection: the `declared` of its latest row, or nothing where the
 * collection has no row at all or its latest one dropped it. A dropped collection's last row holds a null
 * `declared`, which is what makes "recorded and then dropped" different from "never recorded".
 */
export async function currentOf(db: Kysely<never>, schema: string, collection: string): Promise<Declared | undefined> {
  const answer = (await sql<Row>`
    select declared from ${table(schema)}
    where collection = ${collection}
    order by id desc limit 1
  `.execute(db)) as { rows: { declared: unknown }[] };
  const held = answer.rows[0];
  if (!held) return undefined;
  const declared = parsed(held.declared);
  return declared ? (declared as Declared) : undefined;
}

/** One instant as the record prints it, whatever the driver hands back. */
const instant = (at: Date | string) => (at instanceof Date ? at.toISOString() : new Date(at).toISOString());

/** The steps a row holds, as the plan printed them, or nothing where the row records no step at all. */
function stepsOf(value: unknown): string[] {
  const held = parsed(value);
  return Array.isArray(held) ? held.map(String) : [];
}

/** One migration as `history` answers it: every row that shares an id's plan, gathered by that plan. */
export interface Migration {
  id: number;
  appliedAt: string;
  by: string;
  tree: string;
  connection: string;
  targets: string[];
  steps: Record<string, string[]>;
}

/**
 * Every plan that applied on this connection, latest first. One plan writes one row per collection it touched,
 * all at the same instant and by the same runner, so the rows of a plan are gathered by that instant: the
 * identity column numbers rows and a plan is the rows it wrote together.
 */
export async function historyOf(db: Kysely<never>, schema: string, connection: string): Promise<Migration[]> {
  const rows = await rowsOf(db, schema);
  const byPlan = new Map<string, Migration>();
  for (const row of [...rows].reverse()) {
    const at = instant(row.applied_at);
    const key = `${at}|${row.by}|${row.tree}`;
    const plan = byPlan.get(key) ?? {
      id: Number(row.id),
      appliedAt: at,
      by: row.by,
      tree: row.tree,
      connection,
      targets: [],
      steps: {},
    };
    plan.id = Math.max(plan.id, Number(row.id));
    plan.targets.push(row.collection);
    plan.steps[row.collection] = stepsOf(row.steps);
    byPlan.set(key, plan);
  }
  return [...byPlan.values()].reverse();
}

/** What one plan writes about one collection: its declaration now, or null where the plan dropped it. */
export interface Written {
  collection: string;
  declared: Declared | null;
  steps: string[];
}

/**
 * Write one plan's rows, inside whatever session the caller is on -- which is the plan's own transaction, so
 * a record is never written for a change that did not apply. The id and the instant are the database's, and
 * every row of one plan shares the instant, which is what gathers them back into a plan on the way out.
 */
export async function write(
  db: Kysely<never>,
  schema: string,
  written: Written[],
  by: { by: string; tree: string },
): Promise<{ id: number; appliedAt: string }> {
  let id = 0;
  const at = new Date().toISOString();
  for (const one of written) {
    const declared = one.declared === null ? null : JSON.stringify(one.declared);
    const answer = (await sql<{ id: string | number }>`
      insert into ${table(schema)} (applied_at, collection, declared, steps, tree, by)
      values (${at}::timestamptz, ${one.collection}, ${declared}::jsonb, ${JSON.stringify(one.steps)}::jsonb, ${by.tree}, ${by.by})
      returning id
    `.execute(db)) as { rows: { id: string | number }[] };
    id = Math.max(id, Number(answer.rows[0]?.id ?? 0));
  }
  return { id, appliedAt: at };
}
