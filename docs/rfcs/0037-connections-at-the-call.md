# RFC 0037: A connection is a literal at the call: fields that name one, graphs given one, connections made of parts

- **Status:** accepted
- **Areas:** `area:core` (one key on a contract field, `given` on a graph and on a binding operation, the instances
  of a graph in `Scope`), `area:compiler` (`connectionOf` answers every field that names a connection; every walk over
  graphs walks instances; rules in the C, R, G, L and B families), `area:runtime` (`describe`, `map`, rehearse's
  handler names), `area:view` (the graph, binding, connection and project pages), `area:plugin-*` (each shipped port
  marks the fields that name a connection or a store; the plugins whose `check` reads a call site walk instances).
  Nothing in the engine.
- **Schemas:** `common.schema.json` (a field gains `names`), `graph.schema.json` (`given`), `binding.schema.json`
  (an operation bound to a graph gains `given`). All additive; one behaviour changes (*Compatibility*).
- **Tracking issue:** #849
- **Depends on:** RFC 0013 (the reach of a profile, stand-ins), RFC 0016 (`permits`), RFC 0004 (C009 and L010, the
  one connection of a transaction), RFC 0002 (a store names its connection). All implemented. Order with the open
  RFCs: RFC 0039 and RFC 0043 touch the same code, and RFC 0042 depends on a question this RFC defers (*Order with
  other RFCs*).

## Summary

A connection stays a literal written where a call names it, so permits, the atomic rules and the secrets a profile
needs are all still judged before anything runs. Three additions let the literal sit where it belongs. First, a
native contract marks each field that names a connection or a store, `"names": "connection"` or `"names": "store"`,
and the compiler reads every marked field, not only one called `connection` or `store`: a call that reaches two
connections is seen reaching both. Second, a data graph may declare `given`, the connections or stores it goes to,
and each binding operation that names the graph gives them as literals. The compiler judges the graph once per
binding operation, as if it had been written with those literals, so one graph replaces N copies that differ only in
where they go. Third, a connection kind may mark a setting `"names": "connection"`: such a connection is made of
parts, each part is a connection document judged against its own kind, and reaching the connection reaches its parts.
A connection chosen by a value a message carries stays out, and this RFC says why. On the consumer tree that asked for
this, the recorded scenarios of the member graphs go from about 1,260 files to about 60.

## Motivation

The compiler finds a connection in one place: the literal a call site writes. `connectionOf`
(`packages/compiler/src/documents.ts`) reads one of two fields, `connection` or `store`, by name, and answers one
connection. Three rules read that one answer: a profile's reach (`reachOf` in `packages/compiler/src/reach.ts`), which
`permits` (C021, C022, `check/permits.ts`) and the secrets `wilanis start` demands are held to; L010
(`check/atomic.ts`), one transaction on one connection; and the stand-ins of RFC 0013 (`connectionUnder`). A consumer
tree with 20 member services met this four times. Each time the workaround was a copy.

**1. A call that reaches two connections.** `@schedule/scheduler.port.json#run` accepts a static `lease`: "the path of
a connection document whose kind declares `leases`". `connectionOf` does not read it, because it is not called
`connection`. `wilanis describe project.json example` prints, under `production-scheduler`:

```
holds      @otel/exporter.port.json#export
           @schedule/scheduler.port.json#run
```

with no `via`, although the step writes `"lease": "@connections/customers-postgres.connection.json"`. In the example
the same connection is reached through storage, so nothing shows. A lease on a connection nothing else reaches would be
missing from the reach: its secrets would not be demanded at start, a profile's `permits` that lists it would be
refused as dead (C022), and one that leaves it out would pass. The consumer's `@scan/scan.port.json#run` names an
engine in `connection` and the repository in a second static field, `target`; the same holds for `target`
(GAPS.md, "M3: a call reaches one connection, as far as permits can tell").

**2. A graph cannot be given its connection.** A static field takes a literal (P001, `readOf` in
`check/inputs.ts`), and a domain operation marks nothing static (L006, `check/contracts.ts`). So a data graph that
differs from another only in where it goes is a copy. The example has eight such pairs in
`example/features/customers/data/`: `kept-get.graph.json` and `kept-get-postgres.graph.json`, and so on for
`kept-list`, `kept-list-every`, `kept-list-by-tier`, `kept-remove`, `keep-customer`, `next-id` and
`store-and-latest`. `diff` of each pair shows the `store` literals and at most a sentence of the description, nothing else. Each postgres
copy says why: "a store is named statically at a call site, so pointing these at another connection is a copy until a
profile may swap one". A profile cannot: RFC 0013 kept a stand-in of the same kind, and memory and PostgreSQL are two
kinds. The consumer has five scan graphs of about 235 lines each that differ only in their connection (GAPS.md,
"M3: a graph cannot be given its connection").

**3. One graph over a list of members.** The consumer's `projects/adr` reads the history of 20 member services, each
in its own PostgreSQL schema. Per member it holds a connection, a store, a data graph, a port operation, a binding
operation and several nodes, in two features: 15 documents or entries, which a plugin rule of its own (X904, X905)
holds equal to a registry. The two graphs are 530 and 250 lines per member. Their recorded scenarios are most of the
tree's `scenarios/rehearsed/`: 1,260 of 1,431 files and 91 of 99 MB, besides a shared `answers.json` of 31 MB
(measured on 2026-10-11; GAPS.md, "M9: a tree that reads several trees' histories needs one copy of each document
per tree", and "Item 37: every command loads every recorded scenario of the tree").

**4. A connection's parts.** A consumer kind, `@scan/parts.connection-kind.json`, runs several engines as one
connection. Each part is an inline `{ name, kind, settings }`. `checkConnection` (`check/contracts.ts`) judges a
connection's settings against its own kind only (C002), so nothing judges a part's settings against the part's kind.
The consumer wrote that judgement twice, once per plugin (`checkParts`, X1101 to X1103 and X901 to X903; GAPS.md,
"M17"). The parts' secrets, if they read any, are read through the parent's settings; the parts never appear in a
reach.

**What this does not try to solve.** A connection chosen by a value a message carries (GAPS.md, "Item 31: one tree
cannot choose a host's connection by a value a message carries") stays out; *Drawbacks and alternatives* says why. A
profile still cannot stand a connection of one kind in for another (RFC 0013). A store still names one connection: the
consumer's store copies stay (*Drawbacks and alternatives*). This RFC adds no map that the compiler unrolls; the per-member
port operation and domain nodes stay (*Drawbacks and alternatives*). It does not decide whether a tree may read
collections another tree owns (#851), and it does not change `wilanis migrate`. It does not change which commands read
`scenarios/`: since f97493db, `run`, `start`, `migrate` and `map` load a tree without it, and `check`, `rehearse`,
`regress` and the viewer still read every file this RFC removes.

## Guide-level explanation

**Words.** A field *names* a connection when a contract marks it `"names": "connection"`: its literal is the path of
a connection document. A field names a *store* when it is marked `"names": "store"`: its literal is a store document,
which names its connection. A data graph's *given* is the list of connections and stores it goes to, declared by the
graph and written by each binding operation that names it. An *instance* of a graph is the graph as one binding
operation gives it: the compiler judges, walks, lowers and runs instances. A *part* is a connection another
connection's settings name.

### A field says it names a connection

`@schedule/scheduler.port.json` marks `lease`, and every shipped port marks its `connection` and `store` fields the
same way:

```json
"lease": {
  "type": "string",
  "required": false,
  "static": true,
  "names": "connection",
  "description": "the path of a connection document whose kind declares `leases`, on which a tick is held so that one instance of several fires it; absent: this process assumes it is alone and fires every tick itself"
}
```

The compiler now reads the call by its marks, not by a field's name. `wilanis describe project.json example` then
prints:

```
holds      @otel/exporter.port.json#export
           @schedule/scheduler.port.json#run  via @connections/customers-postgres.connection.json
```

A contract may mark more than one field. The consumer's `@scan/scan.port.json#run` marks `connection` and `target`,
and the call is reached on both, so a profile's `permits` sees both. A literal in a marked field that names no
document of that kind is refused where it is written:

```
R001  @features/customers/data/kept-get.graph.json#nodes/stored/store
    unknown store '@customers/data/customer.store.json'
    → wilanis ls store
```

### A data graph is given where it goes

The eight pairs in `example/features/customers/data/` become eight graphs. `kept-get.graph.json` declares what it is
given and reads it where the store goes:

```json
{
  "$schema": "https://raw.githubusercontent.com/wilanis/wilanis-js/main/packages/core/schemas/graph.schema.json",
  "label": "Get what is kept",
  "description": "Data graph behind customer.get: one record by its key, from the store its binding gives it. Absence is answered as `record` absent rather than as a failure, so the switch routes on it and the refusal is a case this graph named.",
  "given": {
    "store": {
      "names": "store",
      "description": "where the customers are kept: in memory under local and live, in PostgreSQL under production"
    }
  },
  "in": "@customers/domain/CustomerRef.shape.json",
  "out": { "type": "@customers/domain/Customer.shape.json", "from": ["customer", "noCustomer"] },
  "nodes": [
    {
      "type": "@wilanis/node/run.schema.json",
      "id": "stored",
      "label": "Read the record",
      "run": "@storage/store.port.json#get",
      "in": { "store": "{{given.store}}", "collection": "customers", "key": "{{in.id}}" }
    }
  ]
}
```

(The switch and the two answers are as they are today.) Each binding gives the graph its store, beside `graph`:

```json
"get": {
  "graph": "@customers/data/kept-get.graph.json",
  "given": { "store": "@customers/data/customers-postgres.store.json" }
}
```

and `customers-store.binding.json` gives `@customers/data/customers.store.json`. The binding already fixes the values
of a delegation (`prepare` writes `"store": "@customers/data/customers-postgres.store.json"` in its `in`); `given` is
the same thing for a graph. The domain does not change: `customer.port.json` and every domain graph are as they are.

The checker judges `kept-get.graph.json` twice, once per binding operation that names it, as if each copy had been
written with its literal. Every rule holds as it holds for today's two files: the store's `resolves` types the record,
R001 judges the literal, the reach of `production` reaches `customers-postgres.connection.json`, and `permits` lists
it or is refused. A refusal both instances earn is said once. One that only one instance earns names it:

```
L010  @features/customers/data/store-and-latest.graph.json#nodes/latest
    atomic graph reaches effects on @connections/customers-postgres.connection.json and
    @connections/customers.connection.json, under production (given by
    @customers/data/customers-postgres.binding.json#register)
    → one transaction is one connection; give both stores on one connection, or split the graph
```

That refusal is what a sabotage gets that gives `store-and-latest.graph.json` two given stores, `store` and `latest`,
and writes the PostgreSQL store for one and the memory store for the other.

A given is only where the graph goes. It is read whole, in a static field marked with the same word, or inside text (a
message may say which store it read). Anywhere else it is refused:

```
G0nn  @features/customers/data/kept-get.graph.json#nodes/noCustomer/reason
    '{{given.store}}' is read in 'reason', which names no store
    → a given says where the graph goes: read it in a field marked "names": "store", or in text
```

### A connection made of parts

A connection kind marks a setting that names other connections:

```json
"settings": {
  "fields": {
    "parts": {
      "type": "string[]",
      "names": "connection",
      "description": "the engines this connection runs, in order: one connection document each, judged against its own kind"
    }
  }
}
```

The consumer's `seams.connection.json` then names two connection documents in place of two inline objects:

```json
{
  "$schema": "https://raw.githubusercontent.com/wilanis/wilanis-js/main/packages/core/schemas/connection.schema.json",
  "description": "The seams engines, two parts of one run: semgrep with the web and shell seams rule sets, then the calls engine.",
  "kind": "@scan/parts.connection-kind.json",
  "settings": {
    "parts": ["@connections/seams-semgrep.connection.json", "@connections/seams-calls.connection.json"]
  }
}
```

Each part is an ordinary connection under `connections/`, judged against its own kind by `checkConnection`, as every
connection is (R001, C001, C002). A part may itself have parts; a chain that comes back to where it started is
refused. A reach that reaches the connection reaches its parts, so a profile's `permits` lists them and `start`
demands the secrets they read. A profile's stand-in replaces a part as it replaces any connection it names. The
example has no kind with parts, so no example document changes for this part; its tests use a kind a test plugin
grants.

### What it gives the consumer

`projects/adr` keeps one member graph per feature, given the member's history store by each binding operation. Per
member it keeps two connections, two stores, two port operations, two one-line binding operations and its domain
nodes; the two graphs of 530 and 250 lines are written once. `rehearse --record` names a file by the graph that
declares the switch (`fileOf` in `packages/runtime/src/record.ts`), and "where two runs of one trigger name one file
the first keeps it". So a trigger that reaches the member graph 20 times records each of its branches once: about 60
files in place of 1,260 across the five directories. Each file still holds the stubs of every member the trigger
runs, so I expect a file to stay its size, and about 5 MB of the 91 MB to stay. I do not know how much the shared `answers.json`
(31 MB) shrinks, since it holds each distinct answer the remaining files point at.

## Reference

### Documents and schemas

- **`common.schema.json → $defs/field`** gains `names`: `"enum": ["connection", "store"]`, with the description:
  *Native contracts and connection kinds only. This field's literal is the path of a document of this kind: a
  connection, or a store that names one. A call reaches every connection its marked fields name; a connection whose
  kind marks a setting reaches every connection that setting names. The field is a string or a list of strings, and on
  a contract it is static.* `Field` in `packages/core/src/model.ts` gains `names?: 'connection' | 'store'`.
- **`graph.schema.json`** gains `given`: an object, `minProperties: 1`, names by `ident`, each
  `{ "names": "connection" | "store", "description": string }`, both required, no other key. Description: *Where this
  data graph goes: each name is a connection or a store that every binding operation naming the graph gives as a
  literal. Read as {{given.name}}, whole, in a static field marked with the same word, or inside text. The checker
  judges the graph once per binding operation that names it, as if it were written with those literals. Data graphs
  only.* `GraphDoc` gains `given?: Record<string, { names: 'connection' | 'store'; description: string }>`.
- **`binding.schema.json`**: an operation gains `given`, an object of `path`s by name, allowed with `graph` only (the
  `dependentSchemas` for `run` sets `given: false`). Description: *The literals the bound graph's `given` asks for,
  one per name it declares.* `BindingOp` gains `given?: Record<string, string>`.
- **`Scope`** (`packages/core/src/scope.ts`) gains `graphs()`: every graph as it is judged and run, which is a graph
  that declares no `given` once, and a graph that declares one once per binding operation that names it, with
  `{{given.*}}` replaced by that operation's literals. Each is a `Loaded<GraphDoc>` with the graph's path, so a refusal names the file, and an added
  `given?: { by: string; values: Record<string, string> }`, `by` being `<binding>#<operation>`. `Scope.boundGraph(binding,
  op)` answers the instance one binding operation runs. The key of an instance is `<path>` or `<path>@<by>`.
- **`HOME`** (`placement.ts`): no change. **`packages/runtime/templates/CLAUDE.md`**: the `port` row says a field may
  say `names`; the `graph` row says a data graph may declare `given`; the `binding` row says an operation bound to a
  graph gives its `given`; the *Static fields* paragraph gains: "A data graph that differs from another only in the
  connection or store it goes to declares `given`, and each binding operation gives it; never copy the graph." The
  rule codes join the list there. **`wilanis new`**: no change; `given` is a key an author adds.

### Ports, operations and kinds granted

No new port, operation or kind. Every shipped field that names a connection or a store says so with `names`:
`@http/http.port.json#request.connection`, `@queue/queue.port.json#publish.connection` and `#ensure.connection`,
`@auth/identity.port.json#verify.connection`, `@schedule/scheduler.port.json#run.lease` (`"connection"`), and
`@storage/storage.port.json#ensure.store` and the `store` of every `@storage/store.port.json` operation (`"store"`).
No shipped connection kind has parts.

### Checker rules

Every new code is written as a placeholder (`C0nn`, `G0nn`, `L0nn`, `B0nn`). The number is the next free one in its
family when the implementing pull request lands; other open RFCs (0039, 0041) also add G rules, so no number here is
reserved.

| Code | Where it lives | Refuses when | Hint |
|---|---|---|---|
| C0nn | `check/contracts.ts`, `checkPort` and `checkConnectionKind` | `names` on a field that is not a string or a list of strings; on a contract field that is not `static`; on a field of a shape or of a domain operation; or a native static field called `connection` or `store` that does not say `names` | `mark it "names": "connection" or "names": "store", static, of type string or string[]` (for the last case: `the compiler reads a field by its mark, no longer by its name: add "names": "<word>"`) |
| C009 (restated) | `check/contracts.ts`, `checkTransactional` | a `transactional` operation marks no field `names`, or more than one: its transaction falls on what the one field names | `mark the one field the transaction falls on "names": "connection" or "names": "store", static` |
| R001 (existing) | one `Judge` method, called by `checkInputs` (`check/inputs.ts`, a node and a delegation), `checkStepInputs` (`check/project.ts`, a startup step), the binding's `given` (`check/bindings.ts`) and `checkConnection` (a part) | a literal in a field marked `names` names no document of that kind. It widens `checkConnectionNamed` (#912) from the field called `connection` to every marked field. X204's unknown-store branch is retired | `wilanis ls connection` or `wilanis ls store` |
| C0nn | `check/contracts.ts`, `checkConnection` | a connection reaches itself through its parts | `a part is another connection; break the chain at <path>` |
| G0nn | `check/graph-reads.ts` | `{{given.x}}` read other than whole in a static field marked with the given's word, or inside text; or a declared given nothing reads | `a given says where the graph goes: read it in a field marked "names": "<word>", or in text; or remove it from given` |
| L0nn | `check/graph.ts` | a domain graph declares `given` | `a domain graph reaches no connection; declare given on the data graph that does` |
| B0nn | `check/bindings.ts` | a binding operation bound to a graph gives a name the graph does not declare, leaves out one it declares, or gives `given` to a graph that declares none; or a graph that declares `given` is named by no binding operation, so no instance of it is judged | `give every name the graph declares under given, and no other` (for the last case: `bind it from a binding operation with given, or delete it`) |

Every other rule is unchanged in what it says and is judged over instances. Where the instances of one graph earn the
same refusal (same code, file, `at` and message), it is said once. Where only some do, the message ends with `(given
by <binding>#<op>, ...)`. This is the gathering `Faults` in `check/atomic.ts` already makes across profiles.

### Runtime behaviour

- **`connectionOf` becomes `connectionsOf`** (`packages/compiler/src/documents.ts`): every connection the marked
  fields of a call name, each once, in field order, a store field answering its store's connection. The singular
  form stays for L010 and reads the transactional operation's one marked field (C009). `reachOf` records
  `connections: string[]` on each `ReachedNative` (today `connection`), and `Reach.connections` gains the parts of
  each reached connection, each with the connection it is a part of. `done()` reads the secrets of the parts too.
  `checkPermits` (`check/permits.ts`) holds each to `permits`; its message adds `(given by <binding>#<op>)` or
  `(a part of <connection>)` to what it says today.
- **Walks over graphs walk instances.** `Walk` in `reach.ts`, `Walk` in `check/atomic-reach.ts`, the walk in
  `refusals.ts` and `opNeeds` in `check/resolvers.ts` follow a binding operation into `Scope.boundGraph`, and key their
  `seen` sets by the instance's key, not by the graph's path. `profilesReaching` asks for the binding operations that
  name the instance. The 15 readers of `registry.all('graph')` today (in the compiler: `checker.ts`, `sites.ts`,
  `check/atomic.ts`, `check/invariant-writes.ts`; in the plugins: `plugin-auth`, `plugin-http`, `plugin-queue`,
  `plugin-storage`; in the runtime: `scope-said.ts`, `shape-said.ts`, `map.ts` twice, `stores.ts`, `reads-said.ts`,
  `delivery.ts`) read `Scope.graphs()`, except where they show a document as written (`describe`, the viewer).
- **Lowering.** `graphCall` in `packages/compiler/src/compiler.ts` lowers an instance under the handler `graph:<path>`
  where the graph declares no `given`, and `graph:<path>@<binding>#<op>` where it does. The lowered spec holds the
  literals, so the engine and every handler see what they see today. A guard (RFC 0007) is lowered per instance.
- **`rehearse`, `fuzz`, `regress`.** A stubbed run reaches each instance as it reaches today's copies. The walk of
  switches (`switchesOf` in `branches.ts`) finds a switch once per site, as it does now, and the report gathers the
  decisions of one graph and one switch (`rehearsal-report.ts`). Where they read a graph's path from a handler
  (`specBehind`, `whereOf`), they take the part before `@`. A recorded scenario names the graph document, so the
  instances of a graph share their files (`fileOf` keeps the first run of a branch). S004 judges a scenario's branch
  against the graph document, which has the switches every instance has.
- **Parts at run time.** Nothing new. `buildEnv` (`packages/compiler/src/env.ts`) already holds every connection by
  the path the documents name, with the profile's stand-ins in place, so a handler that reads a parts setting reads
  each part as `env.connections[path]`.
- **`start`.** Unchanged: it refuses the variables the profile's reach needs, which now includes the connections a
  second marked field, a given and a part name.

### Discoverability

- `wilanis describe <port>` prints `(names a connection)` or `(names a store)` beside `(static)`.
- `wilanis describe <graph>` prints a `given` block for a graph that declares one, and under it each binding operation
  and what it gives:

  ```
  given   store  (names a store)  -- where the customers are kept: in memory under local and live, in PostgreSQL under production
          @customers/data/customers-store.binding.json#get     → @customers/data/customers.store.json
          @customers/data/customers-postgres.binding.json#get  → @customers/data/customers-postgres.store.json
  ```

  The nodes are printed as written, `{{given.store}}` included.
- `wilanis describe <binding>` prints `given store = <path>` after the graph of an operation.
- `wilanis describe <connection>` prints `parts` for a connection whose kind has parts, `part of <path>` for a part,
  and `given to <graph> by <binding>#<op>` where a binding gives it.
- `wilanis describe project.json` prints every connection a site reaches after `via`, and a part as
  `<path> (a part of <path>)`.
- `wilanis map` draws a graph once, with an edge from each binding operation that names it, labelled with what it
  gives.
- The viewer: the graph page shows the `given` block and links each binding operation; a node that reads
  `{{given.*}}` shows the read as a chip with the literals the instances give; the binding page shows `given`; the
  connection page shows its parts and what it is a part of; the project page's reach shows every connection, as
  `describe` does.
- A run's trace names an instance as the graph and the binding operation that gave it, from the handler name.

### Plugin contract

`PluginModule` does not change. A plugin's `check` that reads call sites in graphs walks `scope.graphs()`, so it sees
literals where a graph reads `{{given.*}}`; one that walks `registry.all('graph')` sees the template and will skip the
site, as a check skips a value it cannot read today. A port marks the fields that name a connection or a store
(`names`), which is the one thing a plugin outside this repository must change (*Compatibility*). A plugin that grants
a kind with parts reads each part from `env.connections` by its path.

## Compatibility

Three schemas change, each additively: a document written before this RFC validates and keeps its meaning, with one
exception. The compiler stops reading a field by its name. A plugin outside this repository whose port has a static
field called `connection` or `store` without `names` is refused by C0nn until it adds the word. Every shipped port
adds it in the same pull request. The maintainer decided this on review: the name is no longer an implied mark,
because that would keep two ways to say one thing.

C009 keeps its meaning for every shipped transactional operation, since each has exactly one field that names a
connection or a store (`@queue#publish`: `connection`; the `@storage` operations: `store`).

R001 for an unknown connection is not new. Since #912 (bb7086e3), `checkConnectionNamed` in `check/inputs.ts`
refuses a literal that names no connection document, but only in a static field called `connection`: a graph node and
a delegation reach it through `checkInputs`, a startup step through `checkStepInputs`. This RFC keeps that rule and its
two callers, and changes what it reads: every field marked `names` in place of the one field called `connection`. So
a `lease` that names no connection, which passes `check` today, is refused, and so is a store that names no store.

For a store, the refusal moves from `@storage` to the compiler. `@storage`'s X204 (`checkCall` in
`packages/plugin-storage/src/rules.ts`) refuses `'<path>' is not a store of this tree` today, and it would say the
same fault as R001 at the same `at`. This RFC retires X204's unknown-store branch, and X204 keeps its other branch, a
collection the store does not declare. The reason: a store is a core kind since RFC 0002, the compiler already reads
it (`connectionOf`, `collectionOf`), and one rule in one place judges every marked field, whatever plugin grants the
port. `checkChanges` in the same file already expects this: "X204, or R001 where the store is judged".

The example's eight postgres graph copies are deleted and its two bindings give `store`. The recorded scenarios under
`example/scenarios/` are recorded again; their names do not change, since they name the memory graphs the `live`
profile reaches.

IR v1: the lowered form gains handler names of the form `graph:<path>@<binding>#<op>`. I know of no reader of a
lowered spec outside the compiler and the runtime. The schema changes wait on the maintainer's `decision` job when implemented, and land
before `schemas-v1` (M14).

## Tests

Sabotage, in `packages/runtime/test/example.test.ts` (and `sabotage-project.test.ts` for profiles), each against the
example after step 5:

- a test plugin whose port has a static field called `connection` with no `names` → C0nn;
- give the scheduler step's `lease` the path `@connections/nowhere.connection.json` → R001;
- add a PostgreSQL connection `@connections/ticks.connection.json` that nothing else names, give it to the
  `production-scheduler` step as `lease`, and give that profile a `permits` that lists everything else it reaches →
  C021 naming the lease (the same tree passes before step 1);
- write `"store": "@customers/data/customer.store.json"` in `kept-get.graph.json` → R001, and no X204;
- drop `given` from `customers-postgres.binding.json#get` → B0nn; add `"given": { "other": ... }` → B0nn; delete every
  binding operation that names `kept-get.graph.json` → B0nn;
- read `{{given.store}}` in `noCustomer`'s `reason` → G0nn; declare a second given nothing reads → G0nn;
- declare `given` on `@customers/domain/update-customer.graph.json` → L0nn;
- give `store-and-latest.graph.json` two givens, `store` and `latest`, and make `customers-postgres.binding.json#register`
  give the PostgreSQL store for one and the memory store for the other → L010 naming that binding operation, and no
  L010 for `customers-store.binding.json#register`, which gives one store for both;
- remove `@connections/customers-postgres.connection.json` from `production.permits` → C021 naming the binding
  operation that gives the store.

The reach, in `example.test.ts`: under `production-scheduler`, `scheduler.port.json#run` reaches
`customers-postgres.connection.json`; under `production`, the `get` instance reaches the PostgreSQL store's connection
and under `local` the memory one.

Parts, in `packages/compiler/test` with a test plugin that grants a kind with a `parts` setting (a tree that passes
cannot show the cycle): a part whose settings misfit its kind → C002 at the part; a part path that names nothing →
R001; a chain back to the start → C0nn; the reach of a profile holds each part and the secrets it reads.

End to end, in `packages/runtime/test`: `rehearse` of the example settles every branch of `kept-get.graph.json` and
records one file per branch; `run --seed` of `GET /customers/{id}` under `production` and under `local` reaches each
store, read off the trace.

## Implementation plan

1. **Fields that name a connection.** `names` on `common.schema.json` and `Field`; C0nn and C009 restated in
   `check/contracts.ts`; every shipped port marked; `connectionsOf` in `documents.ts` reading marks, not names;
   `reachOf` and `checkPermits` over every connection a site names; R001 at a marked literal, `checkConnectionNamed` (#912) widened to every
   marked field; X204's unknown-store branch retired in `packages/plugin-storage/src/rules.ts`; `describe <port>` and the reach lines of `describe project.json`; the sabotage tests for these rules.
   (`area:core`, `area:compiler`, `area:runtime`, the plugins' `docs/`)
2. **Parts.** `names` on a connection kind's setting; R001 and the cycle C0nn in `checkConnection`; parts in the reach
   and its secrets; `describe <connection>` and the viewer's connection page; the test plugin and its tests.
   (`area:compiler`, `area:runtime`, `area:view`)
3. **Instances.** `given` on `graph.schema.json` and `binding.schema.json`, `GraphDoc` and `BindingOp`;
   `Scope.graphs()` and `Scope.boundGraph()`; the compiler's walks and readers keyed by instance; refusals gathered
   across instances; G0nn, L0nn, B0nn; lowering per instance. (`area:core`, `area:compiler`)
4. **Readers of instances outside the compiler.** The four plugins' checks and the runtime's readers move to
   `Scope.graphs()`; rehearse, fuzz and regress read a handler's graph path; `describe <graph>`, `describe <binding>`,
   `map`, the trace, the viewer's graph and binding pages. Must land before step 5, or a plugin's X rule misses a
   given site. (`area:runtime`, `area:view`, `area:plugin-*`)
5. **The example and the words.** The eight graph pairs become eight graphs given their store; the two bindings give
   it; scenarios recorded again; the template rows and the *Static fields* paragraph; `docs/model.md`'s *One way in*.
   (`area:runtime`; the template and `docs/model.md` are a `good first issue`)

Step 1 and step 2 do not depend on each other. Step 3 depends on step 1 (a given is read in a marked field), step 4
on step 3, step 5 on step 4.

## Drawbacks and alternatives

**What it costs.** The checker judges a graph once per instance, so a tree that gives one graph to 20 binding
operations judges 20 graphs, as it judges the 20 copies today; the checker gets no faster. Every walk that kept a set
of graphs keyed by path is keyed by instance, which is a change in 15 readers and four walks; a reader that is
missed sees the template and skips a site. The refusals of a graph's instances are gathered, so an author reads one
refusal where 20 copies earned the same one, and an instance's own refusal names the binding operation that gave it.

**Do nothing; teach the workaround.** Two sentences in the template: "A call reaches one connection, the one its
`connection` (or `store`) names; where an operation needs two, split it into two operations." And "a connection
cannot be handed to a graph; write one graph per connection and say in each that a change to one is a change to all."
That is what the example and the consumer do. It costs the eight example pairs, the consumer's five scan graphs and
40 member graphs, two plugin rules that hold copies equal, and a scenarios directory that grows by 11 to 15 files
per member in each trigger's directory. And the first sentence is not true of the shipped `lease` field today: a tree cannot
split the scheduler's `run`.

**A static field on the graph's `in`** (the issue's wording). The value would come from the domain operation's
accepts, so the domain would name a store or a connection, which is the data layer's to name, and L006 says a domain
operation marks nothing static. The binding already fixes a delegation's values; `given` is the same word for a
graph, written in the same document.

**A map over a literal list of members that the compiler unrolls** (the issue's shape for need 3). A map in a domain
graph runs one domain operation, and one binding operation meets it. For each element to reach its own store, the
element would have to choose the binding's given: either a domain field marked static that the binding selects on,
which puts the list of stores in the domain, or a value that chooses from a table, which is a connection chosen by a
value (below). And it would not remove the consumer's second pass, which asks one member for an older commit that a
page names: which member is a value read at run time. So this RFC removes the copies of the graph, which are the 780
lines per member and the scenarios, and leaves one port operation, one binding line and the domain nodes per member.
If those prove heavy once this lands, a later RFC can take the list with the numbers in hand.

**A connection chosen by a value a message carries** (GAPS.md, Item 31). Every rule this RFC keeps needs the
connection before the run. `permits` and the secrets `start` demands need the set of every connection a call can
reach; a value from a message is unbounded unless the tree lists every value it may take. L010 needs the one
connection of a transaction; with a value it is one of N per run, and the checker cannot say whether two effects of an
atomic graph pick the same one. A stubbed run never reaches a connection, so `rehearse` would not see the choice, and a
value outside the list would be a fault only a real run finds. RFC 0013 answers "a connection that differs by place"
with a profile, one per process; that is still the answer, and the consumer's own design for Item 31 is one profile per
host.

**A store given its connection.** One store document reached on N connections would also remove the consumer's 20
store copies and the example's second store. It was set aside here. A store's own connection is what `wilanis migrate`
plans and what `@storage`'s X rules judge the store's capabilities against; with N connections both become a question
per connection. The example's pair is memory and PostgreSQL, two kinds, which a same-kind rule like RFC 0013's would
not allow. And #851, a store that reads collections another tree owns, is about the same stores. It belongs with #851.

**A parts setting as inline objects with a `kind`, judged by the compiler.** The compiler could judge
`{ kind, settings }` objects in place. Then a part is not a document: it has no path, no description, no stand-in, and
`permits` cannot name it. A part that is a connection document gets all of these from rules that exist.

**An implied mark by name, beside `names`.** Fewer edits to third-party ports, and two ways to say one thing; the
checker would still have to read names forever. Rejected on review (*Compatibility*).

## Order with other RFCs

- **RFC 0039 (keep and group a list).** Both RFCs add keywords to `common.schema.json → $defs/field` and to `Field` in
  `model.ts`: this one `names`, RFC 0039 `within` and `reaches`. The keywords mean different things and no field needs
  both, so neither RFC depends on the other. The schema change of whichever lands second is rebased on the first, and
  its implementing pull request keeps both keywords in the field's description.
- **RFC 0043 (a profile from another).** Both change `permits`, `reachOf` and how a profile is resolved. RFC 0043
  resolves a profile once (`Scope.profile`), and `connectionFor`, `bindingFor` and `checkPermits` read that. This RFC
  changes what the reach holds: every connection a call names, the parts, and the instances of a graph. The two meet
  in `connectionUnder` and `checkPermits`. Neither needs the other first. Whichever lands second adds a sabotage test
  for the other's case: a part or a given connection reached under a profile that `extends` another, held to the
  `permits` the child resolves.
- **RFC 0042 (`keptBy`).** It depends on the question this RFC defers, a store given its connection (*Drawbacks and
  alternatives*). Its X2n1 finds a write through a kept store with the `@storage` call-site walk in `calls.ts`
  (`graphCalls`), which step 4 of this RFC moves to `Scope.graphs()`. After step 4, a write through `{{given.store}}`
  is found in each instance, with the store that instance names. If RFC 0042 lands first, step 4 keeps X2n1's
  sabotage tests passing and adds one where the kept store is given. If a later RFC lets one store be reached on
  several connections, `keptBy` has to say which of them another tree keeps; that RFC decides it together with RFC 0042.

## Open questions

None before `accepted`.

**Settled on review, so the reasoning survives.**

- **The name convention goes.** The compiler stops reading a static field because it is called `connection` or
  `store`. C0nn refuses such a field without `names`, and every shipped port adds the word in step 1. One rule lives
  in one place, and the change is cheap before 1.0.
- **Each part is listed in `permits`.** Permitting a connection does not permit its parts. A part is a system the tree
  talks to, and RFC 0016 asks "may this tree talk to that system" once per connection. C021 names a part that is
  reached and not listed, with `(a part of <connection>)`.
- **A given may be read inside text.** A message may read `{{given.store}}`. A given is still read whole only in a
  static field marked with its word (G0nn). The consumer's messages name the store they could not read.
- **An unknown store is the compiler's R001, not `@storage`'s X204.** *Compatibility* says why.

May be decided during implementation:

- Whether a `names` field may also say which connection kinds it takes (`"kinds": [...]`), which would let the
  compiler judge what each plugin's X rules judge today. It is not needed for the four needs.
- Whether `rehearse` runs one site per instance of a graph rather than every site. Today it runs every site and
  records one file; running one would make it faster, and is safe only where the instances lower to the same spec
  but for the given literals.
- The exact wording of the messages and of the `describe` lines.
