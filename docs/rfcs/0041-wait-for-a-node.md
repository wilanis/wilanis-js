# RFC 0041: `after`: a node waits for another whose answer it does not read

- **Status:** draft
- **Areas:** `area:engine` (`after` on `KCall` and `KMap`, the wait table `planOf` builds), `area:core` (`after` on
  `node/run.schema.json` and `node/map.schema.json`, `RunNode`, `MapNode`), `area:compiler` (lowering, one wait table
  for the routing rules, two `G` rules, and new meaning for G007, G008, G015, G022, G023), `area:runtime` (what
  `rehearse` steers, what `describe` prints, the template), `area:view` (an `after` edge). No plugin changes.
- **Tracking issue:** #857
- **Depends on:** none. It extends the routing rules that are implemented: G015 (`check/graph-reads.ts`), and
  G022 and G023 (RFC 0014's `catch`, `check/graph-nodes.ts`).

## Summary

A run or map node may say `after`: a list of ids of nodes in the same graph. The node does not start until each of
those nodes has answered. It does not read their answers, and its operation is not given them. To the engine, a node
named under `after` is one more node to wait for, beside what the node reads and the switch that routes it. So
everything that follows from waiting follows from `after` too. A node that waits for a node behind a switch's branch
runs only on that branch. A node that waits for a node that refuses never starts. The checker reads `after` wherever
it asks who waits for whom: cycles (G007), routing (G015), and readers of a caught node (G022, G023). Two new rules
refuse an `after` that cannot mean what its author wants: one that names an unknown node, the node itself or a switch
(G0n1), and one that names a node this node already reads (G0n2). `describe` prints the waits, and the viewer draws
them as their own kind of edge. Today the only way to make a node wait is to make it read something. That is
impossible when the operation takes no input that could carry the value. Where it is possible, the author has to add
a filter or an input whose only job is to make the wait.

## Motivation

**How a node waits today.** The engine starts a node when three things are true: every node it reads has answered,
the switch that routes it chose it, and every root it reads (`in`, `context`) was supplied (`isReady` in
`packages/engine/src/run.ts`). `planOf` in `packages/engine/src/plan.ts` builds the wait table from the node's reads
(`nodeRefs`), its router, and, for a switch, the nodes it catches. Nothing else makes a node wait. The checker
mirrors this. `Narrowing.dependencies` in `packages/compiler/src/check/narrowing.ts` holds who reads whom.
`checkWhole` in `check/graph-whole.ts` adds the routing edges. `graph-routing.ts` answers every routing question
over the two tables. The template says it in one sentence: "A switch chooses who answers, not who runs"
(`packages/runtime/templates/CLAUDE.md`).

**What a switch holds back.** A switch holds back the nodes its rules name as `to`, and whatever reads them. Each
rule names one node, and a node is routed by one switch only (G009). So when one branch needs two effects that do
not read each other, only one of them can be the rule's `to`. The other one runs on every branch. G015 refuses it:
"effect 'x' runs on every branch, but its answer is read only under 'y'". G015's fix is "make 'x' the 'to' of the
switch rule". That fix works when the branch has one effect. It fails when the rule must route to a node that reads
what the rule proved. A `has(record)` rule proves `record` present only for the node it routes to and for what reads
that node (`establishedFor` in `narrowing.ts`). If the rule routes to the effect instead, that node loses the proof.

**What a consumer tree did instead.** The review harness tree (its `GAPS.md`, "Item 12: an effect cannot wait for a
node whose answer it does not need") has three kinds of site. Each one adds a value that exists only to make a wait.

1. *A filter that every record passes.* Each of the 20 member graphs of `projects/adr` reads the trend counts of
   every run. That read must run only when a run was found, behind the switch `isThereOne`. The rule
   `len(runs) > 0` already routes to `latest`. So the read reads `latest` through a filter that never filters:

   ```json
   {
     "type": "@wilanis/node/run.schema.json",
     "id": "allTrends",
     "run": "@storage/store.port.json#find",
     "in": {
       "store": "@pages/data/banking.store.json",
       "collection": "trends",
       "where": { "run": { "ne": "{{latest.commit}}" } }
     },
     "description": "... It reads latest only so that the read waits until a run was found (GAPS.md, \"Item 12 ...\")."
   }
   ```

   The query sent to the store changes. It is correct only because "a run's id is never a commit". If that ever
   stops being true, the read silently drops rows. `@storage`'s `find` marks `store` and `collection` `static`
   (`packages/plugin-storage/docs/store.port.json`), so a `where` is the only place a read of a node fits.

2. *An input that a port takes and never uses.* `site.port.json#pages` accepts `account`: "the logged-in account, as
   session answers it: taken so that nothing is read before twg is known to be logged in, and otherwise unused". So
   does `PlanAsked.shape.json`. The tree's record says why ("Decisions", item 3): "In a domain graph, a switch on the
   session made every read that does not depend on it run on every branch (G015). So `site.port.json#session`
   refuses unless twg is ready (`data/session.graph.json`), and `#pages` and `#page` take the account only to wait
   for it." The port's contract now says something false about what the operation needs. Every caller must supply
   the value. An operation that accepts nothing (`registry.port.json#members`) cannot be made to wait at all.

3. *An input that exists for G008.* `projects/platform-system`'s `pages.port.json#publish` accepts `kept`: "where the
   page was kept; taken so the blob is answered only once the page is kept, and otherwise unused". Without that
   input, nothing reads the node `kept`, and G008 refuses it ("node 'kept' is read by nothing").

**The existing answer, and where it stops.** Issue #857 names it: route the switch to one domain operation whose data
graph does all the reads, so the reads sit behind one `to` together. In a domain graph this works. It costs a port
operation, a shape for what crosses it, a data graph, and a binding under each profile, for each group of reads. In a
data graph it is not available. A data graph runs native operations only: `checkOperationFits` in
`packages/compiler/src/check/graph.ts` refuses "data graph runs domain operation" (L002). The member graphs in site 1
are data graphs. A data graph can only write a second switch with the same rule for each extra read, plus an `else`
target of its own for each (G009 routes a node once). That copies the rule, and each copy adds another candidate to
`out.from`.

**What RFC 0004 and RFC 0011 said.** RFC 0011, "Effects that must not repeat": "The pattern that needs no feature is
RFC 0004's: put the irreversible effect *after* the retried one, reached by a data dependency on its answer." That is
right when the later node needs the answer. The new evidence is three kinds of site where it does not. At those
sites the operation has no input that could carry the answer, or it can carry the answer only by changing what it
does. RFC 0004 said "a transaction cannot be a pair of nodes an author sequences by hand". This RFC leaves that
true: `after` orders nodes, and only `atomic` makes them commit together.

**What this does not try to solve.**

- A node that must run whatever a switch decides, after a node whose fault that switch catches (`GAPS.md`, "Item 32
  (B4)"). `after` waits for an answer, as a read does. It never waits for a fault.
- How a refusal settles while other nodes are still running (`GAPS.md`, "Item 37: a refusal that settles while other
  reads still run is recorded by timing"). `after` lets an author keep reads from starting before a node that may
  refuse. It does not change what the engine does with a node already in flight.
- A wait for "one of" several nodes. `after` waits for all of them.
- A wait in a switch. A switch waits for what it reads and catches, as today.

## Guide-level explanation

**Waiting.** A node *waits for* another when it does not start until that one has answered. Today a node waits for
what it reads, and for the switch that routes it. `after` names more nodes for it to wait for, by id, without reading
their answers. Everything a wait does, `after` does:

- A node that waits for a node behind a switch's branch runs only on that branch. When the switch takes another
  branch, the engine cancels the node it did not choose and everything that waits for it.
- A node that waits for a node that refuses, or breaks with a fault no switch catches, never starts. The run ends
  first.
- A node that waits for a node is not given its answer. Its operation takes exactly its `in`, as before.

Here is a data graph the example could add beside `kept-get.graph.json`. It answers one customer with the latest
registration of every tier. It reads the customer, and on the branch where the customer is kept it reads the
`latest` collection. That read needs nothing from the customer:

```json
{
  "$schema": "https://raw.githubusercontent.com/wilanis/wilanis-js/main/packages/core/schemas/graph.schema.json",
  "label": "A customer's card",
  "description": "Data graph behind customer.card: the customer by id, and the latest registration of every tier. The latest rows are read only where the customer is kept.",
  "in": "@customers/domain/CustomerRef.shape.json",
  "out": { "type": "@customers/domain/CustomerCard.shape.json", "from": ["card", "noCustomer"] },
  "nodes": [
    {
      "type": "@wilanis/node/run.schema.json",
      "id": "stored",
      "label": "Read the record",
      "run": "@storage/store.port.json#get",
      "in": { "store": "@customers/data/customers.store.json", "collection": "customers", "key": "{{in.id}}" }
    },
    {
      "type": "@wilanis/node/switch.schema.json",
      "id": "isKept",
      "label": "Is it kept?",
      "in": { "record": "{{stored.record}}" },
      "rules": [{ "when": "has(record)", "to": "customer" }],
      "else": "noCustomer"
    },
    {
      "type": "@wilanis/node/run.schema.json",
      "id": "customer",
      "label": "The record",
      "run": "@std/object.port.json#make",
      "in": { "value": "{{stored.record}}", "type": "@customers/domain/Customer.shape.json" }
    },
    {
      "type": "@wilanis/node/run.schema.json",
      "id": "everyLatest",
      "label": "Every tier's latest",
      "run": "@storage/store.port.json#find",
      "after": ["customer"],
      "in": { "store": "@customers/data/customers.store.json", "collection": "latest" }
    },
    {
      "type": "@wilanis/node/run.schema.json",
      "id": "card",
      "label": "The card",
      "run": "@std/object.port.json#make",
      "in": {
        "value": { "customer": "{{customer}}", "latest": "{{everyLatest}}" },
        "type": "@customers/domain/CustomerCard.shape.json"
      }
    },
    {
      "type": "@wilanis/node/run.schema.json",
      "id": "noCustomer",
      "label": "No such customer",
      "run": "@std/outcome.port.json#refuse",
      "in": {
        "reason": "missing",
        "message": "no customer {{in.id}}",
        "type": "@customers/domain/CustomerCard.shape.json"
      }
    }
  ]
}
```

`CustomerCard.shape.json` and `customer.port.json#card` are what the example would add with it. Without the
`after` line, `wilanis check` refuses `everyLatest`. G015's hint gains the new fix, and names the node the rule
already routes to:

```
G015  @features/customers/data/kept-card.graph.json#nodes/everyLatest
    effect 'everyLatest' runs on every branch, but its answer is read only under 'card'
    → route the effect under the branch that reads it: make 'everyLatest' the 'to' of the switch rule that leads to 'card', let it wait for the node that rule routes to ("after": ["customer"]), or read its answer from every branch
```

Routing the rule to `everyLatest` instead would cost `customer` the proof of `has(record)`, and `{{stored.record}}`
would then be optional where `#make` requires it. With `after`, the run takes two paths:

- `stored` answers a record. `isKept` routes to `customer`. `customer` answers, then `everyLatest` starts, then
  `card` answers.
- `stored` answers no record. `isKept` routes to `noCustomer`, and cancels `customer`. The engine cancels
  `everyLatest` because it waits for `customer`, and cancels `card` because it reads both. `everyLatest` never
  queries the store.

`wilanis describe` prints the wait on the node's line:

```
    everyLatest  @storage/store.port.json#find  after customer
```

The viewer draws a dashed edge from `customer` to `everyLatest`, head to head, with the legend "waits for a node it
does not read".

**Waiting for a node that may refuse.** In the review harness's domain graph, the session check refuses when twg is
not logged in. With `after`, the reads wait for it, and no input carries the account:

```json
{ "type": "@wilanis/node/run.schema.json", "id": "session", "run": "@pages/domain/site.port.json#session" },
{ "type": "@wilanis/node/run.schema.json", "id": "read", "run": "@pages/domain/site.port.json#pages", "after": ["session"] },
{ "type": "@wilanis/node/run.schema.json", "id": "registry", "run": "@pages/domain/registry.port.json#members", "after": ["session"] }
```

When `session` refuses, the run ends with its reason. `read` and `registry` were never started, so neither of them
can end the run first with a reason of its own.

**Waiting for an effect whose answer nothing needs.** `kept` writes the page and `published` answers it. A node named
under another node's `after` counts as used, so G008 does not refuse `kept`:

```json
{ "type": "@wilanis/node/run.schema.json", "id": "kept", "run": "@system/domain/pages.port.json#keep", "in": { "name": "system-{{instant}}", "text": "{{page.page}}" } },
{ "type": "@wilanis/node/run.schema.json", "id": "published", "run": "@system/domain/pages.port.json#publish", "after": ["kept"], "in": { "text": "{{page.page}}" } }
```

**When `after` is refused.** An `after` that names a switch looks like a wait for a check. It is not one: a switch
answers on every branch, so the node would start once the decision is made, whichever way it went.

```
G0n1  @features/customers/data/kept-card.graph.json#nodes/everyLatest/after/0
    after names switch 'isKept', which answers on every branch
    → wait for the node its rule routes to: "after": ["customer"]
```

An `after` that names a node this node already reads adds nothing:

```
G0n2  @features/customers/data/kept-card.graph.json#nodes/card/after/0
    'card' already waits for 'customer': it reads {{customer}}
    → drop 'customer' from after; a node waits for whatever it reads
```

## Reference

### Documents and schemas

**`node/run.schema.json` and `node/map.schema.json`** gain one optional property, the same in both:

```json
"after": {
  "description": "Nodes of this graph this node waits for without reading their answers: it starts only once each has answered, as if it read them, and its operation is not given them. A node behind a switch's branch makes this node run only on that branch; one that refuses or breaks means this node never starts. Names a node that is not this one, not a switch, and not one this node already reads (G0n1, G0n2).",
  "type": "array",
  "items": { "$ref": "../common.schema.json#/$defs/ident" },
  "minItems": 1,
  "uniqueItems": true
}
```

On a map node the wait is for the node as a whole: no element starts before every node under `after` has answered.
`node/switch.schema.json` does not change.

**`graph.schema.json`**: the description "A node runs when every value it reads has settled" becomes "A node runs
when every value it reads has settled and every node it names under `after` has answered".

**`packages/core/src/nodes.ts`**: `RunNode` and `MapNode` gain `after?: string[]`.

No new kind. No change to `HOME` in `placement.ts`, and none to what `wilanis new` scaffolds.
`packages/runtime/templates/CLAUDE.md` changes two places. Its "A switch chooses who answers, not who runs" paragraph
gains: "Where one branch needs a node the rule cannot route to, because the rule already routes to another, the node
says `after: [<that node>]` and runs only on that branch. A node never takes an input, or a filter, only to wait." Its
G list gains G0n1 and G0n2. `docs/model.md`, under "Graphs", gains the same sentence as the schema description.

### Ports, operations and kinds granted

None.

### Checker rules

The two new rules live in a new module, `packages/compiler/src/check/graph-after.ts`, called from `GraphCheck.run` in
`check/graph.ts` beside `checkCatches`. Each is a G rule about one node's `after`, so it is made in the G family's
directory. The numbers are assigned when the implementing pull request lands (G027 and G028 are the next free ones
today).

| Code | Where it lives | Refuses when | Hint |
|---|---|---|---|
| G0n1 | `check/graph-after.ts` | `after` names a node this graph does not have (`after names unknown node 'x'`), the node itself (`'x' waits for itself`), or a switch (`after names switch 's', which answers on every branch`). At `nodes/<id>/after/<index>`. | unknown: `name a node of this graph that must answer before '<id>' starts`; itself: `drop '<id>' from its own after`; a switch: `wait for the node its rule routes to: "after": ["<target>"]`, naming the switch's targets |
| G0n2 | `check/graph-after.ts` | `after` names a node this node already reads, in `in` or a map's `over`. At `nodes/<id>/after/<index>`. | `drop '<x>' from after; a node waits for whatever it reads` |

G0n2 refuses only a direct read. A node that waits for `x` and also reads a node that reads `x` is not refused. That
wait is redundant too, but saying so would need the whole walk, and the edge is still true.

**One wait table.** `Narrowing` gains `waits`: node id to what it reads plus what it names under `after`.
`dependencies` keeps its meaning, "the nodes it reads", for the rules that are about values:

- **Over `waits`:** `routed`, `branchesOf`, `upstreamOf` and `readOnSomeBranchesOnly` in `graph-routing.ts`;
  `establishedFor` in `narrowing.ts`; cycle detection (G007) and the output candidates (G010) in `graph-whole.ts`;
  and the readers of a caught node (G022, G023) in `graph-nodes.ts`. `checkWhole` adds the routing edges to
  `waits` (today it adds them to `dependencies`).
- **Over `dependencies`, unchanged:** G021 (a switch catches a node it reads; a switch has no `after`), L016 in
  `graph-making.ts` (an effect that *reads* a made value; one that only waits for the node reads nothing of it), and
  `valuesReading`, which points G023 at the `in/<name>` that reads the broken node.

What each existing rule then says, with no new code:

- **G007.** A cycle through `after` is a cycle. The message lists it as it lists any other. The hint becomes "break
  the cycle: a graph is a dataflow, so one of these edges must read or wait for something earlier".
- **G008.** A node named under another node's `after` is used. `checkUnusedNodes` treats it as read. The hint for an
  unread, unrouted effect gains "or, where another node must not start before it, name it in that node's after".
- **G015.** A node that waits for a routed node is routed (`routed` follows `waits`). So `everyLatest` above is not
  refused. A node that waits for an effect counts as a reader of it, so an effect that only a waiter on some branches
  waits for is refused, as one read there would be. Where the first readers sit behind exactly one switch through
  exactly one target, the hint names that target as `"after": ["<target>"]` (computed from `branchesOf`, which the
  rule already calls).
- **G022.** A node whose `after` names a caught node must run behind the switch that catches it, as a reader must.
  Otherwise it would wait for a node that broke. The refusal sits at `nodes/<id>/after`.
- **G023.** A node at or behind the target of a caught fault must not wait for the node that broke. That node produced
  nothing, so the waiter would never start. The refusal sits at `nodes/<id>/after`.
- **Narrowing and proofs.** A node that waits for a routed node takes what that routing established
  (`establishedFor`). So it may read a path the rule proved present (`has(...)`) as required. `heldAt` in `prove.ts`
  may prove an invariant there. This is sound: the waiter starts only where the routed node ran, and that node ran
  only where the rule held. The checker and the guard lowering still ask the one `heldAt`, so neither can prove a
  site the other would guard.

### Runtime behaviour

**The engine.** `KCall` and `KMap` in `packages/engine/src/spec.ts` gain `after?: string[]`: "Node ids this node
waits for without reading them." `waitsFor` in `plan.ts` adds them to the node's waits, and `plan.ts` exports it.
Nothing else in the engine changes. `isReady` already requires every wait to have answered. `cancel` already cancels
whatever waits for a cancelled node, through `dependents`. `end` already cancels every pending node when the run ends
on a refusal or an uncaught fault. A seeded node (`initial`, a replay) counts as answered, so a waiter on a seeded
node runs. `needs` (a blocked run's missing roots) reads sources only and is unaffected.

**The compiler.** `lowerNode` in `packages/compiler/src/compiler.ts` copies `after` onto the `KCall` or `KMap`. A
guard needs nothing new. `lowerOne` in `guard-lowering.ts` moves a made node aside to `<id>:made` whole, so its own
`after` moves with it. An `after` that names a guarded made site keeps naming `<id>`. After lowering, `<id>` is the
value the guard let through, so the waiter waits for the value that stood, and never starts when `<id>:violated`
refuses.

**A refusal.** When a node under `after` refuses, the run ends with that refusal, and the waiter is cancelled before
it starts. This is the point of the second example: the check's reason is the run's reason.

**A `catch`.** `after` never waits for a fault. G022 and G023 keep a waiter off every path where the node it waits for
may have broken. So a waiter runs only on a branch where that node answered. On every other branch the engine
cancels it.

**Atomic graphs.** `after` adds no operation and no connection. The walk in `check/atomic-reach.ts` follows
operations, not edges, so L009, L010, L011, G014 and G020 judge the same set as before. Inside an atomic graph,
`after` fixes the order in which two writes reach the one session the transaction holds. For example, a parent row
can be written before a child row whose foreign key names it. Atomicity still comes from `atomic`. When a waited
write refuses inside an atomic graph, the waiter never starts, and the transaction rolls back as before.

**`rehearse`.** It runs the engine, so a waiter behind a branch is cancelled there, as any other node is. The one
place that restates the engine's waits is `waitsFor` in `packages/runtime/src/rehearse-reached.ts`. `routingTo`
uses it to steer every switch that routes a node a found switch waits for. It changes to call the engine's exported
`waitsFor`, so the two cannot disagree. Without this step, `rehearse` would not steer `isKept` to `customer` to
reach a switch behind `everyLatest`. That switch would be reported `NEVER RUN`.

**`regress`, `fuzz`, traces.** They run the engine and need nothing new. A scenario recorded before a tree adds
`after` may see a node move from `done` to `cancelled` on a branch. That is a change of the tree, and the scenarios
are recorded again.

### Discoverability

- **`wilanis describe <graph>`.** `nodeLine` in `packages/runtime/src/graph-said.ts` appends `  after <ids>` to a run
  or map node's line, after its fan-out and attempts.
- **The viewer.** `VEdge.kind` in `packages/view/src/types.ts` gains `'after'`. `graphs.ts` adds one edge per entry,
  from the waited node's head to the waiter's head. `client/index.html` draws it dashed, and adds the legend entry
  "waits for a node it does not read" only where a graph has one. The node's detail panel lists "waits for" beside
  its inputs.
- **The refusals.** `docs/refusals/G0n1.md` and `G0n2.md` (RFC 0019's pages). `G007.md`, `G008.md`, `G015.md`,
  `G022.md` and `G023.md` each gain a sentence about `after`.
- `wilanis map` and `wilanis ls` are unchanged: they do not show nodes.

### Plugin contract

None.

## Compatibility

`after` is optional on two node schemas, so every document written before this RFC still validates and keeps its
meaning. A spec without `after` runs exactly as today. Until 1.0, `schemas-v1` is edited in place. After 1.0 this is
a compatible change and is still edited in place (RFC 0008). The schema change waits on the maintainer's `decision`
job when it is implemented.

## Tests

**Sabotage tests**, in `packages/runtime/test/sabotage-routing.test.ts` beside G015's, each on a copy of the example:

- G0n1: in `kept-get.graph.json`, `customer` says `"after": ["nowhere"]`; then `"after": ["customer"]`; then
  `"after": ["isKept"]`. Each refuses G0n1 with its own message.
- G0n2: `customer` says `"after": ["stored"]`, and it reads `{{stored.record}}`. Refuses G0n2.
- G015, fixed by `after`: `kept-get.graph.json` gains a second effect behind `isKept`, a `#find` read only by a node
  that reads `customer`. Without `after` it refuses G015, with the hint naming `"after": ["customer"]`. With
  `"after": ["customer"]` it passes.
- G007: two nodes that wait for each other refuse G007, and the message lists both.
- G008: `publish-removal.graph.json` gains a node whose answer nothing reads and which `queued` names under `after`.
  No G008.

In `packages/runtime/test/sabotage-catch.test.ts`, beside G022 and G023, on `get-row.graph.json`:

- G022: a node that is not behind `outcome` says `"after": ["fetched"]`. Refuses G022 at `nodes/<id>/after`.
- G023: `unreachable` says `"after": ["fetched"]`. Refuses G023 at `nodes/unreachable/after`.

**The engine**, in a new `packages/engine/test/after.test.ts`:

- A waiter does not start before the node it waits for has answered. The clock stamps prove the order.
- A waiter on a node a switch did not choose is `cancelled` and its handler is never called.
- A waiter on a node that refuses is `cancelled`, and the run's reason is that node's.
- A waiter on a seeded node runs.
- A map that waits starts no element before the wait has answered.

**The compiler**, in `packages/compiler/test`: `lowerNode` copies `after`. A waiter on a guarded made site waits for
`<id>`, and a made node moved to `<id>:made` keeps its own `after`. A tree that passes cannot show this, because the
lowered spec is not a refusal.

**`rehearse`**, in `packages/runtime/test`: a trigger whose graph has a switch nested behind a waiter is walked on every
branch, and no case reports `NEVER RUN`.

**`describe` and the viewer**: the `after` line, and the `after` edge in `viewOf`'s output, each in its package's tests.

## Implementation plan

1. **The engine waits.** `after` on `KCall` and `KMap`, `waitsFor` in `plan.ts` reads it and is exported, and
   `packages/engine/test/after.test.ts`. No schema changes, and no document can say it yet. `area:engine`.
   `good first issue`.
2. **A graph says `after`.** The two schemas, `RunNode` and `MapNode`, `lowerNode`, the `waits` table in `Narrowing`
   with the routing rules moved onto it, G0n1 and G0n2 in `check/graph-after.ts`, the hints of G007, G008 and G015,
   the refusal pages, the sabotage tests, the compiler tests, the template, `docs/model.md` and the
   `graph.schema.json` description. One pull request, because a schema that accepts `after` must never reach a
   checker that judges routing without it. It changes a schema, so it waits on the `decision` job. `area:core`,
   `area:compiler`.
3. **`rehearse` steers through a wait.** `rehearse-reached.ts` calls the engine's `waitsFor`, with the test above.
   `area:runtime`. `good first issue` after 2.
4. **A reader sees the wait.** `describe`'s `after` line and the viewer's edge, legend and panel, with their tests.
   `area:runtime`, `area:view`. `good first issue` after 2.

## Drawbacks and alternatives

**What it costs.** A graph gets a second kind of edge, and a reader must know both kinds. "A node runs when what it
reads is ready" stops being the whole rule. An author can also put in order two nodes that could run at the same
time, and a run gets slower with no refusal to say so. G015's hint offers a third fix. An agent may choose `after`
where routing the effect itself is the better answer. The hint lists routing first for that reason, and G0n2 refuses
the most common wrong wait.

**Do nothing; teach the workaround.** The template would say: "To make reads wait for a check, route the check's
switch to one domain operation whose data graph does those reads. Do not add a filter or an input that exists only
to make a dependency." This needs no change of code and is right in a domain graph. It cannot be followed in a data
graph (L002). There it leaves the author with the workarounds the instruction forbids, or with one switch per extra
read, each with its own copy of the rule and its own `else` target. In a domain graph it costs a port operation, a
shape, a graph and a binding per profile for each group of reads, only to put them behind one `to`. For an operation
that refuses on its own, with no switch, it gives nothing to route. The consumer's site 2 is that case, and its
site 3 (G008) has no switch at all.

**A rule routes to several nodes: `"to": ["customer", "everyLatest"]`.** This keeps the wait inside the switch, where
the decision is. But `to` is the switch's answer (`report.selected`, and the `STRING` that `nodeOut` types a switch
as). It is also how a scenario names a branch (S004) and how `rehearse` builds a case (`casesFor`). Every reader of
`targetsOf` would change, in the engine, the compiler, `rehearse`, `describe` and the viewer. It covers only the
switch case: not a wait for a node that refuses, and not the G008 case. It is a larger change for less.

**A switch holds back the reads it gates, with no new word.** The compiler would find each effect that G015 refuses
today, and make it wait for the branch its readers sit behind. There are three problems. First, the readers may sit
behind two targets of one switch, and then the effect must wait for "one of" two nodes. The kernel has no such wait.
`after` waits for all of its nodes, and `cancel` cancels a waiter as soon as any one of them is cancelled. So this
needs a new kind of wait in the engine, not only a new word in a document. Second, the wait is in no document. A
reader of the file, `describe` and the viewer would each have to rebuild it from the whole graph. An effect would
start later than its own inputs say, for a reason written nowhere. Third, it covers only the switch case, as the
previous alternative does. One thing speaks for it: a tree that passes today has no node G015 refuses, so it would
not change the trees that pass. It could still be built later on top of `after`, as a hint that writes the `after`
line for the author.

**A pure standard operation that hands a value on after another node** (`{ value, after } -> value`). This needs no
schema change and no engine change. But the waiting node must read something from it, so it cannot help an operation
that accepts nothing, or one whose fields are `static`. The wait shows as a data edge. A reader cannot tell it from a
value the operation needs. It is workaround 2 in a standard form.

**`after` waits for a node to settle, answered or broken.** This would reach the Item 32 (B4) case. But a node would
then run after a broken node without any document saying what breaking means there, and that is `catch`'s job (RFC
0014, G022 to G024). It is left out.

## Open questions

To decide before `accepted`:

- **Does `after` count as a use for G008?** I recommend yes. A node that another node waits for exists for its
  effect, and its answer is not needed. That is the consumer's site 3. The other answer keeps G008 strict: every
  node's *answer* is read. Then site 3 keeps its unused input.
- **Is `after` naming a switch refused (G0n1)?** I recommend yes. Waiting for a switch looks like waiting for a check
  but holds nothing back. The other answer is to allow it as "wait for the decision". I found no case that needs that.
- **Is a redundant `after` refused (G0n2)?** I recommend refusing a direct read only. This is the same reason P005
  refuses an unused `reads` entry: what a document says should be exactly what it does.
- **May a domain graph say `after`?** I recommend yes. "Read nothing before the session is known" is a statement about
  what is done, not about how a call is made, which L012 keeps out of a domain graph. The consumer's site 2 is a
  domain graph.
- **Milestone.** I set none on #857. The change is a compatible addition, so RFC 0008 lets it land before or after
  1.0. No demo of `docs/roadmap.md` needs it. If the maintainer wants it in `schemas-v1` from the start, it belongs
  under M14 with the other schema changes.

To decide during implementation: the exact wording of the G015 hint where the readers sit behind more than one
target, and whether the viewer's panel lists "waited for by" on the waited node as well.
