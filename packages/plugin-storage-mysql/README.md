# @wilanis/plugin-storage-mysql

The `@storage-mysql` engine for wilanis: an [`@storage`](https://github.com/wilanis/wilanis-js/tree/main/packages/plugin-storage)
store kept in MySQL, through [Kysely](https://kysely.dev) over [mysql2](https://github.com/sidorares/node-mysql2),
for the trees that already have a MySQL. **The same data graphs run against this engine, the memory one, the
postgres one and the sqlite one**: which a tree uses is its connection's kind, and nothing else about the tree
changes.

It requires **MySQL 8.0.16 or later**. Before it registers, the plugin's `postLoad` asks every server a
connection of its kind reaches for `SELECT VERSION()`, and fails the start on an older one, naming the version it
found and the one it requires. 8.0.16 is the first release that enforces a `CHECK`, after functional indexes
(8.0.13) and `SKIP LOCKED` (8.0.1). A server answering MariaDB's version is refused too: MariaDB numbers its
releases 10 and 11, and its `JSON` is another type under the same name. A server that cannot be reached is not
refused at start; what uses the connection fails there.

```
npm install @wilanis/plugin-storage-mysql
```

```json
{ "use": "@storage-mysql", "from": "@wilanis/plugin-storage-mysql" }
```

Name it beside `@storage` in `project.json`, in either order, and a store whose connection is of the kind it
grants is kept by it.

## The connection kind

`@storage-mysql/mysql.connection-kind.json`, marked `"storage": true`. Its settings are `url`, required and a
secret, since it carries the credentials, read as `{{secrets.*}}`; and `pool`, optional, `{ "max": n }`, the most
sessions the tree holds open at once (default 10). There is no `schema` setting: a MySQL database is the schema,
and the URL names it.

```json
{
  "$schema": "@wilanis/connection.schema.json",
  "description": "The customers, in the team's MySQL.",
  "kind": "@storage-mysql/mysql.connection-kind.json",
  "settings": { "url": "{{secrets.customersUrl}}", "pool": { "max": 10 } }
}
```

The kind declares what the engine can do (RFC 0022): `"capabilities": { "transactionalDdl": false, "unique":
["string", "number", "boolean"], "refs": true }`. MySQL commits before and after every DDL statement, so what
`ensure` makes is made step by step, and a failure half way leaves what came before it made. A `unique` may name
a string, a number or a boolean field, not one kept as JSON. `refs` are enforced by InnoDB's foreign keys.

The plugin's own settings are engine-wide. `statementTimeout`, in seconds, becomes the session's
`MAX_EXECUTION_TIME`, which MySQL applies to reads alone: a write has no server-side deadline. `keyType` is
`uuidv7` (the default), what `newKey` answers for a string key, or `identity`, a number reserved from the table
`wilanis_keys` for a number key, in a short transaction that locks the collection's row.

## How a shape becomes a table

| the shape says | the column is |
|---|---|
| `string`, and an enum | `TEXT COLLATE utf8mb4_bin`; `VARCHAR(n) COLLATE utf8mb4_bin` where an index holds it |
| `number` | `DOUBLE` |
| `boolean` | `TINYINT(1)`, `CHECK (x IN (0, 1))` |
| a shape, a list, `unknown` | `JSON` |
| `blob` | no column: its bytes live in the blob registry |

Every table is created `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`, named in the statement rather
than left to the server. A required field is `NOT NULL` and the key is the primary key. A `unique` is a unique
index named `wl_u_` and a hash of the declaration; a `refs` is a foreign key named `wl_r_` and a hash,
`ON DELETE RESTRICT`. A violation comes back as the `violated` or `referencedBy` the port promises: **a
constraint is answered, not thrown**.

**How wide a string an index holds may be.** InnoDB holds at most 3072 bytes in one index, and `utf8mb4` takes
four bytes a character. A string field alone in an index -- the key, a `refs`, a `unique` of one field -- is
`VARCHAR(768)`. Fields that share one index share the 3072 bytes: a `unique` over two strings makes each
`VARCHAR(384)`, and a `unique` over a string and a number makes the string `VARCHAR(766)`, since a number takes 8
bytes (a boolean takes 1). A field in several indexes takes the narrowest. A longer string fails the node at the
write: PostgreSQL and SQLite would accept it. The alternatives were worse: a prefix index makes "unique" mean
"unique in the first n characters", and a hashed column hides a column no document names.

**A `JSON` column carries no `CHECK (JSON_VALID(x))`.** MySQL refuses a value that is not JSON at the write
already, so the check would refuse nothing the type does not.

## Every session

Every session a pool opens adds `STRICT_ALL_TABLES` and `NO_ENGINE_SUBSTITUTION` to the server's `sql_mode`:
a string longer than its column fails the write instead of being cut to fit, and a table is InnoDB or is not
made. Where `statementTimeout` is set, the session's `MAX_EXECUTION_TIME` is too.

A pool is made at the first operation against a connection and destroyed by the plugin's teardown. A
transaction (`begin`) holds one session from `START TRANSACTION` until it commits or rolls back.

## How each write is made

MySQL has no `RETURNING`.

- `put` answers the record it wrote, which is the record as stored. With `replace` false it is a plain
  `INSERT`, and a duplicate of the primary key is the `conflict` it answers. Any other refusal is answered as
  the violation it is, or fails the node. It is not `INSERT IGNORE`: `IGNORE` turns more than a duplicate key
  into a warning, even in strict mode, so a string longer than its column would be cut and stored, and `put`
  would answer a record the table does not hold. With `replace` it is an `INSERT`, and an
  `UPDATE` by key where the key is held. It is never `ON DUPLICATE KEY UPDATE`, which fires on any unique index
  and would overwrite another record instead of refusing the write.
- `patch` is the `UPDATE` and a `SELECT` by key, and `remove` is a `SELECT ... FOR UPDATE` by key and the
  `DELETE`. Each pair runs in one short transaction, or in the transaction already open.

## What the engine sets right

MySQL's defaults disagree with the shared suite in places, and the engine answers as the memory engine does
rather than the suite bending. Strings compare with case, through `utf8mb4_bin`, so `"GET"` and `"get"` are
two values under a `unique` and under `eq`. `contains` and `startsWith` are `INSTR()` and `LOCATE()`. `ne` is
`NOT (x <=> v)` and `notIn` keeps a row whose field is absent, as `!==` does. `in` over an empty list matches
nothing, where MySQL refuses `IN ()`. A `JSON` column is compared as JSON and never ordered by. An absent value
orders last ascending and first descending.

One difference stays: `utf8mb4_bin` is a `PAD SPACE` collation, so two strings that differ only in trailing
spaces compare equal, under `eq` and under a `unique`. `utf8mb4_0900_bin` does not pad, and it needs MySQL
8.0.17.

## Not yet

The rules X241 to X243, keeping a scope (RFC 0015), the planner's members applied step by step (RFC 0017), and
the constraint suites are RFC 0022's eighth step ([#262](https://github.com/wilanis/wilanis-js/issues/262)).

**Until that step lands, a tree on this kind cannot prepare its tables from a startup step.** A startup step's
`@storage/storage.port.json#ensure` goes through the planner, and this engine's `apply` refuses: the start fails
in the open, naming the step. `wilanis migrate` skips a connection of this kind and says so, and an operation
carrying a scope fails the node.

## Tests

The suites that need a server -- the shared engine suite, the version check against a real server, and the
mapping -- run against a real MySQL, and are skipped without `WILANIS_TEST_MYSQL_URL`, since a suite that
silently passed without a database would be worse than no suite. CI starts no database, so run them by hand
before changing the engine, against a server at the floor version:

```
docker run -d --rm --name wilanis-mysql --platform linux/amd64 -e MYSQL_ROOT_PASSWORD=wilanis \
  -e MYSQL_DATABASE=wilanis -p 53306:3306 mysql:8.0.16
WILANIS_TEST_MYSQL_URL=mysql://root:wilanis@127.0.0.1:53306/wilanis npx vitest run packages/plugin-storage-mysql
```

`--platform linux/amd64` is there because the 8.0.16 image is published for amd64 alone; on an amd64 host it
changes nothing. `npm test` with the variable set runs the same suites with the rest.

`engine.test.ts` runs the shared engine suite. `version.test.ts` reads version answers without a server, and
with one checks that a connection lying about `SELECT VERSION()` fails the start. `mapping.test.ts` checks the
widths without a server, and with one checks the tables, what `put` without `replace` refuses, `wilanis_keys`
and the session. `tree.test.ts` needs no server: a tree naming the kind checks, and a `unique` over a shape is
refused naming the kind.

Part of [wilanis](https://github.com/wilanis/wilanis-js). Apache-2.0.
