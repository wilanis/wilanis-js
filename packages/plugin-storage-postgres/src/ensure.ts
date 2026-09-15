/**
 * What `ensure` does to a database: adds what the store declares and is not there, and refuses to destroy or
 * change anything that is. It is additive everywhere and destructive nowhere -- a column whose type differs, a
 * column the shape no longer has, a key that moved: each is `drift`, reported rather than repaired, because
 * what to do about it is a decision a person makes, not one a startup step makes at three in the morning.
 *
 * A `drift` is thrown, not answered. RFC 0003 is explicit about the difference: a constraint a graph could
 * route on is answered as a flag, but drift is not a graph's outcome at all -- it is a startup failure, and it
 * stops the tree the way an unreachable database does.
 *
 * What the catalog holds is `inspect.ts`'s to ask (RFC 0017, step 4): this reads its columns rather than
 * making a second query of its own. The judgement below stays here until step 5 (#238) puts `ensure` over the
 * planner, where the whole comparison becomes `inspect` against the record and this file's `judgeDrift` goes.
 */
import type { At } from '@wilanis/plugin-storage';
import { type Kysely, sql } from 'kysely';
import { columnOf, fieldsOf, folded, isJson as isJsonType } from './columns.js';
import { type Column, columnsOf } from './inspect.js';
import { refName, uniqueName } from './names.js';
import type { Settings } from './pool.js';

/** How much `ensure` made: what was created, never what was already there. */
export interface Made {
  collections: number;
  columns: number;
  constraints: number;
}

/** One column as the database reports it, which `inspect.ts` is the one place to ask about (RFC 0017). */
type Found = Column;

/** The columns a table already has, by name, or nothing at all where there is no such table. */
async function existing(db: Kysely<never>, schema: string, table: string): Promise<Map<string, Found> | undefined> {
  const columns = await columnsOf(db, schema, table);
  if (!columns) return undefined;
  return new Map(columns.map(one => [one.column_name, one]));
}

/** The type the database reports for a column this engine would have created as `declared`. */
function reported(declared: string): string {
  if (declared === 'text') return 'text';
  if (declared === 'double precision') return 'double precision';
  if (declared === 'boolean') return 'boolean';
  return 'jsonb';
}

/** Create the table a collection is, with every column, the primary key, and the uniques it declares. */
async function createTable(db: Kysely<never>, schema: string, at: At): Promise<number> {
  const table = folded(at.name);
  const columns = fieldsOf(at.shape).map(field => {
    const type = columnOf(field.type);
    if (!type) throw new Error(`${at.name}.${field.name}: this engine has no column for a blob (X221)`);
    const nullable = field.required || field.name === at.key ? ' not null' : '';
    return sql`${sql.ref(folded(field.name))} ${sql.raw(type)}${sql.raw(nullable)}`;
  });
  const key = sql`primary key (${sql.ref(folded(at.key))})`;
  await sql`create table ${sql.ref(schema)}.${sql.ref(table)} (${sql.join([...columns, key])})`.execute(db);
  return fieldsOf(at.shape).length;
}

/** Add a column the shape has and the table does not, with the default declared for the rows already there. */
async function addColumn(
  db: Kysely<never>,
  where: { schema: string; at: At },
  field: { name: string; type: import('@wilanis/core').Type; required: boolean },
): Promise<void> {
  const { schema, at } = where;
  const defaults = at.defaults ?? {};
  const type = columnOf(field.type);
  if (!type) throw new Error(`${at.name}.${field.name}: this engine has no column for a blob (X221)`);
  const table = folded(at.name);
  const has = Object.hasOwn(defaults, field.name);
  const rows = await sql<{ n: string }>`select count(*) as n from ${sql.ref(schema)}.${sql.ref(table)}`.execute(db);
  const filled = Number((rows as { rows: { n: string }[] }).rows[0]?.n ?? 0);
  if (field.required && filled && !has)
    throw new Error(
      `drift: ${at.name}.${field.name} is required, the table holds ${filled} row(s), and no default is declared for it`,
    );
  const fill = has ? sql` default ${sql.raw(literal(defaults[field.name], field.type))}` : sql``;
  const notNull = field.required && (!filled || has) ? sql` not null` : sql``;
  await sql`
    alter table ${sql.ref(schema)}.${sql.ref(table)}
    add column ${sql.ref(folded(field.name))} ${sql.raw(type)}${fill}${notNull}
  `.execute(db);
  // the default was for the rows that existed; what a graph writes always gives the whole record
  if (has)
    await sql`alter table ${sql.ref(schema)}.${sql.ref(table)} alter column ${sql.ref(folded(field.name))} drop default`.execute(
      db,
    );
}

/**
 * A default as DDL spells it. A `DEFAULT` is part of the statement rather than a value bound to it -- Postgres
 * prepares DDL with no parameters at all -- so the literal is written out, quoted the way SQL quotes one. Only
 * what a shape can hold reaches here, and a string is escaped by doubling its quotes, which is the whole of
 * what SQL asks.
 */
function literal(value: unknown, type: import('@wilanis/core').Type): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const text = isJsonType(type) ? JSON.stringify(value) : String(value);
  const quoted = `'${text.replace(/'/g, "''")}'`;
  return isJsonType(type) ? `${quoted}::jsonb` : quoted;
}

/** Every constraint name the schema already holds, so one is created once and never twice. */
async function constraints(db: Kysely<never>, schema: string): Promise<Set<string>> {
  const rows = (await sql<{ conname: string }>`
    select c.conname from pg_constraint c
    join pg_namespace n on n.oid = c.connamespace
    where n.nspname = ${schema}
  `.execute(db)) as { rows: { conname: string }[] };
  return new Set(rows.rows.map(one => one.conname));
}

/** Add the uniques and the foreign keys a collection declares and the schema does not hold yet. */
async function addConstraints(db: Kysely<never>, schema: string, at: At, held: Set<string>): Promise<number> {
  const table = sql`${sql.ref(schema)}.${sql.ref(folded(at.name))}`;
  let made = 0;
  for (const fields of at.unique) {
    const name = uniqueName(at.name, fields);
    if (held.has(name)) continue;
    const columns = sql.join(fields.map(field => sql.ref(folded(field))));
    await sql`alter table ${table} add constraint ${sql.ref(name)} unique (${columns})`.execute(db);
    held.add(name);
    made += 1;
  }
  for (const ref of at.refs) {
    const name = refName(ref.from, ref.field);
    if (held.has(name)) continue;
    const target = sql`${sql.ref(schema)}.${sql.ref(folded(ref.to))}`;
    await sql`
      alter table ${table} add constraint ${sql.ref(name)}
      foreign key (${sql.ref(folded(ref.field))}) references ${target}
    `.execute(db);
    held.add(name);
    made += 1;
  }
  return made;
}

/** What the table already has, held against what the shape says: anything that would have to change is drift. */
function judgeDrift(at: At, found: Map<string, Found>): void {
  const table = folded(at.name);
  for (const field of fieldsOf(at.shape)) {
    const column = found.get(folded(field.name));
    if (!column) continue;
    const want = reported(columnOf(field.type) ?? 'jsonb');
    if (column.data_type !== want)
      throw new Error(`drift: ${table}.${folded(field.name)} is ${column.data_type}, and the shape says ${want}`);
  }
  const declared = new Set(fieldsOf(at.shape).map(field => folded(field.name)));
  for (const [name, column] of found)
    if (!declared.has(name) && column.is_nullable === 'NO')
      throw new Error(`drift: ${table}.${name} is a column no field of the shape has, and it is not null`);
}

/**
 * One collection made ready: the table where there is none, and the columns it has gained where there is one.
 * A table that is already there is judged for drift first, so nothing is added to a table that should not have
 * been touched at all.
 */
async function ensureOne(db: Kysely<never>, schema: string, at: At): Promise<{ collections: number; columns: number }> {
  const found = await existing(db, schema, folded(at.name));
  if (!found) return { collections: 1, columns: await createTable(db, schema, at) };
  judgeDrift(at, found);
  let columns = 0;
  for (const field of fieldsOf(at.shape)) {
    if (found.has(folded(field.name))) continue;
    await addColumn(db, { schema, at }, field);
    columns += 1;
  }
  return { collections: 0, columns };
}

/**
 * Prepare every collection the store declares: the tables and columns first, then the constraints over them --
 * in that order, since a foreign key names a table that has to exist. Everything happens in one transaction,
 * so a `drift` half way through leaves the database exactly as it was.
 */
export async function ensureTables(db: Kysely<never>, collections: At[], _settings: Settings): Promise<Made> {
  const schema = schemaOf(collections[0]);
  const made: Made = { collections: 0, columns: 0, constraints: 0 };
  await db.transaction().execute(async trx => {
    for (const at of collections) {
      const one = await ensureOne(trx as never, schema, at);
      made.collections += one.collections;
      made.columns += one.columns;
    }
    const held = await constraints(trx as never, schema);
    for (const at of collections) made.constraints += await addConstraints(trx as never, schema, at, held);
  });
  return made;
}

/** The schema a connection's tables sit in, as the connection document says. */
function schemaOf(at: At): string {
  const schema = (at.settings as { schema?: unknown }).schema;
  return typeof schema === 'string' && schema ? schema : 'public';
}
