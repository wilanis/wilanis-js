# @wilanis/plugin-storage-sqlite

The `@storage-sqlite` engine for wilanis: an [`@storage`](https://github.com/wilanis/wilanis-js/tree/main/packages/plugin-storage)
store kept in one SQLite file, through [Kysely](https://kysely.dev) over
[better-sqlite3](https://github.com/WiseLibs/better-sqlite3). It is the development database: no server, no
secret, nothing to provision -- the file is made the first time a store reaches it, and `rm` is the whole of a
reset. **The same data graphs run against this engine, the memory one and the postgres one**: which a tree uses
is its connection's kind, and nothing else about the tree changes.

```
npm install @wilanis/plugin-storage-sqlite
```

```json
{ "use": "@storage-sqlite", "from": "@wilanis/plugin-storage-sqlite" }
```

Name it beside `@storage` in `project.json`, in either order, and a store whose connection is of the kind it
grants is kept by it.

## The connection kind

`@storage-sqlite/sqlite.connection-kind.json`, marked `"storage": true`. Its one setting is `file`, required:
the database file, relative to the tree's root, created with its directory if absent. It is not a secret.

```json
{
  "$schema": "@wilanis/connection.schema.json",
  "description": "where the entries live: one file under .wilanis",
  "kind": "@storage-sqlite/sqlite.connection-kind.json",
  "settings": { "file": ".wilanis/entries.sqlite" }
}
```

`:memory:` is refused: a transaction opens a handle of its own on the file, and a second handle on an in-memory
database is a second, empty database. A database that forgets is what `@storage-memory` is for.

The kind declares what the engine can do (RFC 0022): `"capabilities": { "transactionalDdl": true, "unique":
["string", "number", "boolean"], "refs": true }`. SQLite's DDL is transactional; a `unique` may name a string,
a number or a boolean field, not one kept as JSON; and `refs` are enforced, because every handle the engine
opens sets `PRAGMA foreign_keys = ON`.

The plugin's own settings are engine-wide: `keyType` -- `uuidv7` (the default), what `newKey` answers for a
string key, or `identity`, a number reserved from the table `wilanis_keys` for a number key; and
`busyTimeoutMs` (default 5000), how long a statement waits for the file before the node fails with
`database is locked`. One of this process waits its turn on the file (`turns.ts`) without holding the event
loop; one of another process waits on SQLite's busy handler, which holds the process, since the driver is
synchronous. Five seconds is better-sqlite3's own default: long enough for a short transaction elsewhere to
end, short enough that a lock nobody will release fails while someone is still looking.

## How a shape becomes a table

| the shape says | the column is |
|---|---|
| `string`, and an enum | `TEXT` |
| `number` | `REAL` (`INTEGER PRIMARY KEY` for a number key under `identity`) |
| `boolean` | `INTEGER`, `CHECK (x IN (0, 1))` |
| a shape, a list, `unknown` | `TEXT`, `CHECK (json_valid(x))` |
| `blob` | refused: X231 |

A required field is `NOT NULL` and the key is the primary key. A `unique` the store declares is a unique index,
named `wl_u_` and a hash of the declaration; whether one is already held is read off the columns an index
covers, never off its name. A `refs` is `REFERENCES ... ON DELETE RESTRICT`, enforced because every handle the
engine opens sets `PRAGMA foreign_keys = ON`. A violation comes back as the `violated` or
`referencedBy` the port promises: **a constraint is answered, not thrown**.

## Every handle

Opened with `PRAGMA journal_mode = WAL` (a reader in another process never waits on a writer; in this process
every statement, a read included, waits for an open transaction to end), `foreign_keys = ON` and
`busy_timeout = <busyTimeoutMs>`. One handle per connection carries every statement outside a transaction; a
transaction (`begin`) opens a handle of its own, runs `BEGIN IMMEDIATE` on it -- taking the write lock at once,
so a second writer waits rather than failing at commit -- and closes it when it commits or rolls back.

## What the engine sets right

SQLite's defaults disagree with the shared suite in places, and the engine answers as the memory engine does
rather than the suite bending: `contains` and `startsWith` are `instr()` and `substr()`, since `LIKE` folds
ASCII case; `ne` is `IS NOT` and `notIn` keeps a row whose field is absent, as `!==` does; a column holding JSON
is compared through `json()` and never ordered by; an absent value orders last ascending and first descending.

## Its rules

`wilanis check` refuses these before anything runs, so they are read as output rather than met as a driver
error later:

| Code | Refuses |
|---|---|
| X231 | a field this engine has no column for: a `blob`, whose bytes live in the blob registry |
| X232 | a key it cannot key by, or one `newKey` cannot answer under the configured `keyType` |
| X233 | a collection name SQLite will not create (one beginning `sqlite_`), or two of one connection that fold to one table |

## Scopes

A scoped collection (RFC 0015) keeps each scope column beside the record, as the postgres engine does: `TEXT`
or `REAL` by the value, `NOT NULL`, added the first time a scope reaches the table. Every statement carries
`<column> = ?` per scope column, a declared `unique` becomes a unique index with the scope columns in front, and
an index over the scope and the key (`wl_i_<collection>_scope`) is what tells a later `ensure` which columns are
the scope. A table that already holds rows and no scope column is `drift`: a row written before the store was
scoped belongs to no scope.

## Migrations

The engine answers RFC 0017's planner. `wilanis migrate` plans a connection of this kind against the file, and a
startup step's `@storage/storage.port.json#ensure` applies a plan whose every step is additive and refuses
`drift` otherwise -- a column of another type, a required column with no default over rows, a `unique` the rows
already repeat, a column the shape no longer has. A table an earlier `ensure` built and nothing recorded is
adopted on first contact.

**The record** is the table `wilanis_migrations` in the file itself: one row per collection a plan touched, with
what the collection is afterwards, the steps, the tree and who ran it, and `plan`, the migration's number. It is
made on first contact; no plan drops it. `rm` of the file is still the whole of a reset.

**One plan, one transaction.** The kind says `transactionalDdl: true`, and a plan runs on a handle of its own:
`PRAGMA foreign_keys = OFF`, `BEGIN IMMEDIATE`, the steps, the record's rows, `PRAGMA foreign_key_check`,
`COMMIT`. A step that fails, or a reference the rows break, rolls the whole plan back, and the file and its
record are as they were.

**What a step is.** `create`, `rename`, `renameCollection`, an `add` the table can take in place, `unique`,
`ununique` and `drop` are one statement each. SQLite has no `ALTER COLUMN` and adds a reference only with its
column, so `retype`, `require`, `relax`, `ref`, `unref`, `remove`, and an `add` of a required field with no
default remake the table, inside the plan's transaction. The sequence is the one SQLite documents for other
schema changes (the twelve steps): make `wl_rebuild_<name>`, copy the rows, drop the table, give the new one its
name, make its indexes again. It never renames the old table out of the way first: since SQLite 3.26 that
rewrites every reference other tables make to it, and they would point at a table about to be dropped.

**Which casts a `retype` attempts** are the postgres engine's pairs: anything to a string; a string to a number,
a boolean or JSON; a number or a boolean to JSON. SQLite's own cast never fails (`CAST('two' AS REAL)` is 0), so
each pair that can lose a value has a test: the plan counts the values that fail it before it runs, and the
rebuild counts them again inside the transaction and fails the plan where any is left.

## Tests

Every suite runs unconditionally, against a file in the test's temporary directory: the shared engine suite,
RFC 0015's scope cases, RFC 0017's planner (a plan that fails half way, a table rebuild included, leaves the file
and its record as they were), a second load of a tree finding what the first kept, the rules (X231 to X233, which open
no file), the pragmas, the keys, and the bundled SQLite's version (3.35 or later, for `RETURNING`).

Part of [wilanis](https://github.com/wilanis/wilanis-js). Apache-2.0.
