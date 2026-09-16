# monitor

A wilanis project: a monitor of observed HTTP calls, with sign-in, sessions and policies over its writes, and
a command-line greeting gated by a one-time code. Everything in this directory is JSON; `package.json`
installs the runtime and the plugin packages it uses. The one secret is the key our tokens are signed with,
`MONITOR_JWT_SECRET`, which `start` and `run` need in the environment.

**Where the entries live is a profile's choice, and nothing else changes.** `live` binds the monitor port to
`monitor-rest.binding.json` and the routes talk to a public REST API
(`https://6aa009e23e0d88d3d7e5525d.mockapi.io/api/v1/monitor`, no key needed). `local` binds the same port to
`monitor-store.binding.json`, and the entries are kept in a store of their own -- `entries.store.json`, one
collection of `Entry` keyed by `id`, over a connection of the memory engine's kind, so nothing leaves the
process. The routes, the policies, the domain graphs and the shapes are the same either way: only the data
graphs behind the port differ, which is what a port is for.

**The store declares more than the shape and the key.** `unique: [["url", "method"]]` says no two entries
record the same call, and `defaults: { "agent": "unknown" }` says what an entry written before the user agent
column existed reads as once `ensure` adds it -- about rows already there, never about what a graph writes,
since `put` always gives the whole record. The compiler judges both against `Entry`: misspell a field in
either and `wilanis check` names it, rather than PostgreSQL finding out on the first write. A `unique` a
write would repeat is answered, not thrown -- `put` hands back `violated` and the graph routes on it with a
`switch`, the same way it routes on `conflict`.

**A third profile keeps the same entries in PostgreSQL.** `production` binds the monitor port to
`monitor-postgres.binding.json`, whose data graphs name a store over a connection of the postgres engine's
kind, its URL read from `MONITOR_DATABASE_URL`. Not one route, policy, shape, port or business graph differs
from `local`: only which binding meets the port, and through it where the records live. The startup step
prepares the database before the port opens, so a tree whose database is unreachable refuses to serve rather
than answering every route with a fault.

That there are two store documents rather than one connection swapped under a profile is the seam RFC 0002
settled and RFC 0005 will close: a profile swaps bindings, and a store names its connection in the document.

Because the port now has three bindings, **a command that runs the tree names a profile**: `--profile local`,
`--profile live` or `--profile production`. `wilanis check` needs none -- it judges every profile.

```
npm install
export MONITOR_JWT_SECRET=$(openssl rand -base64 32)
npm run check                       # wilanis check .  -- every profile at once
npm run rehearse -- --profile local # every trigger, every policy, every branch of every switch, effects stubbed
npm run digest -- --profile local   # the count and one line per entry, for real
npm run start -- --profile local    # GET /monitor[?method=], POST /monitor, GET|PUT|DELETE /monitor/{id}, DELETE /monitor, GET|POST /monitor.csv,
                                    # POST /api/v1/auth-customers | auth-employees | token/refresh | sign-out, GET|PUT /api/v1/me/preferences on :8099
npm run hello -- --profile local    # challenged until a one-time code is answered
```

Kept in memory, it answers for itself:

```
curl -s localhost:8099/monitor                                    # []
TOKEN=$(curl -s -X POST localhost:8099/api/v1/auth-employees \
  -H 'content-type: application/json' \
  -d '{"username":"bo","password":"bo-pass"}' | jq -r .accessToken)
curl -s -X POST localhost:8099/monitor -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"url":"https://example.com/a","method":"GET"}'
curl -s localhost:8099/monitor                                    # the entry, read back from the store
```

The store lives exactly as long as the process: stop it and the entries are gone. That is what the memory
engine is for -- development, tests, and a demo that needs nothing installed. Point `entries.connection.json`
at another engine's kind and the same documents keep the same records in a database.

## Changing the shape, and the plan that follows

A migration here is derived, not written: there is no migration file to keep in step with the shapes. The
postgres engine records, in the database itself, every collection as it was last applied there, and
`wilanis migrate` diffs that record against the store documents and prints what the database would have to
do. Nothing runs until `--apply`, and a step that loses data runs only when the operator names it.

**This walk-through needs a PostgreSQL to talk to.** The record lives in the database, so a plan is a
conversation with one; the memory engine keeps nothing between processes and is skipped with a line saying
so. Every command below also needs both of the tree's secrets in the environment, since `migrate` loads and
judges the whole tree before it plans anything:

```
export MONITOR_JWT_SECRET=$(openssl rand -base64 32)
export MONITOR_DATABASE_URL=postgres://user:password@127.0.0.1:5432/monitor
```

`Entry` has just changed in two ways: it gained an optional `note`, and its `ua` became `agent`. The added
field a diff can see. The rename it cannot -- from outside, `ua` gone and `agent` new is a dropped column
and a new one, and every user agent lost -- so `entries.store.json` says it, keyed by the field's name now:

```json
"defaults": { "agent": "unknown" },
"renamed": { "agent": "ua" }
```

**The plan.** Nothing has happened yet; this is what would:

```
$ npx wilanis migrate . --profile production
plan for @connections/entries-postgres.connection.json  (@storage-postgres/postgres.connection-kind.json, granted by @storage-postgres)
  entries
    rename   rename ua → agent                           transformative
    add      add note  string, optional                  additive
plan for @connections/entries.connection.json  (@storage-memory/memory.connection-kind.json, granted by @storage-memory)
  skipped: nothing is kept between processes, so there is nothing to migrate

2 steps would apply; 0 refused. Nothing was applied: run again with --apply.
```

The rename is `transformative` -- no row is lost, but a name a graph elsewhere might read has changed --
and the added column is `additive`, since an optional field costs no row anything.

**Dropping a collection is the operator's to allow.** A collection the record has seen and the tree no
longer declares is a table with rows in it, so the plan refuses it and says what would unlock it, naming
the pair of connection and collection, because two connections of one tree may each hold a `notes`. This
example declares no `notes` -- grep it and you will find none -- so the two blocks below are what you would
see had it declared one and then stopped; they were produced by declaring it, applying, and taking it away
again:

```
  notes
    drop     drop collection notes                       destructive     ✗ needs --allow-destructive @connections/entries-postgres.connection.json/notes
      loses every row of notes
```

```
$ npx wilanis migrate . --profile production --apply --allow-destructive '@connections/entries-postgres.connection.json/notes'
  notes
    drop     drop collection notes                       destructive     applied
      loses every row of notes

1 steps applied in one transaction; recorded as migration 5 (2026-09-16T16:45:54.879Z).
```

One plan is one transaction, so a step that fails midway leaves the database and the record as they were.
Every applied plan is a row of the record: `--history` prints what changed and when, and who ran it.

**The run that asks for the mark's removal.** Once the rename has been applied the mark has done its work,
and the next plan says so rather than doing anything:

```
$ npx wilanis migrate . --profile production
plan for @connections/entries-postgres.connection.json  (@storage-postgres/postgres.connection-kind.json, granted by @storage-postgres)
  up to date
  note: renamed.agent has been applied -- remove "renamed": { "agent": "ua" } from the entries collection once every database has applied it
plan for @connections/entries.connection.json  (@storage-memory/memory.connection-kind.json, granted by @storage-memory)
  skipped: nothing is kept between processes, so there is nothing to migrate

nothing to apply
```

It asks and does not refuse: a tree is deployed to more than one database, and the mark has to survive until
the last of them has moved. A fresh database has no `ua` to rename, so it reads the shape as it stands and
every collection is simply created.

`wilanis start` never migrates destructively. The startup step that prepares the store applies additive
steps only; anything more and it refuses as `drift`, printing the plan and naming this command. So
production changes shape because an operator ran it and read the plan, never because a process started.

## Who may do what

Reads are public. Every write (`POST /monitor`, `PUT|DELETE /monitor/{id}`, `DELETE /monitor`, `POST /monitor.csv`)
attaches two policies, and gives the guard the token where the route reads it:

```json
"policies": [
  { "policy": "@access/edge/employees-only.policy.json",
    "in": { "token": ["{{request.headers.authorization}}", "{{request.cookies.session}}"] } },
  "@access/edge/can-record.policy.json"
]
```

The `access` feature is not written here: `project.json → includes` names `@wilanis/access` (`libraries/access` in
this workspace), and its `features/access` loads as if it sat in this tree -- the same paths, the same rules,
`included from @wilanis/access` in `wilanis describe` and the viewer. What this project adds is `features/directories`:
the binding of the included `identity.port.json` to this project's two directory connections. It has two sign-in routes. `POST /api/v1/auth-employees` verifies the credential against the
employee directory (`connections/employees.connection.json`: bo / bo-pass holds the `recorder` group, cy / cy-pass
only `viewer`); `POST /api/v1/auth-customers` against the customer directory (ana / ana-pass). Both are directories
written in the connection, for development; a production profile binds the same `identity.port.json` to an
OIDC issuer or LDAP, in `features/directories`, and nothing in the included tree changes. Either way the caller gets **our** token, signed by the `@auth`
plugin: the sign-in graph writes the realm (`employee`, `customer`) and the directory's groups as roles, and
that is the domain's decision, not the caller's. Present it as `Authorization: Bearer ...`; the route also sets
it as the `session` cookie, so a browser needs no header.

```
curl -s localhost:8099/api/v1/auth-employees -d '{"username":"bo","password":"bo-pass"}' -H 'content-type: application/json'
curl -s localhost:8099/monitor -d '{"url":"https://x.example/","method":"GET"}' -H 'content-type: application/json' -H "authorization: Bearer $TOKEN"
```

On a write, the `@auth` guard verifies the token and hands `request.principal`; then `employees-only` decides on the
realm (a customer's perfectly valid token is `forbidden`, a 403) and `can-record` on the role (cy is `forbidden` too;
no token is `anonymous`, a 401; a bad token is `invalid_credential`, a 401). Each decision is a domain graph in
`features/access/domain/require-*.graph.json`, one `switch` each -- `has(principal) && 'recorder' in principal.roles`
-- and `wilanis rehearse` walks every branch of every one of them. The policies map each reason to deny; the
routes map each reason to a status.

## The session

`PUT /api/v1/me/preferences {"theme":"dark"}` stores the theme in the caller's session and `GET` reads it back on a
later call, with the same token or a refreshed one (`POST /api/v1/token/refresh` trades the refresh token for a new
pair and spends the old one). The session's attributes are the core shape `Session.shape.json`, named by the
plugin's `settings.session`; sign-in writes `displayName` and `realm` into it, `savePreferences` writes `theme`, and
`wilanis describe @access/domain/Session.shape.json` lists who writes what. The session id reaches the data graphs
as `{{sid}}` through `session.resolvers.json`, declared `required` because the `signed-in` policy proves it.
`POST /api/v1/sign-out` ends the session: its tokens stop verifying and the cookie is cleared.

## The one-time code

```
$ npm run hello
{ "reason": "otp", "message": "this command needs a one-time code",
  "challenge": { "id": "K7Q2-M9XA", "method": "otp", "expiresAt": "..." },
  "how": "wilanis run @access/edge/issue-otp.trigger.json --challenge-id=K7Q2-M9XA; then repeat this call with --challenge-id=K7Q2-M9XA --code=<code>" }
$ npx wilanis run @access/edge/issue-otp.trigger.json . --challenge-id=K7Q2-M9XA
{ "id": "K7Q2-M9XA", "code": "482913", "expiresAt": "..." }
$ npx wilanis run @hello/edge/hello-gated.trigger.json . --challenge-id=K7Q2-M9XA --code=482913
{ "greeting": "hello, gated" }
```

`hello-gated` attaches the `otp-verified` policy, giving the guard the challenge answer from `--challenge-id` and `--code`; the policy's outcome for `otp` is a challenge. The
guard opens one and tells the caller how to answer it in the kind's own words; `issue-otp` gives it a code
(printed here, delivered by whatever a production profile binds `deliverCode` to); the guard verifies the code
the caller presents and hands `request.challenge`, the policy allows, and the challenge is spent by the run.
The three processes share the challenge through the plugin's store under `.wilanis/auth/`.

## The digest, nightly

`digest.trigger.json` is a command: `npm run digest` prints the count and one line per entry.
`nightly-digest.trigger.json` fires the *same* domain operation at three in the morning, UTC:

```json
"kind": "@schedule/schedule.trigger-kind.json",
"settings": { "cron": "0 3 * * *", "timezone": "UTC" },
"out": "@monitor/edge/DigestView.shape.json",
"fire": { "run": "@monitor/domain/monitor.port.json#digest" }
```

One operation, two ways in, and neither document names a graph -- which is what a port is for. Nobody is
calling a tick, so the trigger attaches no policy (one that read the caller would be refused, `A005`) and
answers nobody: the digest is judged against `out` and written to the log. The tick's instant reaches a graph
as `request.scheduled` where one takes it, so nothing in this tree calls a clock and `wilanis rehearse` replays
a tick like any request.

It fires because the startup list asks for a scheduler, never because the document exists -- **delete the
`Keep the schedule` step and nothing is scheduled**, exactly as deleting `Listen` closes the port. This tree
runs one process and needs no lease; several instances would give the step a `lease` naming a connection whose
kind declares `leases`, and one of them would take each tick. `wilanis describe @monitor/edge/nightly-digest.trigger.json`
prints the schedule as written.

`project.json → startup` says what this tree starts, in order, and nothing else runs. `monitor.port.json#listAll`
reads the entries once: if the API is unreachable, `start` says so and exits rather than answering every route
with a fault. `@reload/watch.port.json#watch` serves the tree again whenever a document changes, without
closing the port. `@schedule/scheduler.port.json#run` keeps the schedule above. `@http/server.port.json#listen`
opens :8099 -- **delete that step and nothing listens**, since
no runtime opens a port merely because http triggers exist. The first is a domain port operation, so whichever
binding the profile chose is what gets checked; the last three are `holds` operations, which a plugin grants and
the runtime stops when the process ends. `wilanis describe @http/server.port.json` says which plugin grants it.

`monitor.port.json` is what the domain needs: `listAll`, `listByMethod`, `get`, `record`, `update`,
`remove`, `parseDrafts`, `toCsv`, `removeMany`, `submit`, `recordAll`, `list`, `digest`, `import`, `export`. `monitor-rest.binding.json` meets the first eight with a data
graph each, which issues one declared request and decides with a `switch` on `status` what the answer means:
the rows, the declared refusal `no entry {id}` with reason `missing` when the API answers 404, or the refusal
`upstream` for anything else. The http triggers map those two words to statuses (`"refusals": { "missing": 404, "upstream": 502 }`),
so the graphs never mention HTTP and a client is told `{ "reason": "missing", "message": "no entry 7" }` with a 404. The
last four are met by domain graphs that compose those operations: `list` routes on whether a method filter
is present, `submit` attributes the entry to its recorder and records it, `removeMany` maps `remove` over the ids,
`digest` counts the entries and lays them out as text. The API's misspelled `reponseStatus` lives in
the edge shape `EntryRow` and never reaches the domain.

`POST /monitor.csv` takes a CSV file (`url,method` per line) and `GET /monitor.csv` answers one. The file never
enters a graph: `text/csv` is mapped to the blob codec in `project.json`, so the upload streams into the blob
registry and the route hands the domain a handle; `import-entries` has the data layer read it as drafts
(`@blob/csv.port.json#parse`, typed by `EntryDraft`) and then records them all at once through `recordAll`,
which is where the atomicity below lives;
`export-entries` lists everything and has the data layer write `monitor.csv` (`#write`), which the route streams
back as a download. Both operations are effects, listed in `feature.json`.

`DELETE /monitor` takes a body of ids (`{"ids": ["1", "2"]}`) and fires `removeMany`; the domain graph
`remove-entries` maps `remove` over the ids, so every deletion is issued at once and the answer -- the
deleted entries, in the order asked -- leaves only after the last one settled. One id that does not exist
refuses the whole batch as `missing`, a 404. The connection paces this: `monitor-api.connection.json` declares
`"throttle": { "concurrency": 4 }`, so however many ids arrive, at most four requests are in flight
against the API at a time.

## All of it or none of it

Two graphs say `"atomic": true`, and that one word is the whole declaration: every effect the graph reaches
runs inside one transaction on one connection, the answer commits it, and a refusal on purpose or a fault
rolls it back. Nothing is added to the language -- there is no transaction node, no begin and no commit --
and no graph undoes by hand what it wrote.

`record-all.graph.json` is behind `recordAll`, which is what `POST /monitor.csv` records the file through.
It maps `submit` over the drafts, so the rows are still recorded at once rather than one after another; what
the flag adds is that a draft refusing halfway undoes the rows recorded before it. Import a file whose fifth
row is not an entry and the store holds nothing, rather than the first four. The file is read *outside* it,
in `import-entries`, because a transaction undoes rows and not the world: a read that cannot roll back sits
in the caller, and only the writes are inside. That is why the import is two nodes.

`store-and-latest.graph.json` is behind `record`. It stores the entry and records it as the latest call of
its method, in a second collection of the same store, and answers only when both are in. A reader asking
which call was the latest `POST` can never be told an entry that was not stored.

The compiler refuses an atomic graph that could not be one transaction, so the promise is checked rather
than trusted: an effect that cannot take part (`L009` -- an HTTP request, a file), effects on two connections
(`L010`), nothing that could roll back at all (`L011`), and a `map` that collects the failures a transaction
has already ended (`G014`). This is why `recordAll` is bound to `record-all` only where the entries are kept
in a store: under `live` they live behind an upstream API, so that profile binds `record-each` instead --
the same fan-out with no promise, since an HTTP call is not something a transaction can roll back. The
caller's graph does not change either way.

`wilanis describe @monitor/data/store-and-latest.graph.json` says what commits, on which connection, which
nodes take part, and which refusals roll it back; the viewer badges the graph and rims those nodes; and
`wilanis rehearse` marks the graph `(atomic)` and says `rolled back` after the branches that undo it.

Inside the wilanis workspace this directory is a workspace member and resolves the packages locally.
Copied elsewhere, the same `package.json` installs them from npm.
