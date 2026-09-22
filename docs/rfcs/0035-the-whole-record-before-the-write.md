# RFC 0035: The whole record before the write: a guarded shape is made upstream of the effect, never from it

- **Status:** draft
- **Areas:** `area:core` (one alternative on `accepts` in `port.schema.json`; `Operation.accepts` in `model.ts`),
  `area:compiler` (two `I` rules, one `L` rule, `B005` and `acceptsType` reading a shape), `area:runtime`
  (`describe`, the graph scaffold, the template's guidance), `area:view` (the port page reads a shape). Nothing in
  the engine, nothing in the storage plugin or its engines.
- **Tracking issue:** #536
- **Depends on:** RFC 0007 (invariants: the guard this RFC leaves where it is, and the sites it reasons over), RFC
  0002 and RFC 0003 (storage: `put`, `patch`, and the declaration a `changes` is judged against). It supersedes RFC
  0033, which laid out three ways to move or compensate the guard and chose none; that RFC is withdrawn when this
  one is accepted.

## Summary

A write of a record whose shape a field invariant reads takes the whole record, and the record is made where the
compiler can judge it before the effect runs. Three rules. A port operation's `accepts` may name a shape, so an
operation that takes a customer says so once instead of spelling its fields in three documents. A `#patch` whose
`changes` name a field a field invariant reads is refused, and a `#put` whose record is composed in place at the
write is refused, so the record reaches the write from a node or from `in`, which is a site RFC 0007 already
guards, upstream of the effect. And a data graph may not make a value of a guarded shape that feeds an effect, so
the making is a domain graph's. Nothing is added to the guard: it stands where it stood, and the write is
downstream of it.

## Motivation

`Customer.shape.json` in `example/` carries the field invariant *A customer is reachable*:
`len(name) > 0 && len(email) > 0 && (tier != 'gold' || has(note))`. RFC 0007 promised that a rule stated once is
held everywhere a value of the shape is made or taken, with a guard the compiler lowers where it cannot prove the
rule from the documents. That promise is kept to the letter and broken in effect by the graph the example itself
ships behind `customer.port.json#update`:

```
nodes:
    asked      @storage/store.port.json#patch          ← the row is committed here
    route      switch → row:made | missing
    row:made   @std/object.port.json#make
    guard for 'A customer is reachable':
        row:check     switch → row | row:violated      ← the rule is judged here
        row           answers row:made
        row:violated  refuses 'invariant'
    missing    @std/outcome.port.json#refuse
```

That is `wilanis describe` on `kept-update.graph.json`, node order as the kernel runs it. `PUT /customers/7` with
`{ "tier": "gold" }` and no note: `asked` patches the row and the database autocommits, since the graph is not
`atomic`; `row:made` turns what came back into a `Customer`; `row:check` finds the rule false; `row:violated`
answers `invariant`, and the trigger maps it to 500. The caller gets a refusal. The store keeps a gold customer
with no note. Every later `get` of that customer is guarded and refuses; every `find` that lists it is guarded
element by element and refuses the whole list, for every caller, until someone edits the database by hand.

The guard did what RFC 0007 said. It stands at the first node whose answer is a `Customer`, and in this graph the
first such node consumes the result of the write. There is no `Customer` above `asked` for the compiler to put
the guard in front of. The graph never holds a customer until it has already stored one.

How the graph came to be shaped that way is the finding, not the guard. `update` accepts four loose fields; the
trigger's input is `UpdateRequest`, the body `UpdateBody`, the graph's input `CustomerUpdate`, three shapes for
the same four fields and none of them `Customer`; and `#patch` takes `changes: unknown`, a bag of some fields, so
the graph reaches a collection of `Customer` without holding one. The store declares its records are `Customer`.
The write path never had one. RFC 0033's evidence stands: three unsupervised agents given the example wrote this
graph, because it is the graph the example teaches and the graph `wilanis new graph --read-then patch` scaffolds.

A partial write is the only thing that can break a rule over a whole value. `changes` cannot remove a required
field, and RFC 0003 already judges each change against the declaration, so a patch cannot write a wrong type or
an enum value the shape does not allow. What a patch can do is set one field so that a rule over several no
longer holds, and no rule that is about one field at a time can see that coming. So the rule this RFC states is
narrow and complete: where a field invariant reads a field, that field is written as part of the whole record,
and the whole record is made where the compiler can guard it.

What this RFC does not do. It does not move the guard or add a second one; RFC 0007's four ids stay the contract
the rehearsal, `describe` and the viewer read. It does not make `put` transactional or force graphs `atomic`. It
does not remove `patch`: a collection no invariant reads keeps it. It does not judge a value another system wrote
into the store; a read site stays guarded, and refusing what came back is the right treatment of data the tree
did not write. It does not add a version or an expected value to `put`, so two concurrent updates replace each
other's whole record where before they replaced each other's fields; that is a rule about concurrency and its own
RFC. It does not touch access invariants.

## Guide-level explanation

Three words. A **guarded shape** is a core shape some `holds` invariant is `on`. A **guarded field** is a field the
invariant's `when` reads: `name`, `email`, `tier` and `note` for *A customer is reachable*. A **write** is `#put`
or `#patch` of `@storage/store.port.json` over a collection whose `of` is a guarded shape.

The rule an author meets: **a guarded field is never patched, and a guarded record is never assembled at the
write.** The record that a write stores is a value some node made, or the graph's `in`, and it is made in a domain
graph. The compiler then guards it where it is made, before the write reads it, by the rule RFC 0007 already has.

Here is `customer.update` in the example after this RFC. The trigger is unchanged: `PUT /customers/{id}` fires
`customer.port.json#update` with `id`, `name`, `email` and `tier` from the request. The port says what the
operation takes by naming the shape, once:

```json
"update": {
  "description": "Replace who one customer is. Fails when there is no such customer.",
  "accepts": "@customers/domain/CustomerUpdate.shape.json",
  "returns": "@customers/domain/Customer.shape.json"
},
"keep": {
  "description": "Keep one customer as given, the whole record. Fails as repeated when another holds the address.",
  "accepts": { "customer": { "type": "@customers/domain/Customer.shape.json" } },
  "returns": "@customers/domain/Customer.shape.json"
}
```

`CustomerUpdate` gains `"note": { "type": "string", "required": false }`, so a caller moving a customer to gold
can say why. `UpdateBody` and `UpdateRequest` stay: they are the world's shapes, and T001 holds a trigger's `settings`
to edge shapes. What goes is the port spelling the same fields a third time; `update` now names the core shape the
trigger translates into, and T002 judges the edge shape against it field for field as it does today.

`update` is bound to a domain graph, because deciding who a customer now is is business:

```json
{
  "$schema": "https://raw.githubusercontent.com/wilanis/wilanis-js/main/packages/core/schemas/graph.schema.json",
  "label": "Update a customer",
  "description": "Load the customer, lay the change over them, and keep the result. The invariant over Customer is judged on 'customer', before anything is written.",
  "in": "@customers/domain/CustomerUpdate.shape.json",
  "out": { "type": "@customers/domain/Customer.shape.json", "from": "kept" },
  "nodes": [
    { "type": "@wilanis/node/run.schema.json", "id": "current", "label": "The customer as kept",
      "run": "@customers/domain/customer.port.json#get", "in": { "id": "{{in.id}}" } },
    { "type": "@wilanis/node/run.schema.json", "id": "customer", "label": "Who they now are",
      "run": "@std/object.port.json#merge",
      "in": { "base": "{{current}}", "over": "{{in}}", "type": "@customers/domain/Customer.shape.json" } },
    { "type": "@wilanis/node/run.schema.json", "id": "kept", "label": "Kept",
      "run": "@customers/domain/customer.port.json#keep", "in": { "customer": "{{customer}}" } }
  ]
}
```

`current` refuses `missing` where there is no such customer, as `#get` does today, and the trigger maps it to 404
as it does today. `customer` is where a `Customer` comes into being, so it is the site: `wilanis describe` prints
the guard there, `customer:check` between `customer:made` and `kept`, and `kept` never runs when
`customer:violated` answers. A note the caller did not send stays whatever it was, since `over` lays only the
fields it has.

`keep` is bound to a data graph whose input is the whole record:

```json
{
  "$schema": "https://raw.githubusercontent.com/wilanis/wilanis-js/main/packages/core/schemas/graph.schema.json",
  "label": "Keep a customer",
  "description": "Data graph behind customer.keep under the local profile: write the record whole. The value arrived judged; what this graph adds is the store.",
  "in": "@customers/domain/Customer.shape.json",
  "out": { "type": "@customers/domain/Customer.shape.json", "from": ["kept", "repeated"] },
  "nodes": [
    { "type": "@wilanis/node/run.schema.json", "id": "stored", "label": "Write the record",
      "run": "@storage/store.port.json#put",
      "in": { "store": "@customers/data/customers.store.json", "collection": "customers", "record": "{{in}}" } },
    { "type": "@wilanis/node/switch.schema.json", "id": "outcome", "label": "Did the store take it?",
      "in": { "record": "{{stored.record}}" },
      "rules": [{ "when": "has(record)", "to": "kept" }], "else": "repeated" },
    { "type": "@wilanis/node/run.schema.json", "id": "kept", "label": "The record as kept",
      "run": "@std/object.port.json#make",
      "in": { "value": "{{stored.record}}", "type": "@customers/domain/Customer.shape.json" } },
    { "type": "@wilanis/node/run.schema.json", "id": "repeated", "label": "Another customer holds that address",
      "run": "@std/outcome.port.json#refuse",
      "in": { "reason": "repeated", "message": "{{stored.violated}}", "type": "@customers/domain/Customer.shape.json" } }
  ]
}
```

`record: "{{in}}"` is a whole read of a taken site, guarded at `in:ok` by RFC 0007's decision 4. The guard runs
twice on one value, once at `customer` and once here; both are pure, and the second is what makes this graph
correct under any caller, not only the domain graph above it. `kept` is a made site behind the write, as every
read site is: it judges what the store answered, which is the right thing to do with a row the tree did not just
compose.

The refusals an author meets, each on the graph the example ships today:

```
I0nn  features/customers/data/kept-update.graph.json  nodes/asked/in/changes
      patch writes 'tier', which 'A customer is reachable' (features/customers/domain/a-customer-is-reachable.invariant.json) reads; a rule over the whole record cannot be held on a part of one
      hint: load the record, make the new one with @std/object.port.json#merge in a domain graph, and #put it whole through an operation that takes a Customer

I0nn  features/customers/data/store-and-latest.graph.json  nodes/stored/in/record
      the Customer written here is composed at the write, so nothing judges it before the store keeps it
      hint: make it in a node -- @std/object.port.json#make with "type": "@customers/domain/Customer.shape.json" -- and give #put "record": "{{<node>}}"

L0nn  features/customers/data/kept-update.graph.json  nodes/customer
      data graph makes a Customer, which 'A customer is reachable' guards, and 'stored' writes it
      hint: a data graph translates; make the record in a domain graph and hand it to this one whole, as its in
```

The hint names the invariant, because the rule is non-local: an invariant added in `domain/` refuses a data graph
elsewhere, and a refusal that does not say which rule it is holding the graph to reads as the checker being
arbitrary.

## Reference

### Documents and schemas

**`accepts` may name a shape.** `port.schema.json`'s operation `accepts` becomes `oneOf` the existing
`common.schema.json#/$defs/fields` and `#/$defs/typeRef`. `Operation.accepts` in `packages/core/src/model.ts`
widens to `Fields | string`. Its meaning is the shape's fields: a call site gives them under `in` one by one
exactly as it gives fields today, and `Judge.acceptsType` in `check/judge.ts` answers the shape's type where it
answered `{ fields: accepts }`. B005 in `check/bindings.ts` (`acceptsFitGraph`) compares that type to the graph's
`in` as it compares an object type today; the one-field-whole form (`wholeFitsGraph`) is unchanged and is how
`keep` takes a `Customer`. The row for `port` in `packages/runtime/templates/CLAUDE.md` says both forms. `wilanis
new port` scaffolds fields, as today. No document kind is added and no layer changes.

### Ports, operations and kinds granted

None. `@storage/store.port.json` is unchanged: `put` takes `record: $T`, `patch` takes `changes: unknown`, and a
collection no invariant reads uses both as before.

### Checker rules

Numbers are assigned when the implementing pull request lands. The two `I` rules live in a module of their own,
`check/invariant-writes.ts`, beside `invariant-holds.ts`, and run from `judgeTree` after `checkInvariantSites`,
since they need the sites and the invariants resolved. The `L` rule lives in `check/graph.ts` beside L002, since
it is a rule about what a layer may do.

| Code | Where it lives | Refuses when | Hint |
|---|---|---|---|
| I0nn | `check/invariant-writes.ts` | a `run` or `map` node runs `@storage/store.port.json#patch` over a collection whose `of` is a guarded shape, and a key of its `changes` is a field some `holds` invariant on that shape reads (`rootsOf` in `check/prove.ts` over the invariant's `when`). `at` is `nodes/<id>/in/changes`. | `load the record, make the new one with @std/object.port.json#merge in a domain graph, and #put it whole through an operation that takes a <Shape>` |
| I0nn | `check/invariant-writes.ts` | a node runs `#put` over a collection whose `of` is a guarded shape and its `record` is written in place -- an object literal, or anything but one whole read of a node or of `in` (`readWhole` in `check/prove.ts`). `at` is `nodes/<id>/in/record`. | `make it in a node -- @std/object.port.json#make with "type": "<Shape>" -- and give #put "record": "{{<node>}}"` |
| L0nn | `check/graph.ts` | a data graph holds a made site of a guarded shape (`sitesOf` in `sites.ts`, `kind: 'made'`) and some effectful node of the graph reads that node, directly or through the routing (`readersOf` in `check/graph-routing.ts`). A made site no effect reads -- the `kept` node above, which translates what the store answered -- is not refused. `at` is `nodes/<id>` of the site. | `a data graph translates; make the record in a domain graph and hand it to this one whole, as its in` |

What the rules do not refuse, on purpose: a `#patch` of an unguarded field of a guarded shape (`active` on
`Customer`, which no invariant reads); a `#put` with `record: "{{in}}"` or `record: "{{customer}}"`; a domain graph
that makes the record from `#merge` or `#make`; and every read site.

What each rule reads is already in hand. The collection's shape comes from the `$T` the store field `resolves`,
which G004 uses to type `record` today. The invariants on a shape and the fields they read are what
`checkInvariantSites` and `heldAt` walk. Whether a `record` is one whole read is `readWhole`. Which nodes read a
node is the routing every G rule is judged over.

### Runtime behaviour

None in the engine, the handlers or the storage plugin. A run report of `update` shows `customer:check` before
`stored`, so a refusal is a graph that never reached its write, where today it is one that reached it and then
refused. `rehearse` reports the guard on `customer` as it reports every guard; it cannot see the difference, and
does not need to, since the difference is now in the documents rather than in what the effect did.

### Discoverability

`wilanis describe <port>` prints `takes @customers/domain/CustomerUpdate.shape.json` for an operation whose
`accepts` names a shape, where it prints the fields today, and the viewer's port page (`renderDocPage` in
`client/index.html`, the `fieldsTable` at the operation) links the shape instead of tabling its fields. `describe
<graph>` on `update-customer` shows the guard on `customer`, upstream of `kept`, which is the whole story in one
listing. A refusal from the three rules names the invariant and the field, as shown above.

### Plugin contract

None.

## Compatibility

`port.schema.json` changes additively: `accepts` written as fields validates as before and means what it meant.
Every other schema is unchanged. Three refusals are new, so a tree that patches a guarded field, composes a
guarded record at its write, or makes one in a data graph on the way to an effect is refused after this and was
not before; each hint names the edit, and the shipped example is the sabotage case for all three. Until 1.0 the
schema edits in place (RFC 0008); the pull request that changes the schema waits for the maintainer's approval in
the `decision` job.

## Tests

Every rule is exercised through the example in `packages/runtime/test/example.test.ts`, as the compiler's rules
are:

- **I0nn (patch).** The example on `main` today, with the shipped `kept-update.graph.json`, is refused with this
  code and `at: nodes/asked/in/changes` once the rule exists. After the example is rewritten (plan step 1), the
  sabotage is a copy of the example with a data graph patching `tier`; a second case patches `active` and expects
  no refusal, since no invariant reads it.
- **I0nn (composed record).** `store-and-latest.graph.json` on `main` today, `record` an object literal. After the
  rewrite, a copy whose `keep-customer` writes `"record": { "id": "{{in.id}}", ... }`; a second case with
  `"record": "{{in}}"` expects none.
- **L0nn.** A copy with the `#merge` moved from `update-customer` into `keep-customer`; a second case where the
  data graph's made site is behind the write (`kept`) expects none.
- **B005 with a shape.** `update` accepting `CustomerUpdate` bound to a graph whose `in` is `Customer` is refused
  as today's mismatch is; bound to `update-customer` it is not.
- **The example checks clean and runs.** The end-to-end test of `PUT /customers/{id}` moving a customer to gold
  without a note expects 500 `invariant` and, read back, the customer unchanged, on both engines. That is the
  test RFC 0033's motivation lacked, and it is the one that fails on `main` today.
- **The scaffold.** `packages/runtime/test/demo.test.ts` expects the load-make-keep pair and no `#patch`.
- **`describe`.** `takes <shape>` for an operation whose `accepts` names one.

The storage suite is untouched: `patch` is still what it was, and the engines are held to nothing new.

## Implementation plan

1. **Rewrite the example's write paths to the shape this RFC teaches.** `update` bound to `update-customer`
   (domain), `keep` bound to `keep-customer` and `keep-customer-postgres` (data); `register` made whole in
   `register-customer` (domain) from a `nextId` operation and `#make`, `store-and-latest` taking the `Customer` as
   its `in`; `CustomerUpdate` gains `note`, and `UpdateBody` with it. Checks clean under today's
   rules, and the end-to-end gold-without-a-note test is added and passes. Node ids named for what they hold.
2. **I0nn twice**, in `check/invariant-writes.ts`, with their sabotage tests. The example is the fixture.
3. **L0nn** in `check/graph.ts`, with its sabotage test.
4. **`accepts` names a shape**: schema, `model.ts`, `acceptsType`, B005, `describe`, the viewer; `update` in the
   example written that way. This is the schema change and waits in `decision`.
5. **The scaffold and the guidance.** `graphScaffold` in `packages/runtime/src/scaffold-graph.ts` drops
   `--read-then patch` and writes the load-make-keep pair (a domain graph over `--port`, a data graph over
   `--store`) with ids named for what they hold; the `graph` and `invariant` rows and the field-invariant bullet
   under "Rules you will meet" in `packages/runtime/templates/CLAUDE.md`, and the "Invariants are stated once"
   section of `docs/model.md`, say the rule instead of the workaround. `good first issue` for the two documents,
   not for the scaffold.
6. **The record.** RFC 0033 to `withdrawn` with one line pointing here; RFC 0007's "Decided during
   implementation" gains entry 8: a guarded shape is written whole and made upstream of the write, so a site is
   never downstream of the effect that stores its value; `docs/rfcs/README.md` rows for both.

Steps 2 and 3 need 1. Step 4 needs nothing. Step 5 needs 1 for the example it shows. Step 6 is last.

## Drawbacks and alternatives

**What it costs.** An update is a read and a write where it was one statement: two round trips on the postgres
engine, one extra `get` on the memory engine. A write graph is a domain graph and a data graph where it was one
data graph, and a collection whose keys the store generates needs one more operation (`nextId`) so the domain
graph can make the record with its key. Two concurrent updates replace each other's whole record. And a
collection with an invariant and one without are written two different ways, which an author has to know; the
refusal that names the invariant is what makes it knowable from the tree.

**RFC 0033 (a): guard the write's input.** Exact for `put`, whose `record` is already `$T`; for `patch` it teaches
the compiler what a storage patch means, cannot reach a computed key or a record read in another graph, and
judges a row a concurrent writer may have changed. This RFC takes the `put` half by making the record a node the
existing guard covers, and refuses the `patch` half instead of predicting it.

**RFC 0033 (b): force `atomic`.** Closes every shape of the hole by rolling the write back. The row is written and
undone on every refusal, every such graph is a transaction, an engine whose `begin` answers nothing fails at run
time only, and the graph still never held the value it wrote. This RFC makes the write downstream of the judgement
instead of undoable after it.

**RFC 0033 (c): both.** Two mechanisms for one rule, and a refusal whose presence depends on whether a composition
succeeded, which an author cannot see from their documents.

**Remove `patch` from the store port.** Considered, and the cleanest contract: a write is always whole. Not taken
because a collection no invariant reads loses nothing by a patch and gains one statement over two, and because
it is a storage contract change across both engines and the shared suite for a case the two `I` rules already
cover. It stays available as a later tightening if two ways of writing prove confusing.

**Declare the invariant on the store.** A collection saying which invariants its records satisfy, so every write
into it is a site. For `patch` it still needs the whole record, so it collapses into this RFC with a second
document to keep in sync. Not taken.

**Document the hole and stop.** What #535 proposes, and true as far as it goes. Its price is that
every author remembers the rule in every write graph, which is the five coincidences and a piece of luck RFC 0007
set out to end.

## Open questions

Before `accepted`:

1. **Whether L0nn is a refusal or guidance.** The two `I` rules alone put the guard before every write; L0nn
   additionally says the making is a domain graph's. Its cost is concrete in `register`: the key comes from
   `#newKey`, an effect, so a domain graph that makes the record needs a `nextId` operation to reach it through.
   Recommendation: a refusal. A data graph that composes the business value is the shape that produced this RFC,
   and one extra operation per key-generating collection is the price of the layer meaning what `CLAUDE.md` says
   it means.
2. **What `update` accepts.** `CustomerUpdate` with an optional `note` (the domain graph merges it over the kept
   record), or `Customer` whole (the caller sends everything, `registrar` and `active` included). Recommendation:
   `CustomerUpdate`. A caller changing who a customer is should not be able to change who registered them.
3. **Whether a taken site fed only by a guarded made site stays guarded.** RFC 0007's decision 4 says a taken site
   is always guarded, so `keep-customer` judges the rule a second time on a value `update-customer` already judged.
   Recommendation: leave it. The data graph is correct under any caller, the guard is pure, and proving it away
   would make the data graph's correctness depend on who binds to it.

During implementation: the three codes; the names `keep` and `nextId`; whether `--read-then patch` stays in the
scaffold for a collection no invariant reads or goes altogether; and the exact wording of the three hints.
