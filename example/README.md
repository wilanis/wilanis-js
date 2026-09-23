# customers

*This page is the reference. To present the tree rather than read it, [`docs/demo.md`](../docs/demo.md) is the script.*

A wilanis project: a registry of customers kept per tenant, with sign-in, sessions and policies over its writes, and a
command-line greeting gated by a one-time code. Everything in this directory is JSON; `package.json` installs
the runtime and the plugin packages it uses. Two secrets are named in `project.json`: `CUSTOMERS_JWT_SECRET`,
the key our tokens are signed with, which `start` and `run` need in the environment, and
`CUSTOMERS_DATABASE_URL`, which only the `production` profile reads.

**Where the customers are kept is a profile's choice, and nothing else changes.** `live` binds
`customer.port.json` to `customers-rest.binding.json` and the routes talk to a public REST API
(`https://6aa009e23e0d88d3d7e5525d.mockapi.io/api/v1`, no key needed). `local` binds the same port to
`customers-store.binding.json`, and the customers are kept in a store of their own -- `customers.store.json`,
a collection of `Customer` keyed by `id`, over a connection of the memory engine's kind, so nothing leaves
the process. `production` binds it to `customers-postgres.binding.json`, whose data graphs name a store over a
connection of the postgres engine's kind, its URL read from `CUSTOMERS_DATABASE_URL`. The routes, the
policies, the domain graphs and the shapes are the same in all three: only the data graphs behind the port
differ, which is what a port is for.

**The store declares more than the shape and the key.** `unique: [["email"]]` says no two customers share an
address, `defaults: { "tier": "bronze" }` says what a row written before the tier column reads as once
`ensure` adds it -- about rows already there, never about what a graph writes, since `put` always gives the
whole record -- and `renamed: { "email": "emailAddress" }` carries a column whose name changed, keyed by the
field's name now. The compiler judges all three against `Customer`: misspell a field in any of them and
`wilanis check` names it, rather than PostgreSQL finding out on the first write. A `unique` a write would
repeat is answered, not thrown -- `put` hands back `violated`, naming the constraint as the store spells it
(`unique [email]`), and `store-and-latest.graph.json` routes on `has(violated)` with a `switch` to refuse as
`conflict`, its message naming the address and the unique it repeats:

```json
{
  "type": "@wilanis/node/run.schema.json",
  "id": "repeated",
  "label": "A customer already uses this address",
  "description": "The store honoured a constraint it declares -- unique [email] -- and answered violated rather than writing. That is a conflict with what is kept, not a fault of the store, so it is refused as one; the transaction rolls back, and the latest row this run would have replaced is left as it was.",
  "run": "@std/outcome.port.json#refuse",
  "in": {
    "reason": "conflict",
    "message": "a customer already uses {{in.email}} ({{stored.violated}})",
    "type": "@customers/domain/Customer.shape.json"
  }
}
```

`POST /customers` and `POST /customers.csv` map that word to a 409; the same import under `live` never sees
it, since the REST API declares no such thing.

The `production` profile's startup step prepares the database before the port opens, so a tree whose database
is unreachable refuses to serve rather than answering every route with a fault. That there are two store
documents rather than one connection swapped under a profile is the seam RFC 0002 settled and RFC 0005 will
close: a profile swaps bindings, and a store names its connection in the document.

**Both stores keep their customers per tenant, and no graph says so.** `customers` is
`"scoped": { "tenant": "{{tenant}}" }`, and the store's `reads` binds `tenant` to the resolver of that name in
`request.resolvers.json`, which reads `request.session.attributes.tenant`: what the sign-in wrote into the
session from what the directory said about the account (ana is in `acme`, dee in `globex`, and every employee's
session carries `operator`). `Customer` has no tenant field and no data graph names one: the compiler carries
the read to every storage operation over `customers`, and the engine keeps the column and puts it on every
statement, so a caller reads, writes and removes their own tenant's rows and another tenant's id is `missing`.
`wilanis check` holds the rest: every trigger reaching `customers` attaches a policy that proves the session
(`A006`), a graph that writes `scope` by hand is refused (`X214`), and a store scoped by a header or a route
parameter is refused (`A007`), since the caller chose it. The one way across is `everyCustomer`, a `view` of
`customers` `behind` `employees-only`: the digest reads it, and every trigger that reaches it attaches that
policy (`A008`). `latest` is not scoped; its key is the tier, one row for every tenant, and nothing reads it
back. Under `live` the customers are the REST API's, which knows no tenants, and nothing is scoped.

Because the port has three bindings, **a command that runs the tree names a profile**: `--profile local`,
`--profile live` or `--profile production`. `wilanis check` needs none -- it judges every profile.

```
npm install
export CUSTOMERS_JWT_SECRET=$(openssl rand -base64 32)
npm run check                       # wilanis check .  -- every profile at once
npm run rehearse -- --profile local # every trigger, every policy, every branch of every switch, effects stubbed
npm run digest -- --profile local --token=$TOKEN   # an employee's token: the count and one line per customer of every tenant
npm run start -- --profile local    # GET /customers[?tier=], POST /customers, GET|PUT|DELETE /customers/{id}, DELETE /customers, GET|POST /customers.csv,
                                    # POST /api/v1/auth-customers | auth-employees | token/refresh | sign-out, GET|PUT /api/v1/me/preferences on :8099
npm run hello -- --profile local    # challenged until a one-time code is answered
```

Kept in memory, it answers for itself:

```
curl -s localhost:8099/customers                                    # 401: a read is for a signed-in caller
TOKEN=$(curl -s -X POST localhost:8099/api/v1/auth-employees \
  -H 'content-type: application/json' \
  -d '{"username":"bo","password":"bo-pass"}' | jq -r .accessToken)
curl -s localhost:8099/customers -H "authorization: Bearer $TOKEN"  # []
curl -s -X POST localhost:8099/customers -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"name":"Ada","email":"ada@example.com","tier":"silver"}'
curl -s localhost:8099/customers -H "authorization: Bearer $TOKEN"  # the customer, read back from the store
ANA=$(curl -s -X POST localhost:8099/api/v1/auth-customers \
  -H 'content-type: application/json' \
  -d '{"username":"ana","password":"ana-pass"}' | jq -r .accessToken)
curl -s localhost:8099/customers -H "authorization: Bearer $ANA"    # []: ana is in acme, and Ada was kept under operator
```

The store lives exactly as long as the process: stop it and the customers are gone. That is what the memory
engine is for -- development, tests, and a demo that needs nothing installed. Point
`customers.connection.json` at another engine's kind and the same documents keep the same records in a
database.

## A rule about every customer

`a-customer-is-reachable.invariant.json` states one rule over `Customer`, and the whole tree is held to it:

```json
{
  "label": "A customer is reachable",
  "holds": {
    "on": "@customers/domain/Customer.shape.json",
    "when": "len(name) > 0 && len(email) > 0 && (tier != 'gold' || has(note))"
  }
}
```

A name and an address are never empty, and a gold account always carries the note explaining it. Where the
documents settle the rule the checker proves it and nothing is added to the run; where only a run can know,
the compiler lowers a guard the author never wrote, which refuses with the reserved word `invariant` -- which
is why every write route maps `"invariant": 500`.

`writes-are-for-registrars.invariant.json` is the other form, over operations rather than fields: it names
the six operations that change a customer and says what must gate every way in that reaches them. Without it
the six write triggers are six coincidences.

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
export CUSTOMERS_JWT_SECRET=$(openssl rand -base64 32)
export CUSTOMERS_DATABASE_URL=postgres://user:password@127.0.0.1:5432/customers
```

`Customer` has changed in two ways: it gained an optional `note`, and the column holding the address was
`emailAddress` where the field is now `email`. The added field a diff can see. The rename it cannot -- from
outside, `emailAddress` gone and `email` new is a dropped column and a new one, and every address lost -- so
the collection says it, keyed by the field's name now:

```json
"defaults": { "tier": "bronze" },
"renamed": { "email": "emailAddress" }
```

**The plan.** Nothing has happened yet; this is what would:

```
$ npx wilanis migrate . --profile production
plan for @connections/customers-postgres.connection.json  (@storage-postgres/postgres.connection-kind.json, granted by @storage-postgres)
  customers
    rename   rename emailAddress → email                  transformative
    add      add note  string, optional                   additive
plan for @connections/customers.connection.json  (@storage-memory/memory.connection-kind.json, granted by @storage-memory)
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
    drop     drop collection notes                       destructive     ✗ needs --allow-destructive @connections/customers-postgres.connection.json/notes
      loses every row of notes
```

```
$ npx wilanis migrate . --profile production --apply --allow-destructive '@connections/customers-postgres.connection.json/notes'
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
plan for @connections/customers-postgres.connection.json  (@storage-postgres/postgres.connection-kind.json, granted by @storage-postgres)
  up to date
  note: renamed.email has been applied -- remove "renamed": { "email": "emailAddress" } from the customers collection once every database has applied it
plan for @connections/customers.connection.json  (@storage-memory/memory.connection-kind.json, granted by @storage-memory)
  skipped: nothing is kept between processes, so there is nothing to migrate

nothing to apply
```

It asks and does not refuse: a tree is deployed to more than one database, and the mark has to survive until
the last of them has moved. A fresh database has no `emailAddress` to rename, so it reads the shape as it
stands and every collection is simply created.

`wilanis start` never migrates destructively. The startup step that prepares the store applies additive
steps only; anything more and it refuses as `drift`, printing the plan and naming this command. So
production changes shape because an operator ran it and read the plan, never because a process started.

## Who may do what

Every read (`GET /customers`, `GET /customers/{id}`, `GET /customers.csv`) attaches `signed-in`, since what it
answers is the caller's tenant's customers and an anonymous caller has no tenant. Every write (`POST /customers`, `PUT|DELETE /customers/{id}`, `DELETE /customers`,
`POST /customers.csv`) attaches two policies, and gives the guard the token where the route reads it:

```json
"policies": [
  {
    "policy": "@access/edge/employees-only.policy.json",
    "in": {
      "token": [
        "{{request.headers.authorization}}",
        "{{request.cookies.session}}"
      ]
    }
  },
  "@access/edge/can-register.policy.json"
]
```

The `access` feature is not written here: `project.json → includes` names `@wilanis/access`
(`libraries/access` in this workspace), and its `features/access` loads as if it sat in this tree -- the same
paths, the same rules, `included from @wilanis/access` in `wilanis describe` and the viewer. What this
project adds is `features/directories`: the binding of the included `identity.port.json` to this project's
two directory connections.

There are two sign-in routes, and they are for two different sets of people. `POST /api/v1/auth-employees`
verifies the credential against the employee directory (`connections/employees.connection.json`: bo /
bo-pass holds the `registrar` group and may write customers; cy / cy-pass holds only `viewer` and may not).
`POST /api/v1/auth-customers` verifies it against the account holder directory
(`connections/people.connection.json`: ana / ana-pass in the tenant `acme`, dee / dee-pass in `globex`). The registry's *records* are customers; the people
who sign in there are the account holders those records are about. An account holder gets a perfectly valid
token of our own and can read their preferences and their tenant's customers with it, and no write route will take it. Both directories
are written in the connection, for development; a production profile binds the same `identity.port.json` to
an OIDC issuer or LDAP, in `features/directories`, and nothing in the included tree changes.

Either way the caller gets **our** token, signed by the `@auth` plugin: the sign-in graph writes the realm
(`employee`, `customer`) and the directory's groups as roles, and that is the domain's decision, not the
caller's. Present it as `Authorization: Bearer ...`; the route also sets it as the `session` cookie, so a
browser needs no header.

```
curl -s localhost:8099/api/v1/auth-employees -d '{"username":"bo","password":"bo-pass"}' -H 'content-type: application/json'
curl -s localhost:8099/customers -d '{"name":"Ada","email":"ada@example.com","tier":"silver"}' -H 'content-type: application/json' -H "authorization: Bearer $TOKEN"
```

On a write, the `@auth` guard verifies the token and hands `request.principal`; then `employees-only` decides
on the realm (an account holder's token is `forbidden`, a 403) and `can-register` on the role (cy is
`forbidden` too; no token is `anonymous`, a 401; a bad token is `invalid_credential`, a 401). Each decision
is a domain graph in `features/access/domain/require-*.graph.json`, one `switch` each --
`has(principal) && 'registrar' in principal.roles` -- and `wilanis rehearse` walks every branch of every one
of them. The policies map each reason to deny; the routes map each reason to a status.

## The session

`PUT /api/v1/me/preferences {"theme":"dark"}` stores the theme in the caller's session and `GET` reads it
back on a later call, with the same token or a refreshed one (`POST /api/v1/token/refresh` trades the refresh
token for a new pair and spends the old one). The session's attributes are the core shape
`Session.shape.json`, named by the plugin's `settings.session`; sign-in writes `displayName` and `realm` into
it, `savePreferences` writes `theme`, and `wilanis describe @access/domain/Session.shape.json` lists who
writes what. The session id reaches the data graphs as `{{sid}}` through `session.resolvers.json`, declared
`required` because the `signed-in` policy proves it. `POST /api/v1/sign-out` ends the session: its tokens
stop verifying and the cookie is cleared.

Where the sessions and the challenges themselves are kept is a binding too. `features/state` meets the
plugin's `state.port.json` with one JSON file each under `.wilanis/auth/`, which is what lets a server and
the `wilanis run` calls of the one-time code flow share them. Many instances would bind that port to a store
instead. A startup step reads one session through it before the port opens, so a tree whose memory is
unreachable refuses to serve rather than refusing every signed-in caller.

## The one-time code

```
$ npm run hello
{ "reason": "otp", "message": "this command needs a one-time code",
  "challenge": { "id": "K7Q2-M9XA", "method": "otp", "expiresAt": "..." },
  "how": "npm run issue-otp -- --challenge-id=K7Q2-M9XA; then repeat this call with --challenge-id=K7Q2-M9XA --code=<code>" }
$ npm run issue-otp -- --challenge-id=K7Q2-M9XA
{ "id": "K7Q2-M9XA", "code": "482913", "expiresAt": "..." }
$ npx wilanis run @hello/edge/hello-gated.trigger.json . --challenge-id=K7Q2-M9XA --code=482913
{ "greeting": "hello, gated" }
```

`hello-gated` attaches the `otp-verified` policy, giving the guard the challenge answer from `--challenge-id`
and `--code`; the policy's outcome for `otp` is a challenge. The guard opens one and tells the caller how to
answer it in the kind's own words; `issue-otp` gives it a code (printed here, delivered by whatever a
production profile binds `deliverCode` to); the guard verifies the code the caller presents and hands
`request.challenge`, the policy allows, and the challenge is spent by the run. The three processes share the
challenge through the plugin's store under `.wilanis/auth/`.

## The digest, across tenants

`digest.trigger.json` is a command: `npm run digest -- --token=<an employee's access token>` prints the count
and one line per customer of every tenant. It fires `customer.port.json#digest`, whose graph runs
`listEvery`, and under a store that is a `find` over `everyCustomer`, the view of `customers` across every
tenant. The view is `behind` `employees-only`, so the command attaches it and gives the guard the token from
`--token`; drop the policy and `wilanis check` refuses the trigger (`A008`), naming the graph, the node and
the view it reaches.

A digest used to fire at three in the morning, too. It does not now: a tick has no caller, so it has no tenant
to be scoped by and no one for `employees-only` to be about. A policy that read the caller would be refused on
it (`A005`), and without one it may reach neither `customers` (`A006`) nor the view (`A008`). A job over
customers kept per tenant is one run per tenant, fired by something that knows the tenant, and nothing in this
tree does yet. The `Keep the schedule` step stays, and schedules nothing until a scheduled trigger is written.

## What this tree starts

`project.json → startup` says what this tree starts, in order, and nothing else runs. `customer.port.json#prepare`
makes storage ready once: over a store it creates the collections the store declares, over the REST API it
reads the collection once. `customer.port.json#backfill` then makes whole every record that predates what a
customer means here -- the REST API is a public one, seeded with rows that carry a name and nothing else this
tree promises, so the step reads them through `RawCustomer`, gives each an address and a tier, and writes it
back. A record that already says who it is is left alone, so a second start writes nothing; the connection's
throttle paces the writes at three a second. Under a store there is nothing to repair and the step passes
over an empty walk, which is what lets one step serve every profile. `customer.port.json#listEvery` then reads
the customers of every tenant -- nobody is calling yet, so there is no tenant to read (`B008`) -- so a tree whose storage is unreachable refuses to serve rather than answering every route with
a fault. `@auth/state.port.json#getSession`
does the same for the guard's memory. `@reload/watch.port.json#watch` serves the tree again whenever a
document changes, without closing the port. `@schedule/scheduler.port.json#run` keeps the schedule, which is empty here.
`@otel/exporter.port.json#export` sends every run as spans to a collector on :4318; it is the one step marked
`"required": false`, since no collector is running when you clone this, and what it cannot send is said once
in the log rather than delaying the run. `@http/server.port.json#listen` opens :8099 -- **delete that step
and nothing listens**, since no runtime opens a port merely because http triggers exist. The first three are
domain port operations, so whichever binding the profile chose is what gets checked; the last four are
`holds` operations, which a plugin grants and the runtime stops when the process ends.
`wilanis describe @http/server.port.json` says which plugin grants it.

## The port, and what meets it

`customer.port.json` is what the domain needs: `listAll`, `listByTier`, `get`, `register`, `update`,
`remove`, `removeMany`, `submit`, `registerAll`, `list`, `digest`, `parseDrafts`, `toCsv`, `import`,
`export`, `prepare`. `customers-rest.binding.json` meets the data operations with a data graph each, which
issues one declared request and decides with a `switch` on `status` what the answer means: the row, the
declared refusal `no customer {id}` with reason `missing` when the API answers 404, or the refusal `upstream`
for anything else. The http triggers map those words to statuses (`"refusals": { "missing": 404, "upstream":
502 }`, and `"conflict": 409` on the writes a store may refuse), so the graphs never mention HTTP and a
client is told `{ "reason": "missing", "message": "no customer 7" }` with a 404. The rest are met by domain
graphs that compose those operations: `list` routes on whether a tier filter is present, `submit` attributes
the customer to the registrar that registered them and registers it, `removeMany` maps `remove` over the ids,
`digest` counts the customers and lays them out as text. The API's own `createdAt` lives in the edge shape
`CustomerRow` and never reaches the domain.

`POST /customers.csv` takes a CSV file (header `name,email,tier`) and `GET /customers.csv` answers one. The
file never enters a graph: `text/csv` is mapped to the blob codec in `project.json`, so the upload streams
into the blob registry and the route hands the domain a handle; `import-customers` has the data layer read it
as drafts (`@blob/csv.port.json#parse`, typed by `CustomerDraft`) and then registers them all at once through
`registerAll`, which is where the atomicity below lives; `export-customers` lists everything and has the data
layer write `customers.csv` (`#write`), which the route streams back as a download. Both operations are
effects, listed in `feature.json`.

`DELETE /customers` takes a body of ids (`{"ids": ["1", "2"]}`) and fires `removeMany`; the domain graph
`remove-customers` maps `remove` over the ids, so every deletion is issued at once and the answer -- the
deleted customers, in the order asked -- leaves only after the last one settled. One id that does not exist
refuses the whole batch as `missing`, a 404. The connection paces this:
`customers-api.connection.json` declares `"throttle": { "concurrency": 4 }`, so however many ids arrive, at
most four requests are in flight against the API at a time.

## Trying again, and for how long

The read of one customer tries again when the API stumbles. Its node `fetched` in `get-row.graph.json` says
`"timeoutMs": 5000` and `"retry": { "times": 2, "backoffMs": 200, "when": "status >= 500" }`: a request that
faults, takes longer than five seconds or is answered 5xx is sent again, at most twice more, after 200 ms and
then 400 ms. The checker accepts it because `@http/http.port.json#request` declares itself idempotent when its
method is GET, HEAD, PUT or DELETE, and the method here is the literal `GET`. The connection's own
`timeoutMs: 10000` still applies, and the tighter bound wins. An answer `when` accepts on the last try stands,
so a 503 three times over still reaches the switch and is refused as `upstream`. The binding retries `listAll`
whole, once, within eight seconds (`"retry": { "times": 1 }, "timeoutMs": 8000`), since every request
`list-rows.graph.json` reaches is a GET; a retry repeats a fault and never a refusal, so a graph that refused
`upstream` is not run again. The same retry on `posted` in `create-row.graph.json` is refused as `G018`
(`method is "POST"`: a POST that failed may have been applied), and on a node of a domain graph as `L012`,
since whether recording a customer is worth trying twice is the profile's business, not the domain's. And
`customer.port.json` promises that `get` is `"idempotent": true`, which a caller that repeats a read leans on.
`wilanis describe @customers/data/get-row.graph.json` prints the node as `retries 2 (200ms backoff, when
status >= 500)  timeout 5000ms`, and the viewer badges it.

## All of it or none of it

Two graphs say `"atomic": true`, and that one word is the whole declaration: every effect the graph reaches
runs inside one transaction on one connection, the answer commits it, and a refusal on purpose or a fault
rolls it back. Nothing is added to the language -- there is no transaction node, no begin and no commit --
and no graph undoes by hand what it wrote.

`register-all.graph.json` is behind `registerAll`, which is what `POST /customers.csv` registers the file
through. It maps `submit` over the drafts, so the rows are still registered at once rather than one after
another; what the flag adds is that a draft refusing halfway undoes the rows written before it. Import a file
whose fifth row is not a customer and the store holds nothing, rather than the first four. The file is read
*outside* it, in `import-customers`, because a transaction undoes rows and not the world: a read that cannot
roll back sits in the caller, and only the writes are inside. That is why the import is two nodes.

`store-and-latest.graph.json` is behind `register`. It stores the customer and records them as the latest
registration into their tier, in a second collection of the same store, and answers only when both are in. A
reader asking who was registered into gold most recently can never be told a customer that was not stored.

The compiler refuses an atomic graph that could not be one transaction, so the promise is checked rather
than trusted: an effect that cannot take part (`L009` -- an HTTP request, a file), effects on two connections
(`L010`), nothing that could roll back at all (`L011`), and a `map` that collects the failures a transaction
has already ended (`G014`). This is why `registerAll` is bound to `register-all` only where the customers are
kept in a store: under `live` they live behind an upstream API, so that profile binds `register-each`
instead -- the same fan-out with no promise, since an HTTP call is not something a transaction can roll back.
The caller's graph does not change either way.

`wilanis describe @customers/data/store-and-latest.graph.json` says what commits, on which connection, which
nodes take part, and which refusals roll it back; the viewer badges the graph and rims those nodes; and
`wilanis rehearse` marks the graph `(atomic)` and says `rolled back` after the branches that undo it.

Inside the wilanis workspace this directory is a workspace member and resolves the packages locally.
Copied elsewhere, the same `package.json` installs them from npm.
