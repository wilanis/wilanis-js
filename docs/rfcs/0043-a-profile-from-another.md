# RFC 0043: A profile from another: `extends` names the profile one starts from

- **Status:** draft
- **Areas:** `area:core` (one key on `project.schema.json`; `ProfileDoc`; one new module that resolves a profile;
  `Scope.profile`, which `bindingFor` and `connectionFor` read), `area:compiler` (one `C` rule in
  `check/profiles.ts`; `checkPermits` reads the resolved list), `area:runtime` (`describe project.json`, the
  manifest's profile block and `manifest.schema.json`), `area:view` (the project page). Nothing in the engine,
  nothing in a plugin.
- **Schemas:** `project.schema.json` gains `profiles.<name>.extends`, and `bindings` is required only where
  `extends` is absent (both compatible). `packages/runtime/schemas/manifest.schema.json` gains `extends` on a
  profile block (a key added, as RFC 0026 allows).
- **Tracking issue:** #909
- **Depends on:** RFC 0013 (profiles, stand-ins, `reachOf`; implemented) and RFC 0016 (`permits`, C021-C023;
  implemented). It reverses one item RFC 0013 set aside under *Drawbacks and alternatives*, quoted below. It does
  not edit RFC 0013, which is implemented. It lands before RFC 0037 (draft), which also changes what C021 and C022
  read; *Order with RFC 0037*, under *Implementation plan*, says why and what each leaves to the other.

## Summary

After this RFC a profile may name one other profile it starts from: `"extends": "review"`. The profile then has
the bindings, the stand-in connections and the permits of `review`, except where it writes its own. A binding it
writes replaces the inherited binding for that port. A stand-in it writes replaces the inherited stand-in for
that connection. A `permits` list it writes replaces the inherited list whole. An inherited permit for a connection
this profile stands in for permits the stand-in, and still permits the connection it named wherever this profile
reaches that connection another way. `default` and `description` are never inherited.
There is one level: the profile named in `extends` may not extend another. Core resolves a profile once, in
`Scope.profile(name)`, and every reader of what a profile means reads it there: `bindingFor`, `connectionFor`,
the checker (B002, B011, C021, C022, C023), `reachOf`, the manifest, `describe` and the viewer. The rules about
one written line (R001, B003, B004, C018) still judge that line once, where it is written. `describe`, the
manifest and the viewer print the resolved profile and say what it extends. The RFC leaves plugin settings per
profile out, and says why.

## Motivation

**What RFC 0013 decided.** RFC 0013 considered `extends` and set it aside. Its *Drawbacks and alternatives*
(`docs/rfcs/0013-deployment-and-profiles.md`, lines 377-379) says:

> **A profile per process role.** RFC 0009's worker and the web process of the same cluster are two profiles
> that repeat their `bindings` and `connections`. An `extends` between profiles was considered and set aside:
> one more indirection a reader follows, for a few repeated lines the manifest prints resolved anyway.

The reason has two parts: the repeated lines are few, and the indirection costs the reader. The phrase "once the
duplication has proved heavier than the rules" in the same section (line 370) is about a stand-in of another
kind, not about `extends`, so this RFC does not lean on it.

**Is this the evidence it waited for?** I counted it in the consumer that found the gap (the review harness,
GAPS.md "Item 22: a profile cannot be another profile with a few connections swapped", at wilanis `a88767b`):

- 20 hosts under `projects/` and the scaffold `templates/host` write a profile `review` and a profile `branch`.
  That is 21 `project.json` files. (The issue says 18 hosts; the tree now has 20.)
- In all 21, `branch` is `review` with two connections swapped: `history.connection.json` and
  `reports.connection.json`. Its 8 bindings are the same as `review`'s. Of its 30 permits, 28 are the same, and
  the other 2 are the two stand-ins in place of the two connections they replace.
- Each `branch` is 49 lines. With `extends`, each would be 8: a description, `extends`, and the two stand-ins.
  That is 41 lines per file and 861 lines in all, about 18% of the 4,739 lines of those 21 files.
- `npm run new-project` copies `templates/host`, so each new host starts with both copies. A new scanner plugin
  adds a permit to 42 profiles, not 21 (`scripts/check-stacks.mjs` already tells the author to edit "the
  permits").

This repository's own example has the case RFC 0013 described. In `example/project.json`,
`production-scheduler` and `production-worker` each copy `production`'s 3 bindings and 2 stand-ins, and their
descriptions say "production's bindings and connections" to explain the copy.

These are not "a few repeated lines". In the consumer the copy is most of the profile, it is made per host, and
every change to `review` is made twice per host.

**The checker does not catch every drift.** RFC 0013's reasoning assumes that a copy that drifts is refused. That
is true for two kinds of drift. A port that gains no binding in one copy is B002. A reach that one copy does not
permit is C021, and an entry one copy no longer reaches is C022. It is not true for a third kind. Change
`review`'s binding for `history.port.json` to another binding of the same port, and leave `branch` as it was:
both profiles are valid, `wilanis check` passes, and the branch review now runs a different graph from the
review it claims to copy. In the example, change `production`'s binding of `customer.port.json` and leave
`production-worker` as it is: the worker now writes customers through another binding than the routes, and
nothing refuses it. `checkProfileBinding` and `checkPortMet` in `check/profiles.ts` judge each profile alone, so
no rule can see that two profiles were meant to agree. Only the document can say it.

**What this RFC does not solve.**

- The copy across hosts. All 21 `review` profiles are the same (I compared their bindings and permits: one
  distinct set). Each host is its own tree, and an include leaves its profiles behind (`ProjectDoc.includes` in
  `packages/core/src/model.ts`: "configuring a tree is the host's job"). `extends` names a profile of the same
  `project.json` only.
- A connection chosen by a value a message carries (GAPS.md "Item 31: one tree cannot choose a host's connection
  by a value a message carries"). A profile is chosen once per process (RFC 0013), and this RFC keeps it so.
- Plugin settings per profile, the other half of Item 31. *Plugin settings per profile* under *Drawbacks and
  alternatives* says why this RFC leaves them out.

## Guide-level explanation

**The words.** A profile that names another under `extends` is a *child*, and the profile it names is its
*parent*. The *resolved* profile is what the child means: the parent's choices with the child's own written over
them. Every rule and every command reads the resolved profile. Only the parent is named; it is never copied.

**The consumer's `branch`, after this RFC.** `templates/host/project.json` keeps `review` as it is, and `branch`
becomes:

```json
"branch": {
  "description": "A review of one commit of a branch that is not the branch of record, kept apart from the history of record: review, with the history and the reports kept in connections of their own.",
  "extends": "review",
  "connections": {
    "@connections/history.connection.json": "@connections/branch-history.connection.json",
    "@connections/reports.connection.json": "@connections/branch-reports.connection.json"
  }
}
```

`branch` writes no `bindings`, so it has `review`'s 8. It writes no `permits`, so it has `review`'s 30. Two of
those name `history.connection.json` and `reports.connection.json`, which `branch` stands in for, so under
`branch` they permit `branch-history.connection.json` and `branch-reports.connection.json`. `branch` reaches
`history.connection.json` and `reports.connection.json` no other way, so those two entries permit nothing more.
That is the list `branch` writes by hand today, entry for entry.

**One connection reached two ways.** In the example, `production` stands `customers-postgres.connection.json` in
for `jobs.connection.json`, so the queue is a table in the customer database. The customer store also names
`customers-postgres.connection.json` directly. `production` permits it with one entry, which covers both ways. Say
a child stands its own broker, `jobs-staging.connection.json`, in for `jobs.connection.json`. Its queue now goes to
`jobs-staging`, but its store still goes to `customers-postgres`. So the inherited entry permits both: the stand-in
always, and `customers-postgres.connection.json` because the child still reaches it through the store. If the
entry were only rewritten to the stand-in, the child would be refused C021 for the store's connection, which its
parent permits and which nothing about the child changed.

**The example, after this RFC.** `production-scheduler` and `production-worker` extend `production`:

```json
"production-worker": {
  "description": "A process that works the removals queue beside production, started with `wilanis start example --profile production-worker`: production, with the consumer in place of the listener. It opens no port, so a slow removal never holds a route's instance; run as many of it as the queue needs.",
  "extends": "production",
  "permits": [
    "@storage/store.port.json",
    "@storage/storage.port.json#ensure",
    "@queue/queue.port.json#ensure",
    "@queue/worker.port.json#consume",
    "@auth/challenge.port.json#issue",
    "@otel/exporter.port.json#export",
    "@connections/customers-postgres.connection.json"
  ]
}
```

The worker writes its own `permits`. It must: it extends `production`, which writes `permits`, and a worker
reaches less than `production` (no listener, no route) and something `production` does not (the consumer). The
inherited list would be refused under the worker: C021 for `@queue/worker.port.json#consume`, which `production`
does not permit, and C022 for `@http/server.port.json#listen`, `@blob/csv.port.json`, `@auth/token.port.json` and
the other entries the worker never reaches. A list the worker writes replaces the inherited one whole. Today the
worker writes no `permits` and so permits everything. After this RFC, a child of a place that writes `permits` is
held to a list too, and the example shows it. (The list above is what `wilanis describe project.json example`
prints today as the worker's reach. The implementing pull request copies it from that command.)

**When the parent is wrong.** A child names a parent the project does not declare, or names itself, or names a
profile that extends another:

```
C0nn  project.json#profiles/production-worker/extends
    profile 'production-worker' extends 'production-scheduler', which extends 'production'; a profile extends one that extends nothing
    → extend 'production' directly and write what 'production-scheduler' changes, or remove extends from 'production-scheduler'
```

**When the inherited permits do not fit.** The child is judged on its resolved list, as any profile is. The
refusal says the list is inherited and how to replace it:

```
C022  project.json#profiles/production-worker/extends
    profile 'production-worker' inherits '@http/server.port.json#listen' from 'production', but nothing it reaches runs it
    → write profiles/production-worker/permits: a list it writes replaces production's whole
```

**Seeing it.** `wilanis describe project.json` prints the resolved profile. Its first line names the parent, and
a row the child inherits says where it came from:

```
profile branch  extends review  -- A review of one commit of a branch that is not the branch of record, ...
  binds      @review/domain/review.port.json  → @review/data/review.binding.json  (from review)
             ... the other 7 bindings, each (from review)
  stands in  @connections/history.connection.json  → @connections/branch-history.connection.json
             @connections/reports.connection.json  → @connections/branch-reports.connection.json
  reaches    ...
  permits    the operations and connections above, by review's 30 entries
  ...
```

The viewer's project page shows the same block, with the parent's name as a link to its block. The manifest's
block for `branch` holds the resolved bindings, stand-ins and permits, and `"extends": "review"`.

## Reference

### Documents and schemas

`project.schema.json`, under `profiles.<name>`:

```json
"extends": {
  "description": "The profile this one starts from: its bindings, stand-in connections and permits are this profile's too, except where this profile writes its own. A binding written here replaces the inherited one for that port; a stand-in written here replaces the inherited one for that connection; a permits list written here replaces the inherited list whole. An inherited permit naming a connection this profile stands in for permits the stand-in, and the connection itself wherever this profile still reaches it another way. default and description are not inherited. One level: the profile named extends no other (C0nn).",
  "type": "string",
  "pattern": "^[a-z][a-z0-9-]*$"
}
```

The profile's `"required": ["bindings"]` becomes `"anyOf": [{ "required": ["bindings"] }, { "required":
["extends"] }]`, so a child that only swaps connections need not write an empty `bindings`. `ProfileDoc` in
`packages/core/src/model.ts` gains `extends?: string`, and `bindings` becomes optional (readers write `?? {}`).

**Resolution.** A new module, `packages/core/src/profiles.ts`, exports `resolveProfile(profiles, name, canon)`.
It is pure and total, and answers a `ResolvedProfile`: the `ProfileDoc` the child means, plus `extends` and which
of its entries came from the parent. For a profile with no `extends`, it answers the profile as written. For a
child of parent P:

- `bindings`: P's, keyed by the canonical port path, with the child's written over them.
- `connections`: P's, keyed by the canonical connection path, with the child's written over them.
- `permits`: the child's own list where it writes one. Else P's list, where P writes one, entry for entry, each
  marked as inherited. An entry that names what P reaches for a connection A the child stands in for also carries
  the child's stand-in for A. "What P reaches for A" is P's stand-in for A, or A itself where P has none. Else no
  list (everything).
- `default` and `description`: the child's own only.

Core cannot say whether the child still reaches the entry's own connection: that is the reach, which the compiler
derives (`reachOf`). So core only marks the entry, and the checker reads it (*Checker rules*, C021 and C022).

Where `extends` is wrong, resolution still answers, and the checker refuses (C0nn): a parent the project does
not declare, or the profile itself, resolves as if there were no `extends`; a parent that extends another
resolves as the parent writes it, without following its own `extends`. So resolution never loops and never
follows more than one step.

`Scope` in `packages/core/src/scope.ts` gains `profile(name): ResolvedProfile | undefined`, computed once per
name. `bindingFor` (line 111) and `connectionFor` (line 128) read `this.profile(profile)` in place of
`this.project?.profiles?.[profile]`. `Scope.profiles()` still answers the declared names, so `profilesOf` and
`Judge.profiles()` are unchanged: a child is one more name, judged like any other.

`HOME` in `placement.ts`: no change. `packages/runtime/templates/CLAUDE.md`: the `project` row names `extends`,
and *Where a step runs* gains one sentence (under *Implementation plan*, step 4). `wilanis new`: no change.

### Ports, operations and kinds granted

None.

### Checker rules

Numbers are assigned when the implementing pull request lands (current highest: C023, B012).

| Code | Where it lives | Refuses when | Hint |
|---|---|---|---|
| C0nn | `checkExtends` in `check/profiles.ts` | `extends` names a profile the project does not declare, or the profile itself | `name another declared profile: <list>` |
| C0nn (same code) | `checkExtends` | `extends` names a profile that itself extends another | `extend '<grandparent>' directly and write what '<parent>' changes, or remove extends from '<parent>'` |

What changes in the existing rules:

- **Judged where written: R001, B003, B004 (a profile's bindings) and R001, C018 (its stand-ins).**
  `checkProfileChoices` keeps judging each profile's written entries, once, at the line that writes them. An
  inherited entry was judged under the parent; judging it again under the child would refuse one line twice.
- **Judged on the resolved profile: B002, B011.** Both read `bindingFor`, which now reads the resolved profile.
  No change to either function.
- **Judged on the resolved list: C021, C022.** `checkProject` (`check/project.ts`, line 35) hands
  `checkPermits` the resolved profile from `Scope.profile(name)`, not the written one. An inherited entry that
  carries a stand-in permits two connections: the stand-in, always, and the connection it names, wherever the
  child's reach (`reach.connections`) holds that connection. C021 reads it so. C022 refuses it only where the child
  reaches neither, so an entry is never wider than the child's tree, as RFC 0016 asks. Where the list is
  inherited, a refusal is made at `profiles/<child>/extends`, since the child writes no `permits` to point at,
  and its message says `inherits '<entry>' from '<parent>'` (C022) or `(permits inherited from '<parent>')`
  (C021). The hint adds: `write profiles/<child>/permits: a list it writes replaces <parent>'s whole`.
- **Judged once, under the parent: R001 and C023 for an inherited entry.** Whether an entry names anything (R001),
  and whether it is a permit at all -- not a domain port, its operation, a pure operation or a port with nothing
  effectful (C023) -- is a fact about the entry, not about the profile. `checkPermits` refuses it under the parent,
  at the parent's line, `profiles/<parent>/permits/<index>`, as today. Under the child, `readPermit` reads such an
  inherited entry as permitting nothing and refuses nothing, so one bad line is refused once. The one C023 that
  depends on the profile, "a connection the profile replaces", cannot reach an inherited entry: where the parent
  replaces a connection, its own C023 keeps that connection out of its list, and where the child replaces one, the
  entry carries the stand-in. An entry the child writes itself is judged under the child for all three, as today.
- **Unchanged: C017.** `default` is not inherited, so the rule reads each profile as written.
- **Unchanged: B012.** A startup step names profiles by name. A step that names `production` does not run under
  `production-worker`. It must not: in the example, `Listen` names `production`, and the worker must not listen.
  Which steps a child runs stays on the step, as RFC 0013 decided ("`profiles` on a step rather than a startup
  list per profile").
- **Unchanged: C019** (every secret is read), which reads every connection, not a profile.

### Runtime behaviour

None of its own. `reachOf` (`packages/compiler/src/reach.ts`), `buildEnv` (`packages/compiler/src/env.ts`), the
compiler's lowering, `migrate`, `map`, and the storage and queue plugins' rules all reach a profile's choices
through `bindingFor` and `connectionFor`, so under a child they read the resolved profile with no change of their
own. Outside `scope.ts`, the only readers of a profile's `bindings`, `connections` or `permits` in
`packages/*/src` are `check/profiles.ts`, `check/permits.ts`, `profiles-said.ts` and `manifest-profiles.ts`, and
this RFC says what each reads. `activeProfile` (`packages/runtime/src/profile.ts`) reads names and `default` only, and is unchanged: a start under `branch` is a
start under `branch`. A plugin never learns that a profile extends another, as it never learns which profile is
active (RFC 0013, *Plugin contract*).

### Discoverability

- **`wilanis describe project.json`.** `ProfileReach` in `packages/runtime/src/profiles-said.ts` gains
  `extends?: string` and marks each `binds` and `standsIn` row it inherits. `profileOf` (line 58) reads
  `scope.profile(name)` in place of the written profile, so `binds`, `stands in` and `permits` are the resolved
  ones, `permits` read as the manifest reads them (below). `profileHeading` prints `extends <parent>` after the
  name. A row the child inherits ends with
  `(from <parent>)`, and `permitsSaid` says `by <parent>'s N entries` where the list is inherited. The exact
  wording is left to implementation, as RFC 0013 left its own.
- **`wilanis describe <connection>`.** `standInsOf` (line 116) and `permittedLines` (line 229) read the resolved
  profiles, so `replaced by branch-history.connection.json under branch` and `permitted by review, branch` are
  said for an inherited stand-in or permit too.
- **The manifest.** `ProfileBlock` in `packages/runtime/src/manifest-profiles.ts` gains `extends: string | null`.
  `profileBlock` (line 91) reads `scope.profile(name)`, so `bindings`, `connections` and `permits` are resolved.
  For an inherited list, `permits` holds what the entries permit under the child, as the checker reads them: an
  entry that carries a stand-in gives the stand-in, and its own connection where the child's reach holds it.
  `profileBlock` already calls `reachOf` for the same profile, so it reads both from one walk.
  This is what RFC 0013 meant by "the manifest prints resolved anyway", and what `wilanis-deploy` needs, since it
  plans one place from that place's block (`plan.ts`). In `manifest.schema.json`, the profile block gains `extends`
  (`["string", "null"]`, required, as every key there is), and the descriptions of `bindings`, `connections` and
  `permits` say "resolved: what the profile writes over what it extends". `format` stays 1 (RFC 0026: "a row's
  keys are added and never removed").
- **The viewer.** `profilesEl` in `packages/view/client/index.html` shows `extends <parent>` beside the heading,
  as a link to the parent's block, and marks inherited rows. It reads `profilesOf`, as today.
- **`wilanis map`, `wilanis ls`:** unchanged.

### Plugin contract

None. `PluginModule`, `PluginCheckContext` and `PostLoadContext` do not change. A plugin's `check` that reads
`scope.connectionFor` reads the resolved profile with no change of its own.

## Compatibility

`project.schema.json` gains one optional key, and `bindings` stays required wherever `extends` is absent. Every
`project.json` written before this RFC validates and keeps its meaning: a profile without `extends` resolves to
itself, field for field. The manifest gains one key in a profile block and keeps `format` 1. A tree that does not
use `extends` gets the same manifest but for `"extends": null` in each block, so `manifest.golden.json` changes
by those lines.

The change is under `packages/core/schemas/`, so the implementing pull request waits for the maintainer's
approval in the `decision` job. It is compatible, so it may land before or after the `schemas-v1` freeze (RFC
0008). IR v1 is unaffected: no lowered form carries a profile.

## Tests

**Resolution**, in a new `packages/core/test/profiles.test.ts` (tests live beside what they test):

- a child with no `bindings` has the parent's; a child binding for one port replaces that one and keeps the rest;
  keys written through two aliases of one port meet as one;
- a child stand-in for a connection replaces the parent's stand-in for it;
- a child with no `permits` has the parent's, each entry marked inherited, and the entry for a connection it
  stands in for carrying its stand-in, both where the parent named the connection and where the parent named its
  own stand-in for it;
- a child that writes `permits` has exactly its own;
- `default` and `description` are never inherited;
- a parent that is not declared, that is the child, or that extends another: resolution answers, follows at most
  one step, and does not loop.

**Validation**, in `packages/core/test/validate.test.ts`: a profile with `extends` and no `bindings` validates; a
profile with neither is refused by the schema.

**Sabotage**, in `packages/runtime/test/sabotage-profiles.test.ts` and `sabotage-permits.test.ts`, against the
example after step 4, where `production-scheduler` and `production-worker` extend `production`:

- `production-worker` extends `staging`, which is not declared → C0nn; extends `production-worker` → C0nn;
- `production-worker` extends `production-scheduler`, which extends `production` → C0nn, at
  `profiles/production-worker/extends`;
- remove `production-worker`'s `permits` → C021 for `@queue/worker.port.json#consume`, and C022 for
  `@http/server.port.json#listen` among others, each at `profiles/production-worker/extends` and naming
  `production`;
- change `production`'s binding of `customer.port.json` to the store binding → `reachOf` under
  `production-worker` follows the store binding, with no edit under `production-worker` (the drift a copy would
  have kept);
- give `production-worker` `"connections": { "@connections/employees.connection.json":
  "@connections/employees.connection.json" }` → C018 (a child cannot drop an inherited stand-in by mapping the
  connection to itself), once, at the child's line;
- plant `employees-staging.connection.json`, of the employees' kind, and a profile `production-staging` that
  extends `production` and stands it in for `employees.connection.json` → no refusal; the entry for
  `employees-production.connection.json` permits `employees-staging.connection.json`, and nothing more, since the
  child reaches `employees-production` no other way;
- **a shared target:** plant `jobs-staging.connection.json`, of the kind `jobs.connection.json` is
  (`@queue-memory/memory.connection-kind.json`), and a profile `production-staging` that extends `production` and
  stands it in for `jobs.connection.json` → no refusal: the inherited `customers-postgres.connection.json` entry
  permits `jobs-staging`, which the queue reaches, and `customers-postgres`, which the store still reaches. Then
  bind `customer.port.json` and `@auth/state.port.json` under `production-staging` to bindings that do not reach
  `customers-postgres` → no C022, and `describe` shows the entry permitting `jobs-staging` alone;
- **an entry reached neither way:** remove `production-scheduler`'s own `permits`, so it inherits `production`'s,
  and stand `employees-staging.connection.json` in for `employees.connection.json` under it → C022 for the
  `employees-production.connection.json` entry, at `profiles/production-scheduler/extends`, since the scheduler
  reaches neither that connection nor its stand-in (it verifies no one);
- break an entry of `production`'s `permits` (`@connections/nowhere.connection.json`, then
  `@customers/domain/customer.port.json`) → R001, then C023, once each, at `profiles/production/permits/<index>`,
  and nothing under `production-worker`, after its own `permits` is removed so that it inherits the list.

**Discoverability**, in `describe-profiles.test.ts`, `describe-permits.test.ts`, `manifest-profiles.test.ts` and
`manifest.golden.json`: the heading names the parent; inherited rows are marked; the manifest's block for
`production-worker` holds `"extends": "production"` and `production`'s bindings and stand-ins.

## Implementation plan

1. **Core.** The schema key and the `anyOf`; `ProfileDoc`; `resolveProfile` in `packages/core/src/profiles.ts`;
   `Scope.profile`; `bindingFor` and `connectionFor` read it; the resolution and validation tests. Waits on the
   `decision` job. (`area:core`)
2. **The checker.** `checkExtends` (C0nn); `checkPermits` on the resolved profile: an inherited entry that carries
   a stand-in read as the stand-in and, where still reached, its own connection; R001 and C023 for an inherited
   entry left to the parent; the messages, `at` path and hint for an inherited list; the sabotage tests on a
   planted child, the shared target among them. (`area:compiler`)
3. **Saying it.** `profiles-said.ts` (`extends`, inherited rows, `standInsOf`, `permittedLines`),
   `manifest-profiles.ts` and `manifest.schema.json`, the golden manifest, the viewer's `profilesEl`, and their
   tests. (`area:runtime`, `area:view`)
4. **The example and the words.** `production-scheduler` and `production-worker` extend `production` and write
   their own `permits`; the sabotage tests move onto them. `packages/runtime/templates/CLAUDE.md`: the `project`
   row names `extends`, and *Where a step runs* says: "A profile that is another with a few choices changed names
   it under `extends` and writes only what changes: its bindings and stand-ins replace the parent's one by one,
   and a `permits` it writes replaces the parent's whole. A step that names the parent does not run under the
   child; name both." `docs/model.md`, the profiles paragraph, says the same. (`area:runtime`; `good first issue`
   once steps 1-3 have landed)

Steps 2 and 3 need step 1 and may land in either order. Step 4 needs steps 2 and 3.

**Order with RFC 0037.** RFC 0037 (draft, "A connection is a literal at the call") also changes what C021 and C022
read: a call may reach several connections (`ReachedNative.connections` in place of `connection`), and a connection
may have parts, each reached and each replaced by a stand-in. It also takes new C codes. I recommend this RFC lands
first, for three reasons.

- It is the smaller change: four pull requests, against RFC 0037's five, and none of them edits `reach.ts`, which
  RFC 0037 rewrites (its walks follow graph instances).
- The two meet in few places. This RFC adds `Scope.profile`; RFC 0037 adds `Scope.graphs` and `Scope.boundGraph`.
  In `check/permits.ts`, this RFC changes which profile is read and where an inherited refusal points; RFC 0037
  changes how many connections a site carries and what a message adds (`(given by ...)`, `(a part of ...)`). So
  RFC 0037's step 1 rebases over a few lines of messages and an `at` path, and changes no rule of this one.
- Neither rule depends on the other. Whether a child "still reaches" a connection is read off `reach.connections`,
  whatever fills it. Under RFC 0037 a part the child stands in for is a connection like any other, and one
  connection reached two ways becomes more common (a call naming two), which is why the shared-target test above
  stays in the suite.

If RFC 0037 lands first instead, step 2 of this RFC reads `site.connections` where it would read
`site.connection`, and nothing else changes. Codes: both RFCs write theirs as `C0nn`. Whichever implementation
lands first takes the next free C code (C024 on `main` today), and the other takes the code after it.

## Drawbacks and alternatives

- **The indirection RFC 0013 named is real.** A reader of `branch` must open `review` to know what `branch`
  binds. Three things keep the cost down. There is one level, so the reader opens one more profile and never a
  chain. `describe`, the manifest and the viewer print the resolved profile, and mark what is inherited. And the
  parent is in the same file. The other cost is that a diff to `review` changes `branch` with no line under
  `branch` in the diff. RFC 0016 says "the diff under the word `production` is the review". After this RFC, the
  diff under the parent is also the review of its children, and `extends` is the line that says so. The checker
  still holds each child to its own reach, both ways.
- **Chains.** Letting a parent extend another would let a tree build a ladder (`base` → `production` →
  `production-worker`). Neither the consumer nor the example needs one, and each step would be one more profile a
  reader opens. A refusal can be relaxed later with no tree breaking. A chain allowed now could not be refused
  later. So the RFC refuses chains.
- **Permits, inherited whole and replaced whole.** Four ways were weighed.
  - *Not inherited* (the child writes its own or permits everything). This would make a child of a guarded place
    unguarded by leaving a line out, which RFC 0016 exists to prevent. Requiring the child to write its own would
    leave the consumer's 30 permit lines in each `branch`, which is most of the copy this RFC removes.
  - *Merged* (the parent's entries and the child's together). The child could not remove an entry. The worker
    would then inherit `listen`, which it does not reach, and C022 would refuse it with no fix but to stop
    extending.
  - *Merged, with C022 not judging inherited entries.* RFC 0016 rejected a list wider than the tree: "a list
    that may be wider than the tree tells a reviewer what the tree *might* do, not what it does."
  - *Inherited whole, replaced whole* (this RFC). A child that reaches what its parent reaches, up to its
    stand-ins, writes nothing. A child that reaches something else writes its own list, which the checker holds
    to the child's reach as strictly as any other. It never mixes the two.
- **An inherited permit that also permits the stand-in.** A permit names what a place may reach, and C023 already
  says "a replaced connection is named by its stand-in". The child's `connections` entry is a line a reviewer reads
  under the child's name. So letting the parent's permit for the replaced connection permit the stand-in says
  nothing the child's own line does not say. Three other readings were weighed.
  - *Rewrite the entry to the stand-in.* This fails where one connection is reached two ways, as the example's
    customer database is (by the store, and as the stand-in for `jobs`): the child gets C021 for a connection its
    parent permits and which nothing about the child changed.
  - *Keep the entry and add the stand-in as a second entry, each judged alone.* The kept entry is dead in the
    consumer's `branch`, which reaches `history.connection.json` no other way, so C022 refuses every `branch`.
  - *Drop the entry and make the child add the stand-in* to a list it otherwise does not write. That conflicts with
    "replaced whole": the child would write a list of two and lose the other 28.

  The rule taken -- the stand-in always, the named connection where the child still reaches it -- passes both the
  consumer's case and the shared target, and C022 still refuses an entry the child reaches neither way. The cost
  is that what a child's inherited list permits depends on the child's reach, not on the documents alone. The
  manifest already prints the reach beside the list, so it reads both from one `reachOf`.
- **A child cannot remove an inherited stand-in or binding.** Mapping a connection to itself is C018, and a child
  has no way to say "no binding here". Neither the consumer nor the example needs to remove one. A profile that
  must drop one writes its choices out without `extends`.
- **A startup step naming the parent does not run under the child.** This keeps B012's meaning and the example's
  `Listen`. The cost is that a step must name each child it runs under.
- **Do nothing; teach the workaround.** The template would say: "Two profiles that differ in a few connections
  each list every binding and permit; there is no `extends`; `wilanis check` refuses the copy that misses one
  (B002, C021)." That keeps 861 copied lines in the consumer and two copies in the example. It also leaves the
  drift no rule sees: a binding changed in one copy and not the other. That is why this RFC does not recommend it.
- **A script writes the copy** (the consumer's `templates/host` and `npm run new-project` already copy files).
  This is code outside the tree that knows a relationship the tree does not say, and a later edit to `review` by
  hand still needs the script run again. The checker cannot hold it.
- **A named set of bindings** that several profiles name. That would be a new place in `project.json` and a new
  thing to read, where `extends` reuses the profile a reader already knows.
- **Plugin settings per profile.** This is the other half of GAPS.md "Item 31: one tree cannot choose a host's
  connection by a value a message carries". `project.schema.json` keeps plugin settings in
  `plugins[].settings`, one object per plugin per tree. The consumer's `@guidance` settings (`runsIn`,
  `runsInByPath`, `buildOnly`, `nodeOnly`) differ from host to host. I recommend this RFC leaves them out:
  - The case this RFC serves does not need them. In all 21 files, `review` and `branch` sit in one `project.json`
    and run with the same settings.
  - The case that would need them is one tree with a profile per host. That is still one process per host, since
    a profile is chosen once per process. Item 31 asks for one process for every host, with the host chosen by a
    message. Settings per profile would not give that.
  - They are a larger change than `extends`. Today one settings object per plugin is read by C001 and C002
    (`checkPluginSettings`), C019, L017 and L018 (`listen-settings.ts`), `reachOf`'s secrets (`reach.ts`, line
    379), `buildEnv` (`env.ts`, line 88), every plugin's `check` (`PluginCheckContext.settings`), `postLoad`,
    the guard (`GuardArgs.settings`), each trigger kind's `start`, `limits-said.ts` and `manifest-listens.ts`.
    Settings per profile would make each of those a judgement per profile, and would run every plugin's `check`
    once per profile. That changes the plugin contract.
  - RFC 0013 already chose, for a connection's settings, a whole stand-in document over settings per profile
    ("Stand-in connections rather than settings per profile on the connection"). The same answer serves a plugin
    value that differs by place, where the value can live in a connection document that a profile stands in for
    another. The consumer's own Item 31 design moves the per-host values into connection documents in this way.

  If the maintainer wants settings per profile, it is its own RFC. `extends` would not stand in its way: an
  inherited `settings` map would resolve in `resolveProfile` like `bindings` do.

## Open questions

**Settled in review.** The maintainer accepted these recommendations on the pull request:

- `extends` is taken. The consumer copies 41 of 49 lines per file in 21 files, the example copies `production`
  twice, and a changed binding in one copy is drift no rule sees. RFC 0013's reason was "a few repeated lines",
  and that is no longer true.
- One level, no chains. It can be relaxed later; chains could not be taken back.
- Permits are inherited whole and replaced whole when written. The reading of an inherited entry for a replaced
  connection (the stand-in always, the connection where the child still reaches it) and where R001 and C023 fire
  for an inherited entry were written in answer to the review.
- The example is migrated: `production-scheduler` and `production-worker` extend `production` and write their own
  `permits`.
- Plugin settings stay one per tree, not per profile.

**Still to decide before `accepted`:**

- **The key's name.** `extends` is the word `tsconfig.json` and most configuration formats use. `from` is
  already taken in `project.json` by `plugins[].from` and `includes[].from`, which name an npm package.
- **The milestone.** I recommend M14 1.0: the RFC lands before the `schemas-v1` freeze. The roadmap cuts 1.0 only
  when every accepted RFC that changes a schema has landed, with no exception for a compatible change, and putting
  this RFC under *Unscheduled* would need one. The work is small (four pull requests, none in the engine or a
  plugin), and a consumer copies profiles today. *Unscheduled* would fit only if 1.0 were ready before step 1
  could land; the change is compatible, so it could then land after the freeze, in place (RFC 0008). The
  maintainer decides at acceptance.
- **The order with RFC 0037.** I recommend this RFC lands first (*Order with RFC 0037*, under *Implementation
  plan*). Neither changes a rule of the other, so the other order costs one rebase, not a redesign.

Left to implementation: the exact wording of `describe` and of the viewer's marks; whether
`ResolvedProfile` marks inherited entries per entry or per list.
