# RFC 0016: Capability-aware compilation: what a tree requires against what an environment permits

- **Status:** implemented
- **Areas:** `area:core` (one additive key on `project.schema.json`: `profiles.<name>.permits`; `ProjectDoc`),
  `area:compiler` (three rules in `check/project.ts`, all over RFC 0013's `reachOf`), `area:runtime` (two lines
  of `describe`; the example's `production` profile), `area:view` (the project page). Nothing in the engine,
  nothing in a plugin.
- **Schemas:** `project.schema.json` gains `profiles.<name>.permits` (additive)
- **Packages:** none new
- **Tracking issue:** #18
- **Depends on:** RFC 0013 (the profile as one place a tree runs, and `reachOf`, the derived list this RFC
  holds `permits` to). Nothing else: RFC 0020 and RFC 0026 read this RFC, not the reverse.

## Summary

A profile may write `permits`: the effectful native operations, whole native ports, and connections the place
it names allows the tree to reach. The checker holds the profile's reach (RFC 0013) to that list in both
directions. An operation or a connection the tree reaches under the profile and the list does not permit is
refused, naming the trigger or startup step it is reached from, the binding it is reached through, the
feature -- and the package, when the feature is included -- with the hint to remove the reach before widening
the list. An entry nothing reaches is refused as dead. A profile without `permits` permits everything, so no
tree written before this RFC changes; the security model (RFC 0020) recommends every production profile write
one.

## Motivation

The stub said the declaration side was built: `feature.json → effects` lists what a feature requires, L003
refuses a data graph that runs anything else, and only the environment's side was missing. The first half is
wrong in a way that matters. `feature.json → effects` is what a feature *allows* its data layer to reach: an
upper bound, written by the feature's author, the same under every profile. It is not what the tree does
under a profile. `example/features/customers/feature.json` will list both `@http/http.port.json#request` and the
`@storage/store.port.json` operations once RFC 0002 lands, because the feature holds a REST binding and a
storage binding and the profile chooses between them; comparing that list with a `production` that permits
storage alone would refuse production for an `http.request` it never runs.

What production requires is what production reaches: the operations behind the bindings *it* chose, and the
connections those operations name, from the triggers, the policies, the guard and the startup steps that run
there. RFC 0013 derives that as `reachOf`. This RFC adds the third list and the comparison:

| List | Written by | Where | Judged by |
|---|---|---|---|
| what a feature **allows** its data layer | the feature's author | `feature.json → effects` | L003, today |
| what the tree **reaches** under a profile | nobody: derived | `reachOf(scope, profile)` | RFC 0013 (secrets at start); this RFC (against permits) |
| what a place **permits** | the environment's author | `profiles.<name>.permits` | this RFC |

Two allow-lists at two altitudes bracket a derived middle. The feature's author says what the feature may
do; the environment's author says what the place may do; the checker holds what the tree does to both. Today
a generated feature that quietly adds `@http/http.port.json#request` to its own `feature.json` and a new
connection under `connections/` passes, because the only list is the one the same author edits. After this
RFC it passes the feature and is refused by the profile, and the refusal names the trigger that reaches out
and the connection it reaches.

This RFC does not say which hosts an `http.request` against a permitted connection may reach, which tables a
store may touch or which bucket a blob store may write: those are the connection's settings, and RFC 0013's
`connections` is how a profile chooses them. It does not check anything at run time (*Runtime behaviour* says
why). It does not publish the security model (RFC 0020) or the manifest (RFC 0026); both print what this RFC
judges.

## Guide-level explanation

**One list per profile.** `example/project.json`'s `production` (RFC 0013) gains `permits`:

```json
"production": {
  "description": "Behind the load balancer, started with `wilanis start example --profile production`: the customers in PostgreSQL, the one operator account in place of the laptop's employees, and nothing watched. ...",
  "bindings": {
    "@customers/domain/customer.port.json": "@customers/data/customers-postgres.binding.json",
    "@access/domain/identity.port.json": "@features/directories/data/identity.binding.json",
    "@auth/state.port.json": "@features/state/data/auth-storage.binding.json"
  },
  "connections": {
    "@connections/employees.connection.json": "@connections/employees-production.connection.json",
    "@connections/jobs.connection.json": "@connections/customers-postgres.connection.json"
  },
  "permits": [
    "@storage/store.port.json",
    "@storage/storage.port.json#ensure",
    "@queue/queue.port.json",
    "@blob/csv.port.json",
    "@auth/identity.port.json#verify",
    "@auth/token.port.json",
    "@auth/session.port.json",
    "@auth/challenge.port.json#issue",
    "@otel/exporter.port.json#export",
    "@http/server.port.json#listen",
    "@connections/customers-postgres.connection.json",
    "@connections/people.connection.json",
    "@connections/employees-production.connection.json"
  ]
}
```

An entry is an operation, `path#operation`; a whole native port, `path`, which permits every operation of it;
or a connection, which permits reaching the system it describes. The list is what production does and nothing
more. It does not name `@reload/watch.port.json#watch`, because the `Watch for changes` step runs under `live`
and `local` alone (RFC 0013), nor `@schedule/scheduler.port.json#run` or `@queue/worker.port.json#consume`,
since production keeps no schedule and works no queue: those steps run on the laptop and under
`production-scheduler` and `production-worker`, and production only publishes to the removals queue. It names
`listen`, because opening a port is something a place permits or does not, and `production-worker`, which serves
no route, would not. It names no `@http/http.port.json#request`: under production the customers are in
PostgreSQL, so nothing it reaches asks an API. It names the stand-ins, `employees-production` and
`customers-postgres`, and not the connections they stand in for (`employees`, `jobs`), because the stand-ins are
what production reaches. `live` has no `permits` and permits everything, as the example's other profiles do.

**When a feature reaches out.** An agent gives the hello feature a quote of the day: a connection
`@connections/quotes.connection.json` to a public API, a data graph `@hello/data/fetch-quote.graph.json` that
runs `@http/http.port.json#request` against it, and a line in `greeting.binding.json` that binds `greet` to
the new graph. `wilanis check` refuses it at two altitudes:

```
L003  @hello/data/fetch-quote.graph.json#nodes/quote
    node 'quote' runs effectful '@http/http.port.json#request' which the feature does not allow
    → add "@http/http.port.json#request" to @features/hello/feature.json → effects

C0nn  project.json#profiles/production/permits
    profile 'production' does not permit '@http/http.port.json#request', reached from
    @hello/edge/hello-gated.trigger.json through @hello/data/greeting.binding.json (feature hello)
    → remove the node that reaches it, or bind the port to a binding that does not; else, if production may,
      add "@http/http.port.json#request" to profiles/production/permits

C0nn  project.json#profiles/production/permits
    profile 'production' does not permit '@connections/quotes.connection.json', reached from
    @hello/edge/hello-gated.trigger.json through @hello/data/greeting.binding.json (feature hello)
    → remove the node that reaches it, or bind the port to a binding that does not; else, if production may,
      add "@connections/quotes.connection.json" to profiles/production/permits
```

The agent may fix L003 alone, since the feature is its to edit. Production permits no `http.request`, because
nothing it reached asked an API before the quote, so the operation is refused as well as the connection, and
both refusals stay until either the graph no longer reaches them or a person decides production may. A place
that already made requests would pass the operation and still refuse the *connection*: permitting
`http.request` is not permitting every system. The hint says remove first; widening the list is the last
clause, written so that the diff a reviewer reads is the lines in `project.json` under the word `production`.

**When the list is stale.** The customers stops exporting CSV: the node that ran `@blob/csv.port.json#write`
goes, and so does the one that ran `#parse`. `wilanis check` then refuses the profile that still says it may:

```
C0nn  project.json#profiles/production/permits
    profile 'production' permits '@blob/csv.port.json', but nothing it reaches runs an operation of that port
    → remove it from profiles/production/permits
```

So `permits` never drifts wider than the tree: the list a reviewer reads is exactly what the place does,
written by a person and held by the checker.

**Includes.** The example includes `@wilanis/access`, whose sign-in routes reach `@auth/identity.port.json#verify`
against the two directories through the identity binding the host chose: under production, `people`, the
account holders', and `employees-production`, the one operator account standing in for the laptop's employees.
The host's profile permits them, or does not; nothing in between:

```
C0nn  project.json#profiles/production/permits
    profile 'production' does not permit '@connections/people.connection.json', reached from
    @access/edge/auth-customers.trigger.json through @features/directories/data/identity.binding.json
    (feature access, included from @wilanis/access)
    → remove the feature from includes[].features, or bind identity.port.json to a binding that does not; else, ...
```

An included feature is a unit: a host that will not permit what one of its triggers reaches leaves the
feature out of `includes[].features`, and every trigger of it with it.

## Reference

### Documents and schemas

`project.schema.json → profiles.<name>.permits`: an array, `uniqueItems`, of `common.schema.json#/$defs/opRef`
or `#/$defs/path`, with the description: *What this place allows the tree to reach: effectful native
operations as path#operation, whole native ports as path, and connections as path. Absent: everything.
Present: exactly what the profile reaches (C0nn) -- an operation or connection reached and not listed is
refused, and so is an entry nothing reaches.* `ProjectDoc` in `packages/core/src/model.ts` mirrors it:
`permits?: string[]`. `HOME` in `placement.ts`: no change. `packages/runtime/templates/CLAUDE.md`: the
`project` row names `permits`; a sentence under *Effects*: "a profile may list what its place permits; L003
means the feature allows it, C0nn means the place does". `wilanis new project` scaffolds no `permits`: the
laptop permits everything.

### Ports, operations and kinds granted

None.

### Checker rules

All in `check/project.ts`, in one function `checkPermits(judge, name, profile)` called from `checkProject`
for every profile with `permits`, reading `reachOf(judge.scope, name)` (RFC 0013): its `effects` and its
`connections`, the latter already resolved through the profile's `connections` map, so a stand-in is what is
compared. Numbers are assigned when the implementing pull request lands (current highest: A006 B008 C008 D010
G013 L008 P003 R001 S001 T006, X103; RFC 0003 took C003-C008, and RFC 0013 takes its C codes before this one).

| Code | Where it lives | Refuses when | Hint |
|---|---|---|---|
| C0nn | `checkPermits` | the reach holds an operation no entry permits (no entry is that operation and none is its port), or a connection no entry names. The message names what is reached, the root it is reached from (a trigger, a policy, a startup step, or the guard), the binding it is reached through, the feature, and the include's package when the feature is included | `remove the node that reaches it, or bind the port to a binding that does not; else, if <profile> may, add "<entry>" to profiles/<profile>/permits` (for an included feature the first clause reads `remove the feature from includes[].features`) |
| C0nn | `checkPermits` | an entry permits nothing the profile reaches: an operation entry not in the reach, a port entry none of whose operations is, a connection entry no reached operation names | `remove it from profiles/<profile>/permits` |
| C0nn | `checkPermits` | an entry names a domain port or one of its operations (a port a binding meets, including one a plugin requires), a `pure` operation, a port with no effectful operation, or a connection that stands on the left of this profile's `connections` map (the tree reaches its stand-in, not it) | `permits lists effectful native operations and connections; a domain port is met by a binding, a pure operation needs no permit, a replaced connection is named by its stand-in` |
| R001 (existing) | `checkPermits` | an entry names no port, no connection, or a port with no such operation | `wilanis ls port`, `wilanis ls connection` |

A `holds` operation is effectful and is permitted like any other: `listen`, `watch`, a subscription, a
scheduler. L003 is unchanged. No rule reads `permits` at any other place: a feature never sees a profile.

### Runtime behaviour

None. `wilanis start` runs `check` before anything (`check()` in `cli.ts`), so a tree that reaches what its
profile does not permit never reaches `postLoad`. The stub asked whether `start` should re-check `permits`
against "the actual plugin set"; there is no other plugin set: the plugins are the ones `project.json →
plugins` names, loaded by the checker and the runtime from the same `node_modules`, and the environment
cannot add one. `rehearse`, `fuzz`, `regress` and `run` are unchanged.

### Discoverability

- `wilanis describe project.json` (RFC 0013's block per profile) prints `permits` under `reaches`: `permits
  the 6 operations and 3 connections above, by 8 entries` when the list is present, `permits   everything (no
  permits)` when not. Since the checker holds the two lists together, the block never has to show a
  difference; `wilanis check` does.
- `wilanis describe <native port>` and `wilanis describe <connection>` gain `permitted by  production, staging`
  after their `granted by` or `kind` line, naming every profile whose `permits` names the document or one of
  its operations.
- The viewer's project page shows `permits` in the profile table beside `reaches`, and a profile without one
  says *everything*.
- `wilanis check --json` (RFC 0019) carries the three refusals as it carries every refusal; the message's
  named root, binding and feature are what a repair loop needs to find the node.

### Plugin contract

None.

## Compatibility

One additive key on `project.schema.json`. A project without `permits` on any profile validates and behaves
exactly as before: no reach is compared, no refusal is possible. IR v1 unaffected: no lowered form carries a
profile or a permit. RFC 0020's *Guaranteed by the checker* line "the permits of RFC 0016" becomes true as
written; RFC 0022's paragraph on the two words (`permits` on a profile, `capabilities` on a storage kind) stays
right, and this RFC uses *capability* only in its title.

## Tests

Sabotage, in `packages/runtime/test/sabotage-project.test.ts` (copies of the example hand `@wilanis/access`
in as a `ResolvedInclude`), against the example's `production` profile of RFC 0013:

- remove `"@http/http.port.json#request"` from `permits` → C0nn naming the operation, a customer trigger,
  `customers-rest.binding.json` and `feature customers`;
- remove `"@connections/customers.connection.json"` → C0nn whose message ends `(feature access, included from
  @wilanis/access)` and whose hint's first clause names `includes[].features`;
- add `"@reload/watch.port.json#watch"` → C0nn (dead: the step runs under `live` alone);
- add `"@blob/text.port.json"` → C0nn (dead port: no operation of it is reached);
- add `"@connections/customers-api.connection.json"` beside the stand-in → C0nn (replaced under this profile);
- add `"@customers/domain/customer.port.json"` → C0nn (a domain port); add `"@std/text.port.json#join"` → C0nn (pure);
- add `"@http/http.port.json#fetch"` → R001; add `"@connections/nowhere.connection.json"` → R001;
- give `live` a `permits` equal to what it reaches, watcher and test API included → passes; the same list on
  `production` → C0nn for the watcher and for the test API, proving the reach is per profile and resolves
  stand-ins;
- add the quotes connection and the fetch-quote graph to hello and list `http.request` in `hello/feature.json`
  → `production` alone refuses, with C0nn naming the connection; L003 does not.

No end-to-end test: nothing runs.

## Implementation plan

1. `permits` on the schema and `ProjectDoc`; `checkPermits` with the three C rules over `reachOf`; the
   sabotage tests; the line RFC 0020 gives this RFC, "a profile with `permits` reaches exactly what it permits, and
   permits only effects and connections", added to `docs/security-model.md` under *Guaranteed by the checker* with
   the three C codes. Blocked on RFC 0013's step 1 (`reach.ts`). (`area:core`, `area:compiler`)
2. `permits` on the example's `production`; the `templates/CLAUDE.md` row and sentence; one sentence in the
   README's *Effects are explicit* bullet, which is the *Effects are explicit* section of `docs/model.md` since
   the README's rewrite. (`area:runtime`; `good first issue`)
3. `describe project.json`, `describe <port>` and `describe <connection>` lines; the viewer's profile table.
   (`area:runtime`, `area:view`; `good first issue`)

## Drawbacks and alternatives

- **Two lists that must agree, in both directions.** Every node that reaches out, and every one removed,
  touches `project.json` under a profile that has `permits`. That is the cost, and it is the feature: the
  diff under the word `production` is the review. The hint's order -- remove first, widen last -- is what
  keeps an agent from turning every refusal into a wider list, and the dead-entry rule is what keeps the list
  from staying wide once the reach has shrunk. The alternative, one direction only (reached ⊆ permitted),
  was rejected: a list that may be wider than the tree tells a reviewer what the tree *might* do, not what it
  does.
- **Connections are in the list, which the stub left to the connection.** The stub permitted operations and
  said "which hosts `http.request` may reach are the connection's". Both stay true of *hosts*: a connection's
  `baseUrl` is its allow-list. But the stub's own motivating case -- a generated feature that quietly reaches
  a new API -- is not caught by operations alone once the place permits `http.request` for anything, and
  every real place does. A connection is the unit at which "may this tree talk to that system" is asked, and
  the reach already knows which ones are reached, so the list names them. The cost: a `permits` list is longer
  by one line per system, and a stand-in (RFC 0013) is named twice, once in `connections` as the choice and
  once in `permits` as the permission.
- **A whole-port entry permits operations the port does not have yet.** A plugin update that adds an
  operation to `@blob/csv.port.json` is permitted by the entry `"@blob/csv.port.json"` without a diff. That
  is the trade a port entry makes for brevity; a profile that wants the diff writes operations. The
  example writes the port for `@storage/store`, `@queue/queue`, `@blob/csv`, `@auth/token` and `@auth/session`,
  and the operation for each port that has one; `@storage/store` whole also permits `count` and `patch`, which
  production does not reach today.
- **Deriving `permits` from the bindings** was rejected in the stub and stays rejected: then nothing would be
  written by a person, and the checker would compare a list with itself. Printing the derived list is what
  `describe` and the manifest do.
- **A separate `environments` block a profile names** (the stub's first open question) was rejected: RFC 0013
  makes the profile the place, so a second document for the same place would split what a reader wants
  together.
- **`permits` per feature, or on `feature.json` per profile,** was rejected: a feature never knows about
  profiles, and a place's allow-list that lived in twelve features would be read by nobody.
- **A `pure` operation in `permits` is refused rather than ignored.** Ignoring it would let a list say
  `@std/text.port.json#join` is "permitted" and teach a reader that pure operations are effects. The refusal
  is cheap and the message explains the word.

## Open questions

None before `accepted`.

**Settled here, so the reasoning survives.**

- **A profile without `permits` is silent.** `wilanis check` prints nothing for it, neither a line nor a
  refusal: the laptop profile of every tree would print it forever, and `describe` and RFC 0026's manifest
  already say *everything* where a reader looks for it. RFC 0020 is where a production profile is told to
  write one.
- **The default profile may carry `permits`.** `default` (RFC 0013) says which profile a start with no name
  runs; `permits` says what its place allows. Nothing about the one changes what the other means, and a tree
  whose laptop wants the list held may write it.

**Left to implementation, deliberately:** the exact wording of the three messages, and whether the first
names every root that reaches the operation or the first found, which this RFC says is the first found with a
count (`and 3 more`) so a message stays one screen; and whether the `permitted by` lines of `describe` are
worth their cost against a tree with many profiles.

## Decided during implementation

- The three messages landed as C021, C022 and C023 in `check/permits.ts` (#660), and C021 names the first root
  found with a count, `(and 3 more)`, as this RFC says.
- The `permits` row of `describe project.json` prints after `holds` rather than straight under `reaches`: the count
  covers the held operations too (`@http/server.port.json#listen` is permitted like any other), and "above" is true
  only once both are printed. It counts entries, as #309 writes it: `permits    the 19 operations and 3 connections
  above, by 13 entries` under the example's `production`.
- The `permitted by` lines are kept (#309). They read only what each profile writes, never a walk, since the checker
  already holds each list to its profile's reach, and they print one line however many profiles there are, where
  `stands in for` and `bound by` already print one per profile. A profile with no `permits` is never named: it
  permits everything and its block in `describe project.json` says so once, so a tree none of whose profiles writes
  one prints no line. Where some profile writes one and none names the document, the line says `no profile that
  writes permits`, which is what an author about to reach a new API or connection needs to read. A profile that
  names some operations of a port rather than the port whole is named with them: `permitted by  production
  (#ensure)`. A native port with no effectful operation and a domain port print nothing, since no permit may name
  them (C023).
