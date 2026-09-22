---
name: wilanis-graphs
description: How a wilanis graph runs and how to shape one. Load it when writing a graph, adding a switch, reading or writing a record through a store (get, patch a record, put, remove), or when `wilanis check` refuses with G004, G008 or G009.
---

# Writing a graph

## The rule that decides everything

A graph is dataflow, not control flow. A node runs when every input it reads is ready, whatever any switch
chose. A switch chooses who answers, not who runs: the only node a switch holds back is the one its rule
names as `to`. So an effect only one branch needs must be that switch's `to`, or it runs on every branch.
Two `#patch` nodes written beside a switch, each reading only `{{in.id}}`, both run on every call, and the
switch decides nothing but which answer is forwarded.

Branches are joined at `out.from`, and only there: a list of candidates, one per branch, the first that
settled answers. Never join two nodes' answers in one template with `||`: `{{pin.record || unpin.record}}`
is one read of two values that are never both there, and the checker refuses it.

When you need a shape, do not invent it. Find the nearest graph in the tree and copy it: `wilanis ls graph`
lists them, `wilanis describe <path>` lays one out node by node. A graph over a store already exists in
almost every tree.

## Read, decide, write

The one shape for a change that depends on what is kept. Every step is a node, every branch has its own
write, its own check of the write's answer, and its own refusal.

1. `#get` the record by key.
2. A switch on presence: `has(record)` routes to the decision, `else` to a refusal.
3. A switch on the value, routed to by the first: each rule's `to` is one write.
4. One `#patch` per branch, each the `to` of a rule. That is what keeps it from running on the other branch.
5. One switch per write on the write's answer, since `#patch` answers `record` absent where the key vanished.
6. One `make` and one `refuse` per branch. A node has one router (G009), so two switches cannot share a refusal node.
7. `out.from` names every leaf: each `make` and each `refuse`.

The graph below flips a customer's `tier` between `bronze` and `silver` over the store the example tree keeps
(`@customers/data/customers.store.json`, collection `customers`, of `@customers/domain/Customer.shape.json`, keyed by
`id`). It checks clean and every branch rehearses. For a boolean field, the second switch reads
`{{read.record.active}}` and its rule is `active`.

```json
{
  "$schema": "https://raw.githubusercontent.com/wilanis/wilanis-js/main/packages/core/schemas/graph.schema.json",
  "description": "Flip one customer's tier between bronze and silver: read it, decide on what was read, write on one branch, answer what was written.",
  "in": "@customers/domain/CustomerRef.shape.json",
  "out": {
    "type": "@customers/domain/Customer.shape.json",
    "from": ["silvered", "bronzed", "missing", "goneBeforeSilver", "goneBeforeBronze"]
  },
  "nodes": [
    {
      "type": "@wilanis/node/run.schema.json",
      "id": "read",
      "run": "@storage/store.port.json#get",
      "in": { "store": "@customers/data/customers.store.json", "collection": "customers", "key": "{{in.id}}" }
    },
    {
      "type": "@wilanis/node/switch.schema.json",
      "id": "kept",
      "in": { "record": "{{read.record}}" },
      "rules": [{ "when": "has(record)", "to": "decide" }],
      "else": "missing"
    },
    {
      "type": "@wilanis/node/switch.schema.json",
      "id": "decide",
      "in": { "tier": "{{read.record.tier}}" },
      "rules": [{ "when": "tier == 'bronze'", "to": "toSilver" }],
      "else": "toBronze"
    },
    {
      "type": "@wilanis/node/run.schema.json",
      "id": "toSilver",
      "run": "@storage/store.port.json#patch",
      "in": { "store": "@customers/data/customers.store.json", "collection": "customers", "key": "{{in.id}}", "changes": { "tier": "silver" } }
    },
    {
      "type": "@wilanis/node/run.schema.json",
      "id": "toBronze",
      "run": "@storage/store.port.json#patch",
      "in": { "store": "@customers/data/customers.store.json", "collection": "customers", "key": "{{in.id}}", "changes": { "tier": "bronze" } }
    },
    {
      "type": "@wilanis/node/switch.schema.json",
      "id": "stillThereAfterSilver",
      "in": { "record": "{{toSilver.record}}" },
      "rules": [{ "when": "has(record)", "to": "silvered" }],
      "else": "goneBeforeSilver"
    },
    {
      "type": "@wilanis/node/switch.schema.json",
      "id": "stillThereAfterBronze",
      "in": { "record": "{{toBronze.record}}" },
      "rules": [{ "when": "has(record)", "to": "bronzed" }],
      "else": "goneBeforeBronze"
    },
    {
      "type": "@wilanis/node/run.schema.json",
      "id": "silvered",
      "run": "@std/object.port.json#make",
      "in": { "value": "{{toSilver.record}}", "type": "@customers/domain/Customer.shape.json" }
    },
    {
      "type": "@wilanis/node/run.schema.json",
      "id": "bronzed",
      "run": "@std/object.port.json#make",
      "in": { "value": "{{toBronze.record}}", "type": "@customers/domain/Customer.shape.json" }
    },
    {
      "type": "@wilanis/node/run.schema.json",
      "id": "missing",
      "run": "@std/outcome.port.json#refuse",
      "in": { "reason": "missing", "message": "no customer {{in.id}}", "type": "@customers/domain/Customer.shape.json" }
    },
    {
      "type": "@wilanis/node/run.schema.json",
      "id": "goneBeforeSilver",
      "run": "@std/outcome.port.json#refuse",
      "in": { "reason": "missing", "message": "customer {{in.id}} vanished before the write", "type": "@customers/domain/Customer.shape.json" }
    },
    {
      "type": "@wilanis/node/run.schema.json",
      "id": "goneBeforeBronze",
      "run": "@std/outcome.port.json#refuse",
      "in": { "reason": "missing", "message": "customer {{in.id}} vanished before the write", "type": "@customers/domain/Customer.shape.json" }
    }
  ]
}
```

Read `{{read.record.tier}}` is allowed in `decide` because `decide` is the `to` of a `has(record)` rule: a
switch rule `has(x)` proves `x` present for the node it routes to, and for nothing else. Read it from a
node the switch does not route to and G004 says so.

The graph refuses with one word, `missing`, and the trigger that reaches it maps that word to an answer
(`settings.response.refusals`). Each `#patch` is an effect, listed in `feature.json → effects`.

## The three refusals this shape meets

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

**G009** `node 'missing' is routed by both 'kept' and 'stillThereAfterPost'`. A node has one router. Two
switches that both end in a refusal each need their own refusal node, with the same `reason` if the reason
is the same.

If a refusal seems wrong, read `wilanis describe` on the port before arguing with it, and compare your graph
to the nearest one in the tree: `wilanis ls graph`, then `wilanis describe <path>`.
