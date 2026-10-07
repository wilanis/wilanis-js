/**
 * What each step of a plan is on this engine (RFC 0017): one statement where SQLite's `ALTER TABLE` takes the
 * step in place, and a table rebuild (`rebuild.ts`) where it does not. In place: a `create` is `CREATE TABLE`
 * with every column, the key and the references; a `rename` is `RENAME COLUMN`; a `renameCollection` is
 * `RENAME TO`; an `add` is `ADD COLUMN`, with the declared default; a `unique` is a unique index, made within
 * the scope on a scoped table, as `ensure` makes one. Everything else is remade (`changes.ts`).
 *
 * Every statement runs on the plan's own handle, inside its one transaction: SQLite's DDL is transactional, so
 * a step that fails half way leaves the file as it was and the record untouched.
 */
import type { Declared, DeclaredField, Recording, Step } from '@wilanis/plugin-storage';
import { type Kysely, sql } from 'kysely';
import { attempts, carries } from './casts.js';
import { indexColumnsOf } from './catalog.js';
import { changeOf } from './changes.js';
import { quoted } from './columns.js';
import { checkFor, columnFor, createTableSql, layoutOf, literal, same } from './ddl.js';
import { readTable } from './inspect.js';
import { scopedIndexName, scopedUniqueName, uniqueName } from './names.js';
import { rebuild } from './rebuild.js';

/**
 * What one step needs beyond itself: the record the plan is about to write, which is every touched collection
 * as the tree declares it now (null for one the plan drops), and whether a number key is SQLite's own integer
 * key, which the plugin's `keyType` says.
 */
export interface Against {
  declared: Recording;
  identity: boolean;
}

/** One statement of DDL, run on the plan's handle. */
const run = (db: Kysely<never>, statement: string) => sql.raw(statement).execute(db);

/** The field a step about a column is about, as the tree declares it now. */
const fieldOf = (step: Step, to: Declared | null | undefined): DeclaredField | undefined => to?.fields[step.at ?? ''];

/** Create the table a collection is: every column, the key and the references; uniques follow as their own steps. */
async function create(db: Kysely<never>, step: Step, to: Declared | null | undefined, identity: boolean) {
  if (!to) throw new Error(`create ${step.target}: the plan records no declaration for it`);
  await run(db, createTableSql(step.target, layoutOf(to, identity)));
}

/**
 * Add a column the table can take in place: an optional one, or a required one with the default the store
 * declares for the rows already there. The default stays on the column, since SQLite cannot drop one; nothing
 * reads it, because a `put` always writes the whole record.
 */
async function add(db: Kysely<never>, step: Step, field: DeclaredField | undefined) {
  if (!field) throw new Error(`add ${step.target}.${step.at}: the tree declares no such field`);
  const name = step.at ?? '';
  const fill = step.default === undefined ? '' : ` DEFAULT ${literal(step.default, field.type)}`;
  const notNull = field.required ? ' NOT NULL' : '';
  const check = checkFor(name, field.type);
  const checked = check ? ` CHECK (${check})` : '';
  await run(
    db,
    `ALTER TABLE ${quoted(step.target)} ADD COLUMN ${quoted(name)} ${columnFor(field.type)}${fill}${notNull}${checked}`,
  );
}

/**
 * Rename a table, and the index that tells which of its columns are a scope with it: that index is named for
 * the collection, so under the old name it would tell nothing about the new one. SQLite rewrites every
 * reference other tables make to the table it renames.
 */
async function renameCollection(db: Kysely<never>, step: Step) {
  const from = step.from ?? '';
  const scope = await indexColumnsOf(db, scopedIndexName(from));
  await run(db, `ALTER TABLE ${quoted(from)} RENAME TO ${quoted(step.target)}`);
  if (!scope.length) return;
  await run(db, `DROP INDEX ${quoted(scopedIndexName(from))}`);
  const over = scope.map(quoted).join(', ');
  await run(db, `CREATE INDEX ${quoted(scopedIndexName(step.target))} ON ${quoted(step.target)} (${over})`);
}

/** Make the unique index a `unique` step is: over its fields, with the scope columns in front on a scoped table. */
async function unique(db: Kysely<never>, step: Step) {
  const table = await readTable(db, step.target);
  const fields = step.over ?? [];
  const scope = table?.scope ?? [];
  const name = scope.length ? scopedUniqueName(step.target, scope, fields) : uniqueName(step.target, fields);
  const over = [...scope, ...fields].map(quoted).join(', ');
  await run(db, `CREATE UNIQUE INDEX ${quoted(name)} ON ${quoted(step.target)} (${over})`);
}

/** Drop the unique index that holds what an `ununique` step names, whatever it is called, scope columns aside. */
async function ununique(db: Kysely<never>, step: Step) {
  const table = await readTable(db, step.target);
  const fields = step.over ?? [];
  const named = (index: { columns: string[] }) => {
    const over = index.columns.filter(column => !table?.scope.some(one => same(one, column)));
    return over.length === fields.length && over.every((column, at) => same(column, fields[at] ?? ''));
  };
  for (const index of table?.indexes.filter(one => one.unique && !one.pk && named(one)) ?? [])
    await run(db, `DROP INDEX IF EXISTS ${quoted(index.name)}`);
}

/** The steps one statement takes, in place; false where this step is not one of them. */
async function inPlace(db: Kysely<never>, step: Step, ctx: Against): Promise<boolean> {
  const to = ctx.declared[step.target];
  if (step.do === 'create') await create(db, step, to, ctx.identity);
  else if (step.do === 'drop') await run(db, `DROP TABLE IF EXISTS ${quoted(step.target)}`);
  else if (step.do === 'renameCollection') await renameCollection(db, step);
  else if (step.do === 'rename')
    await run(
      db,
      `ALTER TABLE ${quoted(step.target)} RENAME COLUMN ${quoted(step.from ?? '')} TO ${quoted(step.at ?? '')}`,
    );
  else if (step.do === 'add') await add(db, step, fieldOf(step, to));
  else if (step.do === 'unique') await unique(db, step);
  else if (step.do === 'ununique') await ununique(db, step);
  else return false;
  return true;
}

/**
 * Throw where a `retype` would lose a value, counted inside the plan's transaction: the count the plan was
 * classed by was taken before it, and a row written since is one SQLite would otherwise cast to a 0.
 */
async function castsEvery(db: Kysely<never>, step: Step): Promise<void> {
  if (!step.was || !step.becomes || !attempts(step.was, step.becomes))
    throw new Error(
      `retype ${step.target}.${step.at}: this engine attempts no cast from ${step.was} to ${step.becomes}`,
    );
  const column = quoted(step.at ?? '');
  const test = carries(step.was, step.becomes, column);
  if (!test) return;
  const lost = await sql<{ n: number }>`
    select count(*) as n from ${sql.id(step.target)} where ${sql.raw(column)} is not null and not ${sql.raw(test)}
  `.execute(db);
  const count = Number(lost.rows[0]?.n ?? 0);
  if (count)
    throw new Error(
      `retype ${step.target}.${step.at}: ${count} row(s) hold a ${step.was} no cast carries to ${step.becomes}`,
    );
}

/**
 * One step applied, on the plan's handle. An `adopt` runs no statement at all: the table is already what the
 * record will say it is, and adopting it is writing that record and nothing more.
 */
export async function applyStep(db: Kysely<never>, step: Step, ctx: Against): Promise<void> {
  if (step.do === 'adopt') return;
  const change = changeOf(step, fieldOf(step, ctx.declared[step.target]));
  if (change) {
    if (step.do === 'retype') await castsEvery(db, step);
    await rebuild(db, step.target, change);
  } else if (!(await inPlace(db, step, ctx)))
    throw new Error(`this engine has no statement for the step '${step.do}' on ${step.target}`);
}
