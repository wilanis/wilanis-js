# RFC 0042: `keptBy`: a store says another tree keeps its collections

- **Status:** implemented
- **Areas:** `area:core` (one optional property on `store.schema.json`, `StoreDoc`), `area:plugin-storage` (the
  planner's gathering, three `X` rules), `area:runtime` (`describe`, the template), `area:view` (the store page)
- **Tracking issue:** #851
- **Depends on:** RFC 0017 (implemented: the planner, the record, `wilanis migrate`). RFC 0002 (implemented: a
  collection is the pair of its connection and its name). RFC 0037 (draft, #931) touches the same walk: whichever
  lands second follows the other (*Implementation plan*).

## Summary

A store may say that another tree keeps its collections: `"keptBy": "platform-runtime"`, the `project.json → name`
of the tree that writes the records and runs `wilanis migrate` over them. The tree that declares the mark only
reads. After this RFC, `wilanis migrate` skips a connection whose stores all say `keptBy`. It prints one line that
names the keeping tree. It opens nothing on that connection, so it plans no `drop` of the other tree's collections
and no `remove` of the fields a partial shape leaves out. Three `X` rules hold the promise from the other side. No
graph and no startup step writes through such a store (`put`, `patch`, `remove`, `newKey`, `ensure`). Every store
over one connection says the same `keptBy`, or none says it. And `keptBy` never names the tree itself. The schema
also refuses `renamed`, `was` and `defaults` on a kept store's collections, since those marks only instruct a
migration.

## Motivation

A consumer tree reads collections that other trees write and migrate. `projects/adr` in the consumer's repository
has 40 stores, and `projects/platform-system` has 6. Each one reads the history of one member tree: a few
collections of `libraries/review/features/review/data/history.store.json`, each with only the fields the reader
needs. The reader's connection reaches the same PostgreSQL schema as the owner's (for example
`projects/adr/connections/runtime-history.connection.json` and
`projects/platform-runtime/connections/history.connection.json` both name schema `platform_runtime`). The consumer's
GAPS.md records the gap as "M9 (written at the update to 296b744): a store cannot say it reads collections another
tree owns". Its workaround: every one of the 46 stores says in its `description` "Never migrate it from here", and
PLAN.md says "Never apply `wilanis migrate` to `projects/platform-system` or `projects/adr`".

What goes wrong without the workaround is in the planner's code:

- **The record is per database, not per tree.** The postgres engine keeps `wilanis_migrations` in the
  connection's schema (`table(schema)` in `packages/plugin-storage-postgres/src/record.ts`). A reader's connection
  that reaches the owner's schema reads the owner's record.
- **The planner asks the record about every collection it ever saw.** `everKnown` in
  `packages/plugin-storage/src/standing.ts` adds every target of every applied plan to the names it plans.
- **It drops what the tree does not declare.** `plan` in `packages/plugin-storage/src/plan.ts` (lines 262-264)
  pushes a `drop` for every recorded collection that is not declared and not claimed by a `was`.
- **It removes what a partial shape leaves out.** `removeSteps` in `packages/plugin-storage/src/plan-steps.ts`
  pushes a `remove` for every recorded field the declared shape lacks. A recorded `unique` or `refs` the reader
  does not repeat becomes `ununique` or `unref` (`plan-constraints.ts`), and a field the reader declares optional
  where the owner requires it becomes `relax`.
- **Some of those steps need no flag.** `classOf` in `plan-class.ts` makes `relax`, `ununique` and `unref` always
  transformative, and a `remove` of a column no row fills is transformative too (`byCount`). Transformative steps
  apply under `--apply` alone. A connection with no destructive step left would apply them to the owner's tables.
- **A dry run writes.** The postgres engine's `recorded` and `history` call `ensureRecord` first
  (`engine.ts` lines 319-375), which runs `create schema if not exists` and `create table if not exists
  wilanis_migrations` against the owner's database.
- **`ensure` fails the same way.** `ensureStore` in `packages/plugin-storage/src/ensure.ts` plans the store's
  declared collections against the record. A partial shape plans `remove` steps, which are not additive, so a
  startup step that prepares a reading store stops the start with `drift`. Where the owner has not created a
  collection yet, it creates one with the reader's partial shape and records it as the reader's.
- **Nothing stops a write.** A reading tree can `put` into the owner's collection with its partial shape. No rule
  sees that the records are another tree's. X213 says a feature never names another feature's store; nothing says
  a tree never writes another tree's collections.

The owner's shape lives in another tree, which the reader does not load. Even if the reader copied it, a partial
shape is the right design: the engines already read only the fields a shape names (`columns` in
`packages/plugin-storage-postgres/src/engine.ts`: "every field the shape has, and nothing the table may also
hold"; `columnsOf` in the sqlite engine).

Earlier RFCs did not consider two trees on one database. RFC 0002 says "one database per tree is the normal case",
and RFC 0017 says "Every store of the tree is planned; a profile does not filter them, because a store's connection
is the document's and not the profile's". RFC 0017 also put a `tree` column in the record ("`tree` (text:
`project.json → name`)"), but the planner never reads it; only `--history` prints it. The consumer's 46 stores
are the new evidence: reading another tree's records is not rare, and the only guard today is a sentence in a
description.

What this RFC does not do. It does not make two connection documents that reach one database known as one; a tree
cannot see that, and this RFC does not try. It does not check that a reader's partial shape matches the owner's
record (*Open questions*, second). It does not give a reader a read-only database role; that is the operator's.
It does not touch M9's other gap, one copy of each document per member tree, which is #849. It changes nothing in
`plan()`: the planner stays pure and plans what it is given.

## Guide-level explanation

**A kept store** is a store whose collections another tree keeps. "Keeps" means writes the records and runs
`wilanis migrate` over them. The tree that declares a kept store only reads it. The mark is one property on the
store, `keptBy`, and its value is the keeping tree's `project.json → name`.

Take the example as the keeping tree. Its `project.json` says `"name": "customers"`, and under `production` its
customers live in `@connections/customers-postgres.connection.json`. Now a second tree, `billing`, addresses invoices
and needs each customer's name and address, nothing else. It has a connection of its own to the same database:

```json
{
  "$schema": "@wilanis/connection.schema.json",
  "description": "The customers tree's database, read: the same database as that tree's customers-postgres connection, which it migrates.",
  "kind": "@storage-postgres/postgres.connection-kind.json",
  "settings": { "url": "{{secrets.customersDatabase}}" }
}
```

a shape with three of the seven fields of `@customers/domain/Customer.shape.json`:

```json
{
  "$schema": "@wilanis/shape.schema.json",
  "description": "Who an invoice is addressed to: the three fields of a customer an invoice prints.",
  "fields": {
    "id": { "type": "string", "description": "the customer's id, as the customers tree keys them" },
    "name": { "type": "string", "description": "the name the invoice is addressed to" },
    "email": { "type": "string", "description": "where the invoice is sent" }
  }
}
```

and a store that says who keeps the collection:

```json
{
  "$schema": "@wilanis/store.schema.json",
  "label": "Customers, read",
  "description": "The customers an invoice is addressed to. The customers tree writes them and migrates their table; this tree reads three fields.",
  "keptBy": "customers",
  "connection": "@connections/customers.connection.json",
  "collections": {
    "customers": {
      "description": "one row per customer, as the customers tree keeps them",
      "of": "@invoices/domain/Payer.shape.json",
      "key": "id"
    }
  }
}
```

A data graph of `billing` reads it with `#get`, `#find` and `#count` as it reads any store.

**What `wilanis migrate billing` prints today**, against the production database after the customers tree has
migrated it:

```
$ wilanis migrate billing --profile production
profile production
plan for @connections/customers.connection.json  (@storage-postgres/postgres.connection-kind.json, granted by @storage-postgres)
  customers
    remove   remove tier                                 destructive     ✗ needs --allow-destructive @connections/customers.connection.json/customers
      loses values of tier in every row that holds one
    remove   remove registrar                            destructive     ✗ needs --allow-destructive @connections/customers.connection.json/customers
      loses values of registrar in every row that holds one
    remove   remove active                               destructive     ✗ needs --allow-destructive @connections/customers.connection.json/customers
      loses values of active in every row that holds one
    remove   remove note                                 destructive     ✗ needs --allow-destructive @connections/customers.connection.json/customers
      loses values of note in every row that holds one
    ununique ununique [email]                            transformative
  latest
    drop     drop collection latest                      destructive     ✗ needs --allow-destructive @connections/customers.connection.json/latest
      loses every row of latest
  sessions
    drop     drop collection sessions                    destructive     ✗ needs --allow-destructive @connections/customers.connection.json/sessions
      loses every row of sessions
  challenges
    drop     drop collection challenges                  destructive     ✗ needs --allow-destructive @connections/customers.connection.json/challenges
      loses every row of challenges

1 steps would apply; 7 refused. Nothing was applied: run again with --apply.
```

It exits 1 on every run. The `customers` table loses four columns and its `unique` if an operator allows them. The
three other tables belong to the customers tree's other stores on that connection, and `billing` has never named
them. (A column no row fills is counted as transformative, so a `remove` of an empty `note` would apply under
`--apply` alone.)

**What it prints after this RFC:**

```
$ wilanis migrate billing --profile production
profile production
plan for @connections/customers.connection.json  (@storage-postgres/postgres.connection-kind.json, granted by @storage-postgres)
  skipped: kept by customers (keptBy in @invoices/data/customers.store.json); this tree reads it and never migrates it

nothing to apply
```

It exits 0, as a skipped connection does today (`report` in `packages/runtime/src/migrate.ts`). It opened no
connection to print this. A tree with kept stores and stores of its own prints the line for each kept connection
and plans the others as before. `wilanis migrate billing --history` leaves the kept connection out; the keeping
tree's `--history` prints it.

**What the checker refuses.** A write through a kept store:

```
X2n1  features/invoices/data/mark-paid.graph.json  nodes/marked/in
      this patches customers of @invoices/data/customers.store.json, which the customers tree keeps (keptBy)
      hint: a kept store is read only: ask the customers tree for the change through a port it exposes, or remove keptBy if this tree keeps the collection
```

and the migration marks on a kept store, by schema validation:

```
D001  features/invoices/data/customers.store.json  collections/customers/renamed
      'renamed' is not allowed here
      hint: see https://raw.githubusercontent.com/wilanis/wilanis-js/main/packages/core/schemas/store.schema.json
```

The schema's description of `keptBy` says why, so `wilanis describe` and the hint's link both explain it.

The reader still needs the keeping tree to have migrated first. A collection the keeping tree has not created
fails the reader's first read with the engine's error, as a missing table does today. That is right: only the
keeping tree may create it.

**A development database.** This holds in development too. X2n1 refuses `ensure` on a kept store, and `migrate`
skips the connection under every profile, because the mark is on the store and not on the connection a profile
chooses. So nothing in the reading tree creates a kept collection in a local database, for example a sqlite file
that a `dev` profile stands in for the production connection. A developer gets one of two ways:

- **The keeping tree's `migrate`.** Point a connection of the keeping tree at the same local database and run
  `wilanis migrate <keeping tree> --profile <its dev profile> --apply`. The keeping tree creates its collections
  with its full shapes and records them under its own name, as it does in production.
- **A fixture.** Copy a database the keeping tree has already migrated, for example a sqlite file kept as a test
  fixture, and point the reader's connection at the copy.

`rehearse`, `fuzz` and `regress` need neither, because a storage operation is stubbed there and reaches no
database.

## Reference

### Documents and schemas

**`store.schema.json`** gains one optional top-level property:

- `keptBy` (string, `"pattern": "^[a-z][a-z0-9-]*$"`, the pattern of `project.json → name`): "The tree that keeps
  these collections, by its project.json → name. That tree writes the records and runs wilanis migrate over them;
  this tree only reads them. wilanis migrate never plans a connection whose stores say keptBy, and no graph or
  startup step of this tree writes through this store (X2n1). A collection may name a shape with fewer fields than
  the keeping tree's: an engine reads only the fields a shape names. Every store over one connection says the same
  keptBy, or none says it (X2n2)."

and one root-level conditional, so a kept store carries no instruction to a migration that never runs:

```json
"if": { "required": ["keptBy"] },
"then": {
  "properties": {
    "collections": {
      "additionalProperties": { "properties": { "renamed": false, "was": false, "defaults": false } }
    }
  }
}
```

`unique`, `refs`, `scoped` and `view` stay allowed. They describe the records and change what a read does
(`scoped` filters by a column the keeping tree writes), and none of them instructs a migration.

`StoreDoc` in `packages/core/src/model.ts` gains `keptBy?: string`, with the one-line comment "the tree that writes
and migrates these collections, by its project.json → name; this tree only reads them". No new kind, no placement
change: a store lives in `data/` (`HOME.store`).

The row in `packages/runtime/templates/CLAUDE.md` gains one clause: "...; `keptBy` names the tree that keeps the
collections when this one only reads them, so `wilanis migrate` never plans them and no graph writes them". `wilanis
new store` is unchanged.

The baseline in `packages/core/test/store.test.ts` gains a store with `keptBy`. `"keptBy": "Platform Runtime"` is
refused by the pattern, and `keptBy` beside a collection's `renamed` is refused by the conditional.

### Ports, operations and kinds granted

None. `@storage/storage.port.json#ensure` keeps its contract; X2n1 keeps it from being reached for a kept store.

### Checker rules

All three are `@storage`'s own (`X`), in a new module `packages/plugin-storage/src/kept.ts`, called from the
plugin's `check` beside `rules.ts`. What a store write is and which store a call names are already read there
(`operationOf` and `Call` in `calls.ts`; *Implementation plan* says how this meets RFC 0037's change to that
walk). The profiles are read through `scope.profiles()` and `scope.connectionFor` (`packages/core/src/scope.ts`);
X212 already walks `scope.profiles()` the same way. Codes are placeholders; the implementing pull request takes
the next free numbers in the family. X2n1, X2n2 and X2n3 landed as X215, X216 and X217.

| Code | Where it lives | Refuses when | Hint |
|---|---|---|---|
| X2n1 | `kept.ts`, at the call's `at` (`nodes/<id>/in` in a graph, `operations/<name>/in` in a binding, as `calls.ts` writes them) | a call of `@storage/store.port.json#put`, `#patch`, `#remove` or `#newKey`, or of `@storage/storage.port.json#ensure`, names a store that says `keptBy` | `a kept store is read only: ask the <keptBy> tree for the change through a port it exposes, or remove keptBy if this tree keeps the collection` |
| X2n2 | `kept.ts`, at `keptBy` of the store that disagrees (at `connection` where it says none) | two stores reach one connection, under the unnamed profile or any declared one, and they do not say the same `keptBy`: one says it and one does not, or they name two trees | `one tree migrates a connection: give every store over <connection> the same keptBy, or move this store to a connection of its own` |
| X2n3 | `kept.ts`, at `keptBy` | `keptBy` is this tree's own `project.json → name` | `keptBy names another tree; this tree keeps its own stores, so remove keptBy` |

X2n2 judges the connection each store reaches under each profile, since that is the connection the planner
gathers by (`gathered` in `migrate-stores.ts` groups by the reached path, `conn.path` in `store.ts`). So a tree
the checker accepts never brings a connection with kept and unkept stores to the planner.

X2n3 is refused, not left to review. A tree that names itself in `keptBy` would never migrate its own store, and
nothing would say so: `migrate` would print a skip and exit 0, and the first sign would be a missing table at run
time. The rule compares `keptBy` with `scope.project`'s `name`, which is the name `treeOf` in
`packages/plugin-storage/src/record.ts` writes into the record. So the rule and the record agree on what "this
tree" is.

What is not added. A read (`#get`, `#find`, `#count`) through a kept store is allowed; it is the point. `#newKey`
is refused with the writes: a key is made to write a record, and the sqlite engine reserves one by writing
`wilanis_keys` (`packages/plugin-storage-sqlite/src/keys.ts`). A partial shape is not judged against the keeping
tree's shape: that shape is in another tree, and the checker reads one tree.

### Runtime behaviour

**`wilanis migrate`.** `Gathered` in `packages/plugin-storage/src/migrate-stores.ts` gains `keptBy?: { tree:
string; store: string }`, filled from the first store gathered over the connection (X2n2 makes every store over it
say the same). `planStores` in `packages/plugin-storage/src/migrate.ts` checks it before it reaches an engine:

```ts
if (one.keptBy) {
  targets.push(unplanned(one, { skipped: `kept by ${one.keptBy.tree} (keptBy in ${one.keptBy.store}); this tree reads it and never migrates it` }));
  continue;
}
```

So `engineFor`, `everKnown`, `standing` and `ensureRecord` never run for that connection. `applyStores` already
skips a target with no held steps, and none is held for it. `historyOfStores` skips a kept connection the same
way, before `reached`. The runtime is unchanged: `targetLines` in `packages/runtime/src/migrate-lines.ts` already
prints `skipped:`, `report` already exits 0 on a skip, and `--json` already carries `skipped` on the target.

**`ensure`.** Unchanged in code. X2n1 refuses a delegation to `ensure` that names a kept store, so a checked tree
never runs it on one. The runtime does not repeat the check (a rule lives in one place). So no process of the
reading tree creates a kept collection under any profile, a development one included; *A development database*
in the guide says how a developer gets one.

**`plan()`, `rehearse`, `fuzz`, `regress`, `start`.** Unchanged. A read through a kept store is a storage
operation like any other: stubbed in a rehearsal, run by the engine in `start`.

### Discoverability

- `wilanis describe <store>` (`storeLines` in `packages/runtime/src/lines.ts`) prints one line after the engine
  lines: `kept by     customers -- this tree reads it; wilanis migrate never plans it and no graph writes it`.
- `wilanis migrate` prints the `skipped:` line above, one per kept connection; `--json` carries it as `skipped`.
- The viewer's store page (`renderDocPage` in `packages/view/client/index.html`) shows the same sentence under the
  heading, and leaves out the `default` and `renamed` columns, which a kept store cannot have.
- The `@storage` README's section *The record* gains a paragraph: two trees on one database each read the one
  record; the tree that only reads says `keptBy`, and `wilanis migrate` leaves that connection to the keeping
  tree.
- `wilanis ls store` and `wilanis map` are unchanged.

### Plugin contract

None. `PluginModule` and `MigrateContext` are unchanged: `planStores` reads the mark off the store documents it
already reads.

## Compatibility

IR v1, compatible. `store.schema.json` gains one optional property and a conditional that applies only where that
property is present, so every store written before this RFC validates and means what it did. `StoreDoc` gains an
optional member. The schema change waits on the maintainer's `decision` job when it is implemented. No
`schemas-v2`.

A consumer that adds `keptBy` to a store that today says "never migrate it from here" sees `wilanis migrate` stop
planning that connection, and sees X2n1 for any write it had. The consumer's 46 stores have no write and no
`renamed`, `was` or `defaults` (checked in `projects/adr/features` and `projects/platform-system/features`), so the
mark is a pure addition there.

## Tests

Sabotage tests, in `packages/runtime/test/sabotage-storage.test.ts` beside X212 and X213, each an edit to the
example:

| Code | The edit | Expects |
|---|---|---|
| X2n1 | `"keptBy": "billing"` on `@customers/data/customers.store.json` | X2n1 at `nodes/stored/in` of `keep-customer.graph.json`, the `put`, and at every other write through that store |
| X2n1 | `"keptBy": "billing"` on `@customers/data/customers-postgres.store.json` | X2n1 at `operations/prepare/in` of `customers-postgres.binding.json`, the delegation to `@storage/storage.port.json#ensure` behind the startup step "Prepare the customer store" |
| X2n2 | `"keptBy": "billing"` on `@customers/data/customers-postgres.store.json` only | X2n2: `@features/state/data/auth.store.json` is over the same connection and says none |
| X2n3 | `"keptBy": "customers"` on `@customers/data/customers.store.json` | X2n3 at `keptBy` |
| D001 | `"keptBy": "billing"` on `@customers/data/customers.store.json`, which declares `renamed` and `defaults` | D001 at `collections/customers/renamed` and at `collections/customers/defaults` |

In `packages/plugin-storage/test/migrate-member.test.ts`, over the fake engine the file already uses: a connection
whose every store says `keptBy` is skipped with the line, and the fake engine is asked nothing (no `history`, no
`recorded`, no `inspect`); a tree with one kept connection and one of its own plans the second as before;
`historyOfStores` leaves the kept connection out.

In `packages/runtime/test/migrate.test.ts`: the `skipped:` line for a kept connection and exit 0, through the fake
plugin the file already uses (the runtime only prints `skipped`, so this is one more case of an existing test).

In `packages/runtime/test/describe-store.test.ts`: the `kept by` line. In `packages/core/test/store.test.ts`: the
baseline and the two refusals above. In `packages/view/test/stores.test.ts`: the sentence on the store page.

No postgres end-to-end test is needed: the change is that the engine is not reached.

## Implementation plan

1. Core: `keptBy` and the conditional on `store.schema.json`, `StoreDoc.keptBy`, the baseline in
   `store.test.ts`, the template row. Waits on the `decision` job, as a schema change does.
2. `@storage`: `kept.ts` with X2n1, X2n2, X2n3, called from the plugin's `check`; the sabotage tests.
3. `@storage`: `Gathered.keptBy`, the skip in `planStores` and `historyOfStores`; `migrate-member.test.ts` and the
   case in `packages/runtime/test/migrate.test.ts`; the README paragraph.
4. Discoverability: the `describe` line, the viewer's store page and their tests. (`good first issue`)

Steps 2 and 3 depend on step 1 and not on each other. Step 4 depends on step 1.

**Order with RFC 0037.** X2n1 finds a write through the call sites `calls.ts` walks (`graphCalls` and
`bindingCalls`), and reads the store each one names off its `store` input. RFC 0037 (#931, draft) changes that
walk: a plugin's `check` walks `scope.graphs()`, and a graph may name its store as `{{given.store}}`, which only
the walk over `scope.graphs()` sees as a literal. Whichever of the two lands second follows the other. If RFC
0037 lands first, step 2 reads the store from the walk RFC 0037 leaves, so a write through `{{given.store}}` to a
kept store is refused like a literal one. If this RFC lands first, RFC 0037's change to `calls.ts` carries X2n1
over to the new walk, with its sabotage tests. X2n2, X2n3 and step 3 read store documents and profiles, not call
sites, so the order does not touch them.

## Drawbacks and alternatives

- **Do nothing; teach the workaround.** Each reading store says "never migrate it from here", and the template
  and the `@storage` README say: a tree that reads collections another tree migrates never runs `wilanis migrate`
  on that connection. It costs no code. But the knowledge lives in prose the checker cannot read. A reader's
  `wilanis migrate` exits 1 on every run, so a pipeline cannot use it for the reader's own stores. A dry run still
  runs DDL against the owner's database. A partial shape still plans transformative steps that `--apply` applies
  without a flag where no destructive step blocks the connection. And nothing stops a graph writing the owner's
  records. The consumer took this route because there was no other; 46 copies of one sentence are the cost.

- **Plan drops only for collections this tree recorded** (#851's second shape: read the `tree` column of
  `wilanis_migrations`). It needs no schema change. It does not solve the need:
  - A partial shape still plans `remove`, `relax`, `ununique` and `unref` on every collection the reader reads,
    because those are the reader's own declared collections. Some of them apply under `--apply` alone.
  - A reader's `--apply` writes record rows under its own name with its partial `Declared`. The owner's next plan
    then reads the reader's declaration as the record and plans `add` steps for columns that exist.
  - On a database the owner has not migrated, the reader's `migrate` or `ensure` creates the collection with the
    partial shape, and the record then says the reader keeps it.
  - It adds no rule against a write.

  Since #933, `ensure` and `wilanis migrate` both name the tree through `treeOf` in
  `packages/plugin-storage/src/record.ts`, so the `tree` column now holds one name per tree. That removes one
  objection this RFC first raised. It does not remove the two that decide: the partial shape and the write.

  It would be the right shape only if a reader were also allowed to migrate what it reads, and that is the
  case this RFC says is wrong.

- **The mark on the connection.** The plan is per connection, so a mark there is one check and needs no X2n2. But
  `connection.schema.json` serves every connection kind (http, queue, storage), and the mark means something only
  to storage. A profile may stand one connection in for another (`connections` in `project.schema.json`, C018),
  so the mark would hold under one profile and not under another, while the write rule is about the tree's graphs
  under every profile. And what a feature does with its records is its data layer's to say, in the store, the
  document a call names.

- **The mark on a collection.** It would let one store over one connection hold kept and unkept collections.
  That is one connection migrated by two trees, which breaks both trees' plans: each plans to drop the other's
  collections. So a per-collection mark adds only the case X2n2 refuses.

- **A `--skip <connection>` flag on `wilanis migrate`.** The operator would say on each run what the tree should
  say once. `check` cannot see it, `describe` cannot print it, and it adds no rule against a write.

- **A boolean, `"readOnly": true`.** Shorter, but it does not say who keeps the records. Naming the keeping tree
  tells a reader where the shape is changed and lets the `skipped:` line say who migrates. The checker cannot verify
  the name, since the other tree is not loaded; X2n3 refuses only this tree's own name.

## Open questions

None open. Settled in review, with the edits in the text above:

1. **The word is `keptBy`.** It matches the store's own vocabulary ("what the feature keeps", `kept`, `keeps` in
   `model.ts`). `migratedBy` says less about writes, and `readOnly` drops the owner (*Drawbacks*).
2. **`migrate` does not check a kept store against the record.** It could open the connection and say, for each
   collection the reader declares, whether the record holds every field it reads in the type it reads. That needs a
   read of the record that does not run `ensureRecord`, and it turns a skip into a check. It is left out: the
   reader's first read already fails on a missing column. A follow-up may add it if a consumer asks.
3. **`--history` leaves kept connections out**, so `migrate` never opens one. The keeping tree's `--history`
   prints that connection's history.
4. **X2n3 is in.** A `keptBy` that names this tree is refused (*Checker rules*).

During implementation:

- The exact wording of the `skipped:` line and of the hints.
- The real codes for X2n1, X2n2 and X2n3: the next free numbers in `@storage`'s family when the pull request lands.
