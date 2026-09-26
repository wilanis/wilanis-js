---
name: wilanis-graphs
description: How a wilanis graph runs and how to shape one. Load it when writing a graph, adding a switch, reading, changing or removing a record through a store (a change is load, make, keep, never a patch of a field a rule reads), or when `wilanis check` refuses with G004, G008, G009, I007, I008 or L016.
---

# Writing a graph

## The rule that decides everything

A graph is dataflow, not control flow. A node runs when every input it reads is ready, whatever any switch
chose. A switch chooses who answers, not who runs: the only node a switch holds back is the one its rule
names as `to`. So an effect only one branch needs must be that switch's `to`, or it runs on every branch.
Two `#remove` nodes written beside a switch, each reading only `{{in.id}}`, both run on every call, and the
switch decides nothing but which answer is forwarded.

Branches are joined at `out.from`, and only there: a list of candidates, one per branch, the first that
settled answers. Never join two nodes' answers in one template with `||`: `{{pin.record || unpin.record}}`
is one read of two values that are never both there, and the checker refuses it.

When you need a shape, do not invent it. Find the nearest graph in the tree and copy it: `wilanis ls graph`
lists them, `wilanis describe <path>` lays one out node by node. A graph over a store already exists in
almost every tree.

## Changing a record: load, make, keep

A record whose shape a `holds` invariant is on is written whole, and made before the write;
`wilanis describe <the shape>` says `held to` for each such rule. Three refusals hold a write to it. A `#patch`
whose `changes` name a field the rule reads is I007, since a rule over the whole record cannot be held on a part of
one. A `#put` whose `record` is written out at the write, instead of read whole from `in` or from a node, is I008,
since nothing judges it before the store keeps it. A data graph that makes a value of the shape and hands it to an
effect is L016, since making the record is the domain's and a data graph translates. So a change is two graphs, and
the compiler guards the record where the first one makes it, before the second writes anything.

1. A domain graph loads the record through the port's read (`current`). The example's `get` refuses `missing`
   where there is no such customer, and nothing below it runs.
2. It lays the change over what it loaded with `@std/object.port.json#merge` into the shape (`customer`). That is
   where the value is made, so the guard the compiler lowers stands there: `wilanis describe` prints
   `customer:check` between `customer:made` and `kept`, and a change the rule forbids is refused before anything
   is written. A field the change does not carry stays what it was, since `over` lays only the fields it has.
3. It hands the result whole to the port's write (`kept`). An operation whose `accepts` names the shape takes its
   fields one by one, each read off the merge.
4. The binding meets that write with a data graph whose `in` is the shape, and whose one write is `#put` with
   `"record": "{{in}}"` (`stored`). The record is read whole from `in`, where the compiler guards it again, so the
   data graph holds whoever calls it.
5. A switch on what the store answered (`outcome`): `violated` where a `unique` the store declares stopped the
   write, `record` where it kept one.
6. A `make` of what the store answered (`kept`) and a `refuse` for each other outcome (`repeated`,
   `nothingWritten`), all under `out.from`. `kept` makes a value of the shape, but from an effect's answer and read
   by no effect, which L016 leaves alone.

`wilanis new graph` writes each half, with `TODO` where a value goes:

```
wilanis new graph features/customers/update-customer --port @customers/domain/customer.port.json
wilanis new graph features/customers/keep-customer --store @customers/data/customers.store.json --collection customers
```

The example tree keeps this pair as `update-customer` and `keep-customer`, behind `customer.port.json#update` and
`#keep`, over the store `@customers/data/customers.store.json` (collection `customers`, of
`@customers/domain/Customer.shape.json`, keyed by `id`). Run where those two are not yet written, the commands
write the graphs below, here with the domain half's `in` set to the change `update` takes
(`@customers/domain/CustomerUpdate.shape.json`) and `TODO.` taken off each description. In place of the example's
own, both check clean.

```json
{
  "$schema": "https://raw.githubusercontent.com/wilanis/wilanis-js/main/packages/core/schemas/graph.schema.json",
  "description": "Load the customer, lay the change over it, and keep the result whole. The customer is made at 'customer', before anything is written, so an invariant over its shape is judged there and 'kept' never runs when it does not hold.",
  "in": "@customers/domain/CustomerUpdate.shape.json",
  "out": { "type": "@customers/domain/Customer.shape.json", "from": "kept" },
  "nodes": [
    { "type": "@wilanis/node/run.schema.json", "id": "current", "label": "The customer as kept",
      "run": "@customers/domain/customer.port.json#get", "in": { "id": "{{in.id}}" } },
    { "type": "@wilanis/node/run.schema.json", "id": "customer", "label": "What the customer now is",
      "run": "@std/object.port.json#merge",
      "in": { "base": "{{current}}", "over": "{{in}}", "type": "@customers/domain/Customer.shape.json" } },
    { "type": "@wilanis/node/run.schema.json", "id": "kept", "label": "Keep it whole",
      "run": "@customers/domain/customer.port.json#keep",
      "in": { "id": "{{customer.id}}", "name": "{{customer.name}}", "email": "{{customer.email}}",
              "tier": "{{customer.tier}}", "registrar": "{{customer.registrar}}",
              "active": "{{customer.active}}", "note": "{{customer.note}}" } }
  ]
}
```

```json
{
  "$schema": "https://raw.githubusercontent.com/wilanis/wilanis-js/main/packages/core/schemas/graph.schema.json",
  "description": "Keep one customer as given, the whole record: it arrives made, as in, and is judged there before the write.",
  "in": "@customers/domain/Customer.shape.json",
  "out": { "type": "@customers/domain/Customer.shape.json", "from": ["kept", "repeated", "nothingWritten"] },
  "nodes": [
    { "type": "@wilanis/node/run.schema.json", "id": "stored", "label": "Write the customer",
      "run": "@storage/store.port.json#put",
      "in": { "store": "@customers/data/customers.store.json", "collection": "customers", "record": "{{in}}" } },
    { "type": "@wilanis/node/switch.schema.json", "id": "outcome", "label": "Was it written, or did a constraint stop it?",
      "in": { "record": "{{stored.record}}", "violated": "{{stored.violated}}" },
      "rules": [{ "when": "has(violated)", "to": "repeated" }, { "when": "has(record)", "to": "kept" }],
      "else": "nothingWritten" },
    { "type": "@wilanis/node/run.schema.json", "id": "kept", "label": "The customer as kept",
      "run": "@std/object.port.json#make",
      "in": { "value": "{{stored.record}}", "type": "@customers/domain/Customer.shape.json" } },
    { "type": "@wilanis/node/run.schema.json", "id": "repeated", "label": "A constraint the store declares stopped it",
      "run": "@std/outcome.port.json#refuse",
      "in": { "reason": "conflict", "message": "another record holds what the store keeps unique ({{stored.violated}})",
              "type": "@customers/domain/Customer.shape.json" } },
    { "type": "@wilanis/node/run.schema.json", "id": "nothingWritten", "label": "Nothing was written",
      "run": "@std/outcome.port.json#refuse",
      "in": { "reason": "upstream", "message": "the store answered no record for {{in.id}}",
              "type": "@customers/domain/Customer.shape.json" } }
  ]
}
```

`#patch` stays for a field no rule reads. `active` on `Customer` is one, since *A customer is reachable* does not
read it, so a data graph may set it with one `#patch` node, written by hand against the store port
(`wilanis describe @storage/store.port.json`). No scaffold writes a patch, and a rule added later that reads the
field turns that node into an I007.

## Read, decide, write

When whether to write depends on what is kept (remove a customer only once their account is closed), a data
graph reads the record, decides on what it read, and writes on the branch that wants the write. Every step is a
node, and every branch that writes has its own write, its own check of the write's answer, and its own refusal.

1. `#get` the record by key.
2. A switch on what was read: each rule's `to` is one write, or a refusal where the record is there and the write
   is not wanted; `else` is the refusal where there was no record.
3. One write per branch, each the `to` of a rule: `#remove` by key, or `#put` of the record read whole from `in`.
   That is what keeps it from running on another branch.
4. One switch per write on the write's answer, since a write answers `record` absent where the key vanished
   between the read and the write.
5. One `make` and one `refuse` per branch. A node has one router (G009), so two switches cannot share a refusal
   node.
6. `out.from` names every leaf: each `make` and each `refuse`.

`--read-then put|remove` writes this shape with the routing in place, one branch per `--branch <id>:<when>`:

```
wilanis new graph features/customers/remove-closed --store @customers/data/customers.store.json --collection customers --type @customers/domain/Customer.shape.json --read-then remove --branch removed:"has(record) && !(has(record.active) && record.active)"
```

Below is what it writes over the example's store, with `in` set to `@customers/domain/CustomerRef.shape.json`,
the description and the write's label written where they said `TODO`, and one rule added by hand. A branch the
scaffold writes is a write, so a customer whose account is still open would fall through to `noCustomer`; the
second rule sends it to a refusal of its own, `stillOpen`. It checks clean in the example.

```json
{
  "$schema": "https://raw.githubusercontent.com/wilanis/wilanis-js/main/packages/core/schemas/graph.schema.json",
  "description": "Remove one customer once their account is closed: read it, decide on what it holds, remove it on that branch alone, and answer the record removed.",
  "in": "@customers/domain/CustomerRef.shape.json",
  "out": {
    "type": "@customers/domain/Customer.shape.json",
    "from": ["removedCustomer", "goneBeforeRemoved", "stillOpen", "noCustomer"]
  },
  "nodes": [
    { "type": "@wilanis/node/run.schema.json", "id": "storedCustomer", "label": "Read the record",
      "run": "@storage/store.port.json#get",
      "in": { "store": "@customers/data/customers.store.json", "collection": "customers", "key": "{{in.id}}" } },
    { "type": "@wilanis/node/switch.schema.json", "id": "whichWrite", "label": "Is it there, and what does it hold?",
      "in": { "record": "{{storedCustomer.record}}" },
      "rules": [
        { "when": "has(record) && !(has(record.active) && record.active)", "to": "removed" },
        { "when": "has(record)", "to": "stillOpen" }
      ],
      "else": "noCustomer" },
    { "type": "@wilanis/node/run.schema.json", "id": "removed", "label": "Remove the closed account",
      "run": "@storage/store.port.json#remove",
      "in": { "store": "@customers/data/customers.store.json", "collection": "customers", "key": "{{in.id}}" } },
    { "type": "@wilanis/node/switch.schema.json", "id": "stillThereAfterRemoved", "label": "Was it still there?",
      "in": { "record": "{{removed.record}}" },
      "rules": [{ "when": "has(record)", "to": "removedCustomer" }],
      "else": "goneBeforeRemoved" },
    { "type": "@wilanis/node/run.schema.json", "id": "removedCustomer", "label": "The record as it now stands",
      "run": "@std/object.port.json#make",
      "in": { "value": "{{removed.record}}", "type": "@customers/domain/Customer.shape.json" } },
    { "type": "@wilanis/node/run.schema.json", "id": "goneBeforeRemoved", "label": "It was gone by the time we wrote",
      "run": "@std/outcome.port.json#refuse",
      "in": { "reason": "missing", "message": "no record {{in.id}}", "type": "@customers/domain/Customer.shape.json" } },
    { "type": "@wilanis/node/run.schema.json", "id": "stillOpen", "label": "The account is still open",
      "run": "@std/outcome.port.json#refuse",
      "in": { "reason": "open", "message": "customer {{in.id}} still has an open account",
              "type": "@customers/domain/Customer.shape.json" } },
    { "type": "@wilanis/node/run.schema.json", "id": "noCustomer", "label": "No such record",
      "run": "@std/outcome.port.json#refuse",
      "in": { "reason": "missing", "message": "no record {{in.id}}", "type": "@customers/domain/Customer.shape.json" } }
  ]
}
```

`removedCustomer` may read `{{removed.record}}` where a required value goes because it is the `to` of a
`has(record)` rule: a switch rule `has(x)` proves `x` present for the node it routes to, and for nothing else.
Read it from a node the switch does not route to and G004 says so. Inside a rule, a read through a value that may
be missing needs a `has()` on the left of the same `&&` (G011), which is why the first rule reads
`has(record.active) && record.active` and not `record.active` alone.

The graph refuses with one word, `missing` or `open`, and the trigger that reaches it maps each word to an answer
(`settings.response.refusals`). Each write is an effect, listed in `feature.json → effects`.

## The refusals these shapes meet

**G004** `'value': string is not <shape>` at a read like `{{pin.record || unpin.record}}`, or `'x' may be
missing at run time but <operation> requires it`. The first is the `||` join: two nodes' answers are joined at
`out.from`, one per branch, never in one template. Give each branch its own `make` reading one node's answer,
and list both under `out.from`. The second is an optional read feeding a required input: route around it
with a switch whose rule is `has(x)` and make the reader that rule's `to`.

**G008** `node 'pin' is read by nothing`. Nothing reads its answer and no switch routes to it, so it is an
effect that would run on every branch and answer nobody. Make it the `to` of the switch rule that wants it,
then read its answer: a switch on `has(record)` over it, ending in a `make` named under `out.from`. Do not
quiet it by adding the node to `out.from` while it still sits beside the switch: it would still run on
every branch.

**G009** `node 'noCustomer' is routed by both 'whichWrite' and 'stillThereAfterRemoved'`. A node has one router.
Two switches that both end in a refusal each need their own refusal node, with the same `reason` if the reason
is the same.

**I007** `patch writes 'tier', which 'A customer is reachable' (...) reads; a rule over the whole record cannot be
held on a part of one`. The field is one the rule reads, so the change is the pair above: laid over the loaded
record with `#merge` in a domain graph, and `#put` whole by the data graph behind the write.

**I008** `the Customer written here is composed at the write, so nothing judges it against 'A customer is
reachable' (...) before the store keeps it`. Give `#put` `"record": "{{in}}"`, and make the record in the domain
graph that hands it down.

**L016** `data graph makes a Customer, which 'A customer is reachable' (...) guards, and the effect 'stored' reads
it`. Move the `make` or the `merge` up into a domain graph, and let the data graph take the record whole as its
`in`.

If a refusal seems wrong, read `wilanis describe` on the port before arguing with it, and compare your graph
to the nearest one in the tree: `wilanis ls graph`, then `wilanis describe <path>`.
