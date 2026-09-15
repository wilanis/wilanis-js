/**
 * What each step of a plan is, as one statement (RFC 0017). A `rename` is `RENAME COLUMN`, an `add` with a
 * default is `ADD COLUMN ... DEFAULT` followed by `DROP DEFAULT` exactly as `ensure` does it, a `retype` is
 * `ALTER COLUMN ... TYPE ... USING` with the cast `casts.ts` chose.
 *
 * Every statement here is DDL, and PostgreSQL's DDL is transactional, which is what makes "one plan, one
 * transaction" a promise rather than a hope: the session these run on is the plan's, so a step that fails
 * half way leaves the database as it was and the record untouched.
 */
import type { Declared, Step } from '@wilanis/plugin-storage';
import { type Kysely, sql } from 'kysely';
import { castTo, columnFor } from './casts.js';
import { folded } from './columns.js';
import { refName, uniqueName } from './names.js';

/** The table a step is about, qualified by the connection's schema. */
const tableOf = (schema: string, name: string) => sql`${sql.ref(schema)}.${sql.ref(folded(name))}`;

/** A default as DDL spells it: Postgres prepares DDL with no parameters, so the literal is written out. */
function literal(value: unknown, type: string): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const json = type === 'jsonb';
  const text = json ? JSON.stringify(value) : String(value);
  const quoted = `'${text.replace(/'/g, "''")}'`;
  return json ? `${quoted}::jsonb` : quoted;
}

/** Create the table a collection is, with every column and the primary key; constraints follow as their own steps. */
async function create(db: Kysely<never>, schema: string, step: Step, to: Declared): Promise<void> {
  const columns = Object.entries(to.fields).map(([name, field]) => {
    const nullable = field.required || name === to.key ? ' not null' : '';
    return sql`${sql.ref(folded(name))} ${sql.raw(columnFor(field.type))}${sql.raw(nullable)}`;
  });
  const key = sql`primary key (${sql.ref(folded(to.key))})`;
  await sql`create table ${tableOf(schema, step.target)} (${sql.join([...columns, key])})`.execute(db);
}

/**
 * Add a column, with the default the store declared for the rows already there and dropped again at once: the
 * default was for the rows that existed, and what a graph writes always gives the whole record.
 *
 * A required field is `NOT NULL` whether or not a default was declared, exactly as `ensure` adds one: the
 * record says the column is required, and a column the record calls required and the catalog calls optional is
 * a drift the next plan cannot see. Whether the rows already there can answer for it is the plan's judgement
 * and not this statement's -- a required `add` with no default over a table with rows is destructive, and
 * either the operator allowed it or the step never reached here.
 */
async function add(db: Kysely<never>, schema: string, step: Step, to: Declared): Promise<void> {
  const field = to.fields[step.at ?? ''];
  if (!field) throw new Error(`add ${step.target}.${step.at}: the tree declares no such field`);
  const column = sql.ref(folded(step.at ?? ''));
  const type = columnFor(field.type);
  const has = step.default !== undefined;
  const fill = has ? sql` default ${sql.raw(literal(step.default, type))}` : sql``;
  const notNull = field.required ? sql` not null` : sql``;
  const table = tableOf(schema, step.target);
  await sql`alter table ${table} add column ${column} ${sql.raw(type)}${fill}${notNull}`.execute(db);
  if (has) await sql`alter table ${table} alter column ${column} drop default`.execute(db);
}

/** Make a column required, filling whatever is empty with the declared default first where there is one. */
async function require_(db: Kysely<never>, schema: string, step: Step): Promise<void> {
  const column = sql.ref(folded(step.at ?? ''));
  const table = tableOf(schema, step.target);
  if (step.default !== undefined) {
    const value = sql.raw(literal(step.default, 'text'));
    await sql`update ${table} set ${column} = ${value} where ${column} is null`.execute(db);
  }
  await sql`alter table ${table} alter column ${column} set not null`.execute(db);
}

/**
 * Change a column's type, through text, which is the one reading every type this engine keeps has in common.
 * A pair `casts.ts` refuses never reaches here: the plan refuses the step with the count of what is at stake,
 * and a refused step is never applied.
 */
async function retype(db: Kysely<never>, schema: string, step: Step): Promise<void> {
  if (!step.was || !step.becomes) throw new Error(`retype ${step.target}.${step.at}: the step names no pair of types`);
  if (castTo(step.was, step.becomes) === 'refused')
    throw new Error(
      `retype ${step.target}.${step.at}: this engine attempts no cast from ${step.was} to ${step.becomes}`,
    );
  const type = columnFor(step.becomes);
  const column = sql.ref(folded(step.at ?? ''));
  await sql`
    alter table ${tableOf(schema, step.target)}
    alter column ${column} type ${sql.raw(type)} using ${column}::text::${sql.raw(type)}
  `.execute(db);
}

/** Add the unique constraint a `unique` step is, under the name `ensure` would have given it. */
async function unique(db: Kysely<never>, schema: string, step: Step): Promise<void> {
  const over = step.over ?? [];
  const name = uniqueName(step.target, over);
  const columns = sql.join(over.map(field => sql.ref(folded(field))));
  await sql`alter table ${tableOf(schema, step.target)} add constraint ${sql.ref(name)} unique (${columns})`.execute(
    db,
  );
}

/**
 * Add the foreign key a `ref` step is. The target's columns are left unsaid, which makes PostgreSQL reference
 * that table's primary key -- which is the collection's key, since that is what `create` makes it -- so this
 * step needs to know nothing about a collection the plan may not touch at all.
 */
async function ref(db: Kysely<never>, schema: string, step: Step): Promise<void> {
  const name = refName(step.target, step.at ?? '');
  await sql`
    alter table ${tableOf(schema, step.target)} add constraint ${sql.ref(name)}
    foreign key (${sql.ref(folded(step.at ?? ''))}) references ${tableOf(schema, step.to ?? '')}
  `.execute(db);
}

/** Drop a constraint by the name this engine created it under; `if exists` because the record may be ahead. */
async function unconstrain(db: Kysely<never>, schema: string, name: string, target: string): Promise<void> {
  await sql`alter table ${tableOf(schema, target)} drop constraint if exists ${sql.ref(name)}`.execute(db);
}

/**
 * What one step needs beyond itself: the record the plan is about to write, which is every touched collection
 * as the tree declares it now (and null for the ones the plan drops). A `create` reads its columns from it, an
 * `add` the type of the column, and a `ref` the key of the collection it points at, so nothing here has to be
 * handed the tree as well as the plan.
 *
 * Named for what it holds rather than for the act, since `Applying` is the contract's word for who is running
 * a plan (`{ by, tree }`) and one word must not mean two things in one package.
 */
export interface Against {
  declared: Record<string, Declared | null>;
}

/** The simple statements: the ones that name one table or one column and need nothing else said about them. */
async function simple(db: Kysely<never>, schema: string, step: Step): Promise<boolean> {
  const table = tableOf(schema, step.target);
  const column = sql.ref(folded(step.at ?? ''));
  if (step.do === 'drop') await sql`drop table if exists ${table} cascade`.execute(db);
  else if (step.do === 'renameCollection')
    await sql`alter table ${tableOf(schema, step.from ?? '')} rename to ${sql.ref(folded(step.target))}`.execute(db);
  else if (step.do === 'rename')
    await sql`alter table ${table} rename column ${sql.ref(folded(step.from ?? ''))} to ${column}`.execute(db);
  else if (step.do === 'remove') await sql`alter table ${table} drop column if exists ${column}`.execute(db);
  else if (step.do === 'relax') await sql`alter table ${table} alter column ${column} drop not null`.execute(db);
  else return false;
  return true;
}

/** The constraint statements: what a guarantee is added or dropped by, under the name `ensure` gives it. */
async function constrain(db: Kysely<never>, schema: string, step: Step): Promise<boolean> {
  if (step.do === 'unique') await unique(db, schema, step);
  else if (step.do === 'ununique') await unconstrain(db, schema, uniqueName(step.target, step.over ?? []), step.target);
  else if (step.do === 'ref') await ref(db, schema, step);
  else if (step.do === 'unref') await unconstrain(db, schema, refName(step.target, step.at ?? ''), step.target);
  else return false;
  return true;
}

/** The statements that read what the tree declares: the whole table a `create` makes, and a column's type. */
async function declaring(db: Kysely<never>, schema: string, step: Step, to: Declared | null): Promise<boolean> {
  if (step.do === 'create' && to) await create(db, schema, step, to);
  else if (step.do === 'add' && to) await add(db, schema, step, to);
  else if (step.do === 'require') await require_(db, schema, step);
  else if (step.do === 'retype') await retype(db, schema, step);
  else return false;
  return true;
}

/**
 * One step applied, on whatever session the caller is on. An `adopt` runs no statement at all: the table is
 * already what the record will say it is, and adopting it is writing that record and nothing more.
 */
export async function applyStep(db: Kysely<never>, schema: string, step: Step, ctx: Against): Promise<void> {
  if (step.do === 'adopt') return;
  if (await simple(db, schema, step)) return;
  if (await constrain(db, schema, step)) return;
  if (await declaring(db, schema, step, ctx.declared[step.target] ?? null)) return;
  throw new Error(`this engine has no statement for the step '${step.do}' on ${step.target}`);
}
