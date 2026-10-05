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

The plugin's own settings are engine-wide: `keyType` -- `uuidv7` (the default), what `newKey` answers for a
string key, or `identity`, a number reserved from the table `wilanis_keys` for a number key; and
`busyTimeoutMs` (default 5000), how long a writer waits for the file's write lock before the node fails with
`database is locked`. Five seconds is better-sqlite3's own default: long enough for a short transaction
elsewhere to end, short enough that a lock nobody will release fails while someone is still looking. The wait
holds the process, since the driver is synchronous.

## How a shape becomes a table

| the shape says | the column is |
|---|---|
| `string`, and an enum | `TEXT` |
| `number` | `REAL` (`INTEGER PRIMARY KEY` for a number key under `identity`) |
| `boolean` | `INTEGER`, `CHECK (x IN (0, 1))` |
| a shape, a list, `unknown` | `TEXT`, `CHECK (json_valid(x))` |
| `blob` | no column: bytes live in the blob registry |

A required field is `NOT NULL` and the key is the primary key. A `unique` the store declares is a unique index
(`wl_u_<collection>_<fields>`) and a `refs` is `REFERENCES ... ON DELETE RESTRICT`, enforced because every
handle the engine opens sets `PRAGMA foreign_keys = ON`. A violation comes back as the `violated` or
`referencedBy` the port promises: **a constraint is answered, not thrown**.

## Every handle

Opened with `PRAGMA journal_mode = WAL` (a reader never waits on a writer), `foreign_keys = ON` and
`busy_timeout = <busyTimeoutMs>`. One handle per connection carries every statement outside a transaction; a
transaction (`begin`) opens a handle of its own, runs `BEGIN IMMEDIATE` on it -- taking the write lock at once,
so a second writer waits rather than failing at commit -- and closes it when it commits or rolls back.

## What the engine sets right

SQLite's defaults disagree with the shared suite in places, and the engine answers as the memory engine does
rather than the suite bending: `contains` and `startsWith` are `instr()` and `substr()`, since `LIKE` folds
ASCII case; `ne` is `IS NOT` and `notIn` keeps a row whose field is absent, as `!==` does; a column holding JSON
is compared through `json()` and never ordered by; an absent value orders last ascending and first descending.

## Not yet

This package is RFC 0022's fourth step. Its check rules (X231 to X233) are the fifth. Keeping a scope
(RFC 0015) and the migration planner's members (RFC 0017) are the sixth: until then an operation carrying a
scope fails the node, `wilanis migrate` skips a connection of this kind and says so, and a startup step's
`@storage/storage.port.json#ensure` fails the start naming the step, rather than leaving the first write to meet
a missing table.

## Tests

Every suite runs unconditionally, against a file in the test's temporary directory: the shared engine suite,
a second load of a tree finding what the first kept, the pragmas, the keys, and the bundled SQLite's version
(3.35 or later, for `RETURNING`).

Part of [wilanis](https://github.com/wilanis/wilanis-js). Apache-2.0.
