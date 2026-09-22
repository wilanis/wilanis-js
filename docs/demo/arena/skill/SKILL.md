---
name: wilanis-graphs
description: Load this when writing a graph, adding a switch, patching a record after reading it, or repairing a G004, G008 or G009 refusal in a wilanis tree. It states the one dataflow rule the checker assumes and gives the read-decide-write shape over a store, node by node.
---

# Writing a graph

## The rule

A graph is dataflow, not a program. **A node runs when every input it reads is ready, whatever any switch
chose.** A switch chooses who *answers*, not who *runs*: its `to` names the node that continues that branch,
and only that node waits for the switch. Everything else that is ready runs.

So an effect that only one branch needs -- a `#patch` that pins, another that unpins -- must be the `to` of the
switch that decides between them. Written beside the switch, reading only `{{in.id}}`, both are ready the moment
the graph starts and both run on every call; the tree checks, the rehearsal settles, and one write is always a
write nobody meant.

Branches are joined at `out.from`, and nowhere else: a list of candidates, each behind a switch, the first
that settled answers. Never join two nodes' answers with `||` in a template (`{{pin.record ||
unpin.record}}`): each is optional on the other's branch, and the checker refuses the read (G004) because it is
right to.

When you need a shape, find the nearest graph already in the tree and copy it: `npx wilanis ls graph .`, then
`npx wilanis describe <path> .`. In this tree `features/customers/data/kept-update.graph.json` is the write
after a read.

## The shape: read, decide, write

One field of one record changes after the record is read. The nodes, in the order they settle:

1. `asked` -- `@storage/store.port.json#get` by `{{in.id}}`.
2. `found` -- a switch on `has(record)`: to the decision, `else` to `missing`.
3. `wasSet` -- a switch on the current value: `has(flag) && flag` to `unset`, `else` to `set`.
4. `set`, `unset` -- one `#patch` per branch, each the `to` of a rule above, each writing one value.
5. `setRoute`, `unsetRoute` -- a switch on `has(record)` after each write: the record may have gone between
   the read and the write.
6. `setRow`, `unsetRow` -- one `@std/object.port.json#make` per branch, reading that branch's write.
7. `missing`, `vanishedOnSet`, `vanishedOnUnset` -- one `@std/outcome.port.json#refuse` per branch that ends
   without a record (G009: a node has one router, so each branch refuses through its own node).
8. `out.from` lists every node that can answer: the two rows and the three refusals.

The same graph over this tree's store, with `active` as the flag:

```json
{
  "$schema": "https://raw.githubusercontent.com/wilanis/wilanis-js/main/packages/core/schemas/graph.schema.json",
  "label": "Toggle a flag on what is kept",
  "description": "Read the record, decide from what it holds, write one value on one branch.",
  "in": "@customers/domain/CustomerRef.shape.json",
  "out": { "type": "@customers/domain/Customer.shape.json", "from": ["setRow", "unsetRow", "missing", "vanishedOnSet", "vanishedOnUnset"] },
  "nodes": [
    { "type": "@wilanis/node/run.schema.json", "id": "asked", "label": "Read the record", "run": "@storage/store.port.json#get",
      "in": { "store": "@customers/data/customers.store.json", "collection": "customers", "key": "{{in.id}}" } },
    { "type": "@wilanis/node/switch.schema.json", "id": "found", "label": "Is it kept?", "in": { "record": "{{asked.record}}" },
      "rules": [{ "when": "has(record)", "to": "wasSet" }], "else": "missing" },
    { "type": "@wilanis/node/switch.schema.json", "id": "wasSet", "label": "Is it set now?", "in": { "flag": "{{asked.record.active}}" },
      "rules": [{ "when": "has(flag) && flag", "to": "unset" }], "else": "set" },
    { "type": "@wilanis/node/run.schema.json", "id": "set", "label": "Set it", "run": "@storage/store.port.json#patch",
      "in": { "store": "@customers/data/customers.store.json", "collection": "customers", "key": "{{in.id}}", "changes": { "active": true } } },
    { "type": "@wilanis/node/run.schema.json", "id": "unset", "label": "Unset it", "run": "@storage/store.port.json#patch",
      "in": { "store": "@customers/data/customers.store.json", "collection": "customers", "key": "{{in.id}}", "changes": { "active": false } } },
    { "type": "@wilanis/node/switch.schema.json", "id": "setRoute", "label": "Still there?", "in": { "record": "{{set.record}}" },
      "rules": [{ "when": "has(record)", "to": "setRow" }], "else": "vanishedOnSet" },
    { "type": "@wilanis/node/switch.schema.json", "id": "unsetRoute", "label": "Still there?", "in": { "record": "{{unset.record}}" },
      "rules": [{ "when": "has(record)", "to": "unsetRow" }], "else": "vanishedOnUnset" },
    { "type": "@wilanis/node/run.schema.json", "id": "setRow", "label": "The record, set", "run": "@std/object.port.json#make",
      "in": { "value": "{{set.record}}", "type": "@customers/domain/Customer.shape.json" } },
    { "type": "@wilanis/node/run.schema.json", "id": "unsetRow", "label": "The record, unset", "run": "@std/object.port.json#make",
      "in": { "value": "{{unset.record}}", "type": "@customers/domain/Customer.shape.json" } },
    { "type": "@wilanis/node/run.schema.json", "id": "missing", "label": "No such customer", "run": "@std/outcome.port.json#refuse",
      "in": { "reason": "missing", "message": "no customer {{in.id}}", "type": "@customers/domain/Customer.shape.json" } },
    { "type": "@wilanis/node/run.schema.json", "id": "vanishedOnSet", "label": "Gone before the write", "run": "@std/outcome.port.json#refuse",
      "in": { "reason": "missing", "message": "no customer {{in.id}}", "type": "@customers/domain/Customer.shape.json" } },
    { "type": "@wilanis/node/run.schema.json", "id": "vanishedOnUnset", "label": "Gone before the write", "run": "@std/outcome.port.json#refuse",
      "in": { "reason": "missing", "message": "no customer {{in.id}}", "type": "@customers/domain/Customer.shape.json" } }
  ]
}
```

A port operation is met in every profile (B001): the same graph over `customers-postgres.store.json` for
`production`, and a read-then-`PUT` over `@http/http.port.json#request` for `live`, each named in its
profile's binding.

## The three refusals you will meet, and the edit

- **G004** -- *an optional read feeds a required input*. You read `{{x.record}}` where `x` may not have run
  on this branch, or joined two answers with `||`. The edit: give each branch its own node reading its own
  write, and list both under `out.from`; where the value itself may be absent, route around it with a switch
  rule `has(record)` and read it only in that rule's `to`.
- **G008** -- *a node is read by nothing*. An effect sits beside the switch that should route it: nothing
  routes to it and nothing reads it. The edit: make it the `to` of a switch rule and read its answer in a
  node on that branch, or delete it.
- **G009** -- *a node has more than one router*. Two switches both route to one `missing`. The edit: one
  refuse node per branch (`missing`, `vanishedOnSet`, `vanishedOnUnset`), each named once in `out.from`.

If a refusal seems wrong, the contract is wrong, not the checker: `npx wilanis describe <port> .` before
arguing with it.
