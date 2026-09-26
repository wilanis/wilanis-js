# RFC 0035: The whole record before the write: a guarded shape is made upstream of the effect, never from it

- **Status:** accepted
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

`update` takes `CustomerUpdate`, not `Customer`: a caller changing who a customer is does not get to change who
registered them or whether the account is open, and the domain graph below is where the partial becomes the whole.
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
twice on one value, once at `customer` and once here, and stays so: both are pure, and the second is what makes
this graph correct under any caller, not only the domain graph above it. Proving it away would make the data
graph's correctness depend on who binds to it, which is the wrong direction for a binding to matter. `kept` is a made site behind the write, as every
read site is: it judges what the store answered, which is the right thing to do with a row the tree did not just
compose.

The refusals an author meets, each on the graph the example ships today:

```
I007  features/customers/data/kept-update.graph.json  nodes/asked/in/changes
      patch writes 'tier', which 'A customer is reachable' (features/customers/domain/a-customer-is-reachable.invariant.json) reads; a rule over the whole record cannot be held on a part of one
      hint: load the record, make the new one with @std/object.port.json#merge in a domain graph, and #put it whole through an operation that takes a Customer

I008  features/customers/data/store-and-latest.graph.json  nodes/stored/in/record
      the Customer written here is composed at the write, so nothing judges it before the store keeps it
      hint: make it in a node -- @std/object.port.json#make with "type": "@customers/domain/Customer.shape.json" -- and give #put "record": "{{<node>}}"

L016  features/customers/data/kept-update.graph.json  nodes/customer
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
| I007 | `check/invariant-writes.ts` | a `run` or `map` node runs `@storage/store.port.json#patch` over a collection whose `of` is a guarded shape, and a key of its `changes` is a field some `holds` invariant on that shape reads (`rootsOf` in `check/prove.ts` over the invariant's `when`). `at` is `nodes/<id>/in/changes`. | `load the record, make the new one with @std/object.port.json#merge in a domain graph, and #put it whole through an operation that takes a <Shape>` |
| I008 | `check/invariant-writes.ts` | a node runs `#put` over a collection whose `of` is a guarded shape and its `record` is written in place -- an object literal, or anything but one whole read of a node or of `in` (`readWhole` in `check/prove.ts`). `at` is `nodes/<id>/in/record`. | `make it in a node -- @std/object.port.json#make with "type": "<Shape>" -- and give #put "record": "{{<node>}}"` |
| L016 | `check/graph.ts` | a data graph holds a made site of a guarded shape (`sitesOf` in `sites.ts`, `kind: 'made'`) and some effectful node of the graph reads that node, directly or through the routing (`readersOf` in `check/graph-routing.ts`). A made site no effect reads -- the `kept` node above, which translates what the store answered -- is not refused. `at` is `nodes/<id>` of the site. | `a data graph translates; make the record in a domain graph and hand it to this one whole, as its in` |

L016 is a refusal, not guidance. The two `I` rules alone put the guard before every write; L016 additionally
holds the making to a domain graph, and its cost is concrete in `register`, where the key comes from `#newKey`, an
effect, so a domain graph that makes the record reaches it through a `nextId` operation. That is one operation per
collection that generates its own keys, and it is the price of the layer meaning what `CLAUDE.md` says it means: a
data graph that composes the business value is the shape that produced this RFC.

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

The second guard, at `in:ok` in `keep-customer`, is a different matter for the rehearsal (#625). Its value is
whatever the caller handed down, so nothing the rehearsal sets can steer it, and on the path through `update` it
judges the value `customer:check` already judged, so it cannot refuse there. `rehearse` follows each input the
guard reads off `in` out through the calls that handed it down; where every one of them is the same field of one
node of an enclosing graph, and that node is a site of the same shape -- a guarded one, read by the ids the compiler
gave it, or a proved one -- both branches are reported as held there, naming the upstream guard, and neither is a
problem:

```
features/customers/data/keep-customer  guard 'in:check' A customer is reachable  2/2 branches
  ok  holds     held upstream by guard 'customer:check' in features/customers/domain/update-customer, which judged this value first
  ok  violated  held upstream by guard 'customer:check' in features/customers/domain/update-customer, which judged this value first
```

This is a statement about one run path, not a proof: the guard stays in the lowered spec, and a caller that hands
the data graph a value no guard judged -- a trigger firing `keep` directly, a field composed on the way -- is
steered through it, or reported as a branch that can never run, as before. Where one path holds the guard and
another runs it, the run is what the report shows. And where the rehearsal steers a guard at a made site, such as
`customer` itself, the value it stands in for `customer:made` is one of the type the `#make` is given, with only the
fields the rule reads changed, so the branch that holds answers and the one that does not reaches
`customer:violated` rather than failing at the next node that reads the value.

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

- **I007 (patch).** The example on `main` today, with the shipped `kept-update.graph.json`, is refused with this
  code and `at: nodes/asked/in/changes` once the rule exists. After the example is rewritten (plan step 1), the
  sabotage is a copy of the example with a data graph patching `tier`; a second case patches `active` and expects
  no refusal, since no invariant reads it.
- **I008 (composed record).** `store-and-latest.graph.json` on `main` today, `record` an object literal. After the
  rewrite, a copy whose `keep-customer` writes `"record": { "id": "{{in.id}}", ... }`; a second case with
  `"record": "{{in}}"` expects none.
- **L016.** A copy with the `#merge` moved from `update-customer` into `keep-customer`; a second case where the
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
2. **I007 and I008**, in `check/invariant-writes.ts`, with their sabotage tests. The example is the fixture.
3. **L016** in `check/graph.ts`, with its sabotage test.
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

Steps 2 and 3 need 1. Step 4 needs nothing. Step 1 needs step 4, and #625 for the rehearsal over the guard it
moves upstream. Step 5 needs 1 for the example it shows. Step 6 is last.

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

Decided at acceptance, each in the text above: L016 is a refusal and not guidance ("Checker rules"); `update`
accepts `CustomerUpdate` and not `Customer` ("Guide-level explanation"); a taken site fed only by a guarded made
site stays guarded ("Guide-level explanation", at `keep-customer`).

Decided during implementation: the three codes; the names `keep` and `nextId`; whether `--read-then patch` stays
in the scaffold for a collection no invariant reads or goes altogether; and the exact wording of the three hints.

## Decided during implementation

1. **Step 4 precedes step 1.** B005 (`acceptsFitGraph` in `check/bindings.ts`) compares an operation's
   accepts with a graph's `in` as two object types, field by field. Written as fields, `keep: { customer:
   Customer }` bound to a graph whose `in` is `Customer` is refused: `Customer` has no field `customer`, and
   the `id` it requires is not one `keep` accepts. The one-field-whole form (`wholeFitsGraph`) reaches only a
   graph whose `in` is not a shape. Once `accepts` may name `Customer`, the shape's type is what B005 compares,
   the record is taken whole, and the shape is stated once, so the rewrite in step 1 is written against it.
   The comparison is structural, as it is for fields: `CustomerUpdate` fits a graph whose `in` is `Customer`,
   since every field `Customer` adds is optional, so the sabotage test binds `update` to a graph whose `in`
   is `CustomerRecord`, which requires `registrar`. (Step 1 makes `CustomerRecord` what the REST API is sent,
   whose `registrar` is as optional as `Customer`'s, and the case moves to `TierLatest`, which requires
   `customer`.)
2. **An `accepts` string that names no shape is R001.** The schema's alternative is `typeRef`, which also admits
   `string` or `Customer.shape.json[]`; only a shape has fields to give one by one, so `Judge.acceptsTypeAt`
   refuses any other type at `operations/<op>/accepts` under the code an unresolved type already takes. No code
   is added.
3. **The two `I` rules are I007 and I008, and read only what the document shows.** They run from
   `judgeInvariants` in `checker.ts`, right after `checkInvariantSites`. The fields an invariant reads are
   `guardRoots` in `guard.ts`, the lowering's own reading of the rule, over `rootsOf` in `check/judge.ts`, where it
   lives rather than in `prove.ts`. I007 finds the fields a `changes` names where it is written out, by its keys,
   and where it is one read of `in`, by the fields of that read's type, typed off the graph's `in`; a read
   of anything else names no field the checker can see and is not refused. I008's message names the invariant, as
   I007's does, since the rule is non-local. Its hint sends the making to a domain graph and the write to
   `"record": "{{in}}"`, not to a node beside the write as the table has it: a data graph that makes the guarded
   record on its way to an effect is what L016 refuses, so a hint pointing there would trade one refusal for the
   next. The rule itself accepts one whole read of any node, as the table says. A `map` that binds each element to
   `#put` as `record`, or to `#patch` as `changes`, is not judged: this RFC says what a record read from `in` or a
   node is, and not what an element of a list read from one is. That write path, and the others these rules do
   not see, are #682.
4. **`--read-then patch` goes altogether, not only for a collection an invariant reads.** Kept for the rest, the
   scaffold would have to say which collections those are, and it cannot say what I007 says: I007 refuses a patch
   by the fields its `changes` names, and those fields are exactly what the scaffold leaves TODO. It would refuse a
   patch of `active` that the checker takes, or take one the checker then refuses, and a tool that judges what a
   rule judges is that rule written twice. A collection no invariant reads today is also one an invariant added in
   `domain/` reads tomorrow, and then every graph the scaffold patched with is refused and rewritten as the pair;
   the scaffold is what an author copies, which is how the example came to patch. What goes is small: a patch of a
   field no invariant reads is one node, written against the store port's own description of `#patch`, which stays
   on the port. `--read-then patch` is refused with the two flags that write the pair, and so is a `--read-then`
   that names no write, where before it fell back to a patch. The read-decide-write form keeps `put` and `remove`,
   and its `put` writes `"record": "{{in}}"`, the one record I008 takes that step 3's rule will not also refuse.
   `--store` with `--collection` and no `--read-then` writes the data half, whose ids are `keep-customer`'s
   (`stored`, `outcome`, `kept`, `repeated`, `nothingWritten`). `--port` writes the domain half, reading through
   `--read` and handing to `--write`, `get` and `keep` unless they say, with the ids `update-customer` has
   (`current`, the shape's noun, `kept`); it gives the write the shape's fields one by one, as a call to an
   operation whose `accepts` names a shape gives them (entry 1), and not `{ "customer": "{{customer}}" }` as the
   guide-level text shows. The scaffold's tests are `scaffold-graph.test.ts` and `scaffold-keep.test.ts`, beside
   the module, where `demo.test.ts` was named above: that one runs `docs/demo.md`'s beats, and none scaffolds a graph.
5. **L016 lives in `check/graph-making.ts`, walks the dataflow, and leaves read sites alone.** `check/graph.ts` is at
   its length limit, and the rule is a walk over each guarded shape's sites (`sitesOf`, with `heldShapes` and
   `invariantsOn` from `guard.ts`), so it runs once over the tree from `judgeUses` in `checker.ts`, after every graph
   is judged, rather than per graph. An effectful node is one whose operation does not declare `pure: true`, the test
   G015 makes; a data graph runs no domain operation (L002), so these are native effects. "Directly or through the
   routing" is read as through the dataflow: the effect reads the site, or reads a node that reads it, walked over
   `readersOf` the graph's read table, and the message names the nodes between. A switch that decides on the value
   and routes an effect reads it and acts on nothing, so it feeds nothing on. The table's letter would refuse any
   made site an effect reads, but "What the rules do not refuse, on purpose" ends with "every read site", and this is
   the one rule that could refuse one. So a made site that only re-types what an effect answered is not refused,
   whatever reads it: the node is itself an effect (a `#find`), or its whole value is one read of an effect's answer
   (a `#make` of `{{stored.record}}`, read through `siteRead` in `prove.ts`, which reads no `map`'s bind, so a `map`
   of makes over an effect's answer is refused where one `#make` of it is not: #694). A read site composes nothing,
   so the hint would have nothing to move, and the guard stands at the site before any reader either way. A `#merge`
   over what was read, or a value written out in place, is composed. No graph in this repository is a read site an
   effect reads, so the example checks clean with or without the exemption, which is one function (`readSite`) to
   take out if "every read site" meant less. The message says "and the effect 'stored' reads it", not "writes it",
   since the effect need not be a write, and names the invariant's file, as I007's and I008's do. The sabotage moves
   the `#merge` into a planted `kept-update.graph.json` that the store binding meets `update` with, the graph the
   Motivation describes, rather than into `keep-customer`, whose `in` a `CustomerUpdate` would put at odds with
   `keep` (B005). Of #682's paths, L016 refuses a `map` writing elements it made as the guarded shape, and a
   `changes` read from a node that made the guarded shape; it does not reach a `changes` made as `CustomerUpdate`, a
   `map` over a list that is no site, a binding's delegation, or a wider `in`, which stay #682's.
6. **I007 and I008 hold on every write path (#682).** I007 types a `changes` that is one whole read of `in`, a
   constant or a node with the checker's own `GraphReads`, over the graph's input, constants and node answers, the
   table G004 types a node's inputs by; it is built quietly, so what does not resolve names no field and is refused
   where the graph is judged, and a resolver's read, which answers no record, is not typed. A `map` binding `changes`
   is typed off the element of the list its `over` reads, at the path it binds. I008 accepts a record given as one
   whole read only where the read is a site of the shape in that graph (`sitesOf`, one value: `in` where it is the
   shape, or a node that makes one), and a record a `map` binds only where it is each element whole of one whole read
   of a site that holds a list of the shape. Its message says where the record came from: composed at the write, read
   from a path that is no site of it, or each element of a list that is none. A binding's delegation straight to
   `#put` or `#patch` is judged in `check/invariant-writes.ts`, not `check/bindings.ts`: it is this rule over another
   kind of call, and `bindings.ts` is the B family's. Its inputs are what `passedInputs` hands the store, as the
   compiler and B005 read them, typed off what the operation accepts, as `bindings.ts` types a delegation's reads of
   `in`. A binding holds no site, so every delegation of a guarded `#put` is refused, and the hint names the data
   graph that would be one. Its `at` is `operations/<op>/in/<input>`, or `operations/<op>/run` where the input passes
   on by name.
