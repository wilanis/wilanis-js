# @wilanis/plugin-storage-postgres

The `@storage-postgres` engine for wilanis: an [`@storage`](https://github.com/wilanis/wilanis-js/tree/main/packages/plugin-storage)
store kept in PostgreSQL, through [Kysely](https://kysely.dev). A collection is a table, a field is a column,
and what the store declares -- the key, what is unique, what refers to what -- is what the database is asked
to hold. **The same data graphs run against this engine and against the memory one**: which of the two a tree
uses is its connection's kind, and nothing else about the tree changes.

```
npm install @wilanis/plugin-storage-postgres
```

```json
{ "use": "@storage-postgres", "from": "@wilanis/plugin-storage-postgres" }
```

Name it beside `@storage` in `project.json`, in either order, and a store whose connection is of the kind it
grants is kept by it.

## The connection kind

`@storage-postgres/postgres.connection-kind.json`, marked `"storage": true`, which is how a store knows it may
name a connection of this kind. The URL is a secret, because it carries the credentials; the schema and the
pool are facts about one database, so they sit on the connection rather than in the plugin's settings:

```json
{
  "$schema": "@wilanis/connection.schema.json",
  "description": "where the entries live",
  "kind": "@storage-postgres/postgres.connection-kind.json",
  "settings": { "url": "{{secrets.database}}" }
}
```

`schema` (default `public`) and `pool` (`{ "max": 10 }`) are optional. The plugin's own settings are
engine-wide: `statementTimeout`, in seconds, and `keyType` -- `uuidv7` (the default), what `newKey` answers
for a string key, or `identity`, one past the highest, for a number key.

## The lease it keeps

The kind is also marked `"leases": true`: a `run` step of `@schedule` may name a connection of it as its
`lease`, and the plugin registers a keeper for it from `postLoad` through `leases(env)` from
`@wilanis/plugin-storage`, beside its engine. The keeper keeps one row per scheduled trigger in
`wilanis_schedule` (`name`, `holder`, `held_until`, `last_fired`), created on first contact as
`wilanis_migrations` is and never by a plan. A hold is taken by one insert-or-update statement, judged by the
database's clock, and granted to nobody once a tick at or after it is recorded fired, so several instances
behind one database fire each tick once.

## How a shape becomes a table

| the shape says | the column is |
|---|---|
| `string`, and an enum | `text` |
| `number` | `double precision` |
| `boolean` | `boolean` |
| a shape, a list, `unknown` | `jsonb` |
| `blob` | refused: X221 |

A required field is `NOT NULL` and the key is the primary key. A `unique` the store declares becomes a unique
constraint and a `refs` becomes a foreign key, so the rule the store states is the rule the database holds --
and a violation comes back as the `violated` or `referencedBy` the port promises, read back from the
constraint's own name. **A constraint is answered, not thrown**: a graph routes on the flag with a `switch`.

What is read is judged against the shape before it is answered, so a row written outside wilanis that no
longer fits fails the node rather than reaching a graph.

## What `ensure` does

Additive everywhere, destructive nowhere. It creates the tables, columns and constraints the store declares
and does not find, counts each, and makes nothing on a second run. What it will not do is change anything that
is already there: a column of another type, a required column added to a table with rows and no default for
them, a `unique` the existing rows would break -- each is refused as **drift**, reported rather than repaired,
because what to do about it is a decision a person makes and not one a startup step makes at three in the
morning. A drift stops `wilanis start` the way an unreachable database does.

A `defaults` the store declares is what the rows already there receive when `ensure` adds that column, and
nothing else: the default is dropped once the column exists, so it never applies to what a graph writes.

## Two things this engine decided

Neither is in the port, and the shared suite judges both by behaviour:

- **`contains` and `startsWith` are `LIKE`** over an escaped pattern, case-sensitively, because that is what
  the memory engine's `String.includes` answers. A `%` or `_` in the value is escaped, so a filter cannot
  smuggle a pattern in.
- **A `jsonb` column is never ordered by**, and never compared with `lt`, `lte`, `gt` or `gte`. Postgres orders
  jsonb by rules that are not the ones the memory engine uses, and an engine answering a different order for
  the same filter would make the shared suite a lie.

## Its rules

`wilanis check` refuses these before anything runs, so they are read as output rather than met as a driver
error later:

| Code | Refuses |
|---|---|
| X221 | a field this engine has no column for: a `blob`, whose bytes live in the blob registry |
| X222 | a key it cannot key by, or one `newKey` cannot answer under the configured `keyType` |
| X223 | a collection name PostgreSQL will not keep, or two of one connection that fold to one table |

## Tests

The shared suite -- what every engine must answer alike -- runs against a real database, and is skipped
without one, since a suite that silently passed without a database would be worse than no suite:

```
docker run -d --rm --name wilanis-pg -e POSTGRES_PASSWORD=wilanis -e POSTGRES_DB=wilanis \
  -p 55432:5432 postgres:16-alpine
WILANIS_TEST_POSTGRES_URL=postgres://postgres:wilanis@127.0.0.1:55432/wilanis npm test
```

Part of [wilanis](https://github.com/wilanis/wilanis-js). Apache-2.0.
