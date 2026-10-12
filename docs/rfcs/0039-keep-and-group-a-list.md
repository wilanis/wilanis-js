# RFC 0039: Keep and group a list: a `where` on `map`, and `@std/list#totals`

- **Status:** draft
- **Areas:** `area:core` (`map.schema.json`, two keywords on a native contract's field in `common.schema.json`,
  `MapNode` in `nodes.ts`), `area:engine` (`KMap` and `map.ts`), `area:compiler` (`G011` and `G006` widened, one
  new `G` rule, the lowering, `sitesOf`), `area:runtime` (the rehearsal, `describe`, the `@std` plugin, the
  template), `area:view` (the map node and the port page). The three plugins that walk calls (`@auth`, `@queue`,
  `@storage`) learn that a map may call nothing.
- **Tracking issue:** #855
- **Depends on:** RFC 0038 (the rehearsal follows a read of `in` out through maps and calls): this RFC lands after
  it, and its rehearsal step is written on 0038's `traced`. It builds on RFC 0007 (invariants: the sites and proofs
  this RFC leaves as they are) and RFC 0018 (scenario generation: the branches a rehearsal walks), both
  implemented. *Order with the open RFCs* (under *Implementation plan*) says how it meets RFC 0037 and RFC 0041.

## Summary

A `map` node may say `where`: a rule over each element, as `item`, and over the map's `in`. The map runs its
operation for the elements the rule holds for, and answers their results. A map with `where` and no `run` answers
the kept elements themselves, so a graph can keep the elements of a list a rule holds for. The checker types the
rule as it types a switch's rule (G011). The rehearsal walks two branches for it, *kept* and *dropped*, and steers
the first element of the list into each. Beside it, `@std/list.port.json#totals` groups a list by a string field
and answers one total per key: how many elements, and the sum of a number field. The document names the list,
the key and the summed field, and the checker types both paths against the element's shape. Text matching is not
part of this RFC; that is RFC 0040 (#856).

## Motivation

`@std/list.port.json` has `count`, `first`, `concat` and `slice` (`packages/runtime/docs/std/list.port.json`;
handlers in `packages/runtime/src/plugins/std.ts`). A `map` runs one operation per element and answers one result
per element, in order (`runMap` in `packages/engine/src/map.ts`). Nothing in a graph can make a list shorter by a
rule, and nothing can add numbers up. A consumer tree needed both.

**Keeping elements.** The consumer's duplicate-code report needs the clones whose two copies lie in different
services, and separately the clones within one service (GAPS.md M11). A graph cannot split one list into those
two. So the plugin that reads the data answers them already split: `across` and `within` in
`plugins/copies/docs/Copies.shape.json`, partitioned in `plugins/copies/src/report.ts`. That file's own header
says "which of these a page shows is the caller's to decide", but the split itself is decided in plugin code. The
checker cannot see the rule "the two sides differ". The rehearsal cannot steer a run into the case where no clone
crosses services. Every tree with the same need writes the same partition in its own plugin.

With this RFC the plugin answers the clones once, and the graph writes the rule:

```json
{
  "type": "@wilanis/node/map.schema.json",
  "id": "across",
  "label": "Clones between two services",
  "over": "{{found.clones}}",
  "where": "item.firstService != item.secondService"
}
```

**Grouping and summing.** The consumer's pages draw charts of a number per module: the commits that changed a
module's files, the findings in each module (GAPS.md "After M13"). The graph cannot sum per key, so the page
plugin does it as part of layout: `hotspots` and `risk` in `plugins/guidance/src/glance.ts` build a `Map` from
module to a running sum. The layout around it (ranking, folding the tail into "other modules", colour classes) is
rendering and belongs in that plugin. The sum per module is not layout. It is a fact about the data that a
reader of the graph cannot see today.

With this RFC, once each row names its module, the graph says which list, which key and which number:

```json
{
  "type": "@wilanis/node/run.schema.json",
  "id": "churnPerModule",
  "run": "@std/list.port.json#totals",
  "in": {
    "list": "{{churn}}",
    "type": "@review/domain/Churn.shape.json",
    "by": "module",
    "sum": "commits"
  }
}
```

One limit stays. In `glance.ts` the module of a file is the module whose path is the longest
prefix of the file's path (`ownerOf`). That is a text match. This RFC does not give a graph a way to find it; a
plugin still answers it, or RFC 0040 does. `risk` also counts per module *and* per priority, two keys; `totals`
takes one (see *Open questions*).

**Where this sits against #791 and #792.** Issue #791 draws the line this RFC follows: "value-level decisions stay
in the graph", and "structural rendering moves to a generic pure op". It sharpens it: "Purity isn't the criterion
-- where the decision lives is." Which elements to keep is a value-level decision. So it is a rule in the graph,
written where the checker types it and the rehearsal steers it. It is not a predicate handed to a plugin operation
as a string. Adding numbers per key decides nothing: the document names the list, the key field and the summed
field, and the operation only does the arithmetic. So it is an `@std` operation. #791 also proposes to write the
pattern down as an RFC and to hold it with a fitness function. This RFC does neither; that stays #791's.

Issue #792 asks for "a blessed set of mechanical ops", each "pure, domain-agnostic, generic". `totals` meets that
test, and it is the one operation from #792's list that a consumer needed in the form it needed. This RFC does not
take the rest of #792's list (`buildArgv`, `divRound`, sorting, substring matching). It does replace one pattern
#791 names: "map bills to bill-or-null by range, `compact` strips nulls". A `where` keeps the bills in range
directly, so a graph needs no `compact` for that.

**What this does not try to solve.** It does not match text (RFC 0040, #856). It does not sort a list, or group by
two keys, or answer the elements of each group. It does not narrow the type of a kept element: a `has()` in a
`where` does not make a field required in the answer (see *Open questions*). It does not let a switch inside the
operation a map runs through a port read the element (GAPS.md M12); a `where` stands on the map itself, so it
does not meet that limit.

## Guide-level explanation

**A `where` on a map** is a rule over each element of the list. The element is `item`, the whole element, and the
map's `in` names are there too, as they are for the operation. An element the rule holds for is *kept*. An element
it does not hold for is *dropped*: its operation never runs, and the map's answer leaves it out. The answer keeps
the order of the list.

**A map with `where` and no `run`** keeps elements and does nothing else. Its answer is the kept elements, as they
were, and its type is the type of `over`. This is the way a graph filters a list.

The example's digest counts every customer. Say it should also count the active ones, and how many customers
each tier holds. `example/features/customers/domain/digest.graph.json` gains three nodes:

```json
{
  "type": "@wilanis/node/map.schema.json",
  "id": "active",
  "label": "The active customers",
  "over": "{{all}}",
  "where": "has(item.active) && item.active == true"
},
{
  "type": "@wilanis/node/run.schema.json",
  "id": "activeCount",
  "label": "How many are active",
  "run": "@std/list.port.json#count",
  "in": { "list": "{{active}}" }
},
{
  "type": "@wilanis/node/run.schema.json",
  "id": "tiers",
  "label": "Customers per tier",
  "run": "@std/list.port.json#totals",
  "in": {
    "list": "{{all}}",
    "type": "@customers/domain/Customer.shape.json",
    "by": "tier"
  }
}
```

`Digest.shape.json` gains `active` (a number) and `tiers` (`@std/Total.shape.json[]`), and `digest` writes them
from `{{activeCount}}` and `{{tiers}}`.

`active` is typed `Customer.shape.json[]`, the type of `{{all}}`. `active` on a customer is optional, so the rule
proves it present with `has()` before it reads it, as a switch's rule does.

**A map with `where` and `run`** runs the operation for the kept elements only. The digest's lines could list
only the active customers:

```json
{
  "type": "@wilanis/node/map.schema.json",
  "id": "lines",
  "label": "One line per active customer",
  "run": "@std/text.port.json#fill",
  "over": "{{all}}",
  "where": "has(item.active) && item.active == true",
  "bind": { "values": "" },
  "in": { "template": "- {name} <{email}> {tier}" }
}
```

The rule reads `item` even where `bind` hands the element to the operation under another name. `item` is always
the element in a `where`, so the rule reads the same whichever way the operation takes it.

**`@std/list.port.json#totals`** answers one total per distinct value of a string field:

```json
[
  { "key": "gold", "count": 3, "sum": 0 },
  { "key": "silver", "count": 7, "sum": 0 }
]
```

`by` names the key field and `sum`, when given, the number field to add. Both are dotted paths within the element.
Both are literals, and the checker reads each against the element's shape: the path must exist, be required at
every step, and end at a string for `by` and a number for `sum`. Without `sum`, every total's `sum` is 0. The
totals come in the order each key first appears in the list.

**The refusals an author meets.** A rule that is not a boolean, or reads a field the element does not have, is
G011, as for a switch:

```
G011  features/customers/domain/digest.graph.json  nodes/active/where
      where: 'item.tier' is string, not boolean
      hint: compare the value, as in a.b == 1, so where answers a boolean
```

A `by` that names a field the shape does not have is the new rule `G0nn`:

```
G0nn  features/customers/domain/digest.graph.json  nodes/tiers/in/by
      by: 'teir' is not a field of @customers/domain/Customer.shape.json
      hint: name a required string field of the element: id, name, email, tier
```

**The rehearsal** walks two branches for every `where`, as it walks two for a switch with one rule and an `else`:
the first element of `{{all}}` kept, and the first element dropped. It steers each by writing the stub of `all`,
the node that holds the list. `wilanis rehearse --write` records one scenario per branch.

## Reference

### Documents and schemas

**`packages/core/schemas/node/map.schema.json`.**

- A new optional property `where`: a string, `minLength: 1`, described as "A rule over each element, as `item`,
  and over this node's `in`. The operation runs for the elements it holds for; the others are dropped and left out
  of the answer. Expressions as a switch's rule: has(path), comparisons, && || !, in, len(x)."
- `run` leaves `required`. The schema adds `"anyOf": [{ "required": ["run"] }, { "required": ["where"] }]`, so a
  map names an operation, or a rule, or both.
- `"dependentRequired"` ties to `run` every property that only means something for a call: `bind`,
  `onItemFailure`, `concurrency`, `retry`, `timeoutMs`. A map with no `run` keeps `over`, `where`, `in`, `limit`,
  `label` and `description`.
- The description says what a map with no `run` answers: "the elements the rule holds for, as they are, in order".

A document that breaks either of these is refused by the schema, as D001.

**`MapNode` in `packages/core/src/nodes.ts`** gains `where?: string`, and `run` becomes `run?: string`. Core adds
one helper beside `isMap`, `callOf(node)`, which answers the operation a node calls or nothing. Every reader of
`node.run` on a map uses it: the compiler's checks and lowering, `sites.ts`, `reach.ts`, `atomic-reach.ts`,
`graph-said.ts`, the viewer's `graphs.ts`, and the call walks in `plugin-auth`,
`plugin-queue` and `plugin-storage`. A map that calls nothing makes no call, reaches no effect, and is no site.

**Two keywords on a native contract's field, `common.schema.json` `$defs/field`.**

- `within`: a type variable, as `binds` is written (`"^\\$[A-Z][A-Za-z0-9]*$"`). Native contracts only, on a
  static string field: the literal is a dotted path within the type the variable is bound to at the call.
- `reaches`: a type reference. With `within`: the type the value at the end of the path must have.

These keep the rule "a path within the element is typed by the checker" in one place, the compiler, rather than in
the handler that reads the path. `bind` on a map is typed the same way today (G012 in `boundInputs`,
`check/graph-nodes.ts`). `Field` in `model.ts` gains the two members.

**`@std/Total.shape.json`** (new, in `packages/runtime/docs/std/`, layer `core`, granted in `plugin.json`):

```json
{
  "$schema": "https://raw.githubusercontent.com/wilanis/wilanis-js/main/packages/core/schemas/shape.schema.json",
  "label": "Total",
  "description": "One group of a list: its key, how many elements have it, and the sum of the number #totals was asked to add.",
  "layer": "core",
  "fields": {
    "key": { "type": "string", "description": "the value of the `by` field the elements of this group share" },
    "count": { "type": "number", "description": "how many elements have this key" },
    "sum": { "type": "number", "description": "the sum of the `sum` field over those elements; 0 when #totals was given no `sum`" }
  }
}
```

No new document kind. No change to `HOME` in `placement.ts`. The kinds table in
`packages/runtime/templates/CLAUDE.md` gains, on its `graph` row, "a `map` may say `where` (a rule over `item`);
with no `run` it answers the kept elements".

### Ports, operations and kinds granted

`@std/list.port.json` gains one operation. Its description changes to "Lists: count, first, concat, slice,
totals."

```json
"totals": {
  "description": "One total per distinct value of the string field `by`: how many elements have it, and the sum of the number field `sum` over them (0 without `sum`). Totals come in the order each key first appears in the list.",
  "accepts": {
    "list": { "type": "$T[]" },
    "type": { "type": "type", "binds": "$T", "description": "the element type" },
    "by": {
      "type": "string",
      "static": true,
      "within": "$T",
      "reaches": "string",
      "description": "the dotted path within each element of the key it is grouped by"
    },
    "sum": {
      "type": "string",
      "static": true,
      "required": false,
      "within": "$T",
      "reaches": "number",
      "description": "the dotted path within each element of the number added up per key"
    }
  },
  "returns": "@std/Total.shape.json[]",
  "pure": true
}
```

The handler in `packages/runtime/src/plugins/std.ts` reads each element's key and number with `readPath` from
`@wilanis/engine`, as `#fill` already does. It answers through `declared`, so the answer is judged against
`@std/Total.shape.json[]` at run time. An element whose key is not a string, or whose number is not a number, is
a fault of the node. The checker makes that a bug in the plugin that answered the list, never something a
document can write.

No new port, trigger kind, connection kind or codec.

### Checker rules

Codes in `G0nn` form are placeholders; numbers are assigned when the implementing pull request lands.

| Code | Where it lives | Refuses when | Hint |
|---|---|---|---|
| G011 (widened) | `check/graph-nodes.ts`, `checkWhere` beside `checkRule` | a map's `where` does not parse, reads what neither `item` nor the map's `in` holds, reads an optional path no `has()` on the left of `&&` proved, or is not a boolean. `at`: `nodes/<id>/where` | `compare the value, as in a.b == 1, so where answers a boolean` / `write where as an expression over item and this node's in` |
| G006 (widened) | `check/graph-nodes.ts`, `elementInputs` | a map that says `where` and `bind` also names `item` in its `in`; `item` is the element in the rule. `at`: `nodes/<id>/in/item` | `rename the input; in a where, item is the element` |
| G0nn | `check/inputs.ts`, beside the typing of a call's inputs | a static field marked `within` whose literal is not a path the bound type holds, passes through an optional field, or ends at a value that is not of the `reaches` type. `at`: `nodes/<id>/in/<field>` | `name a required <reaches> field of the element: <the fields that are>` |
| G024 (widened) | `check/graph-nodes.ts`, `whyNeverBreaks` | a `catch` of a map with no `run`: like a pure operation, it breaks only by a bug (or its `limit`, which is no effect) | as today: `nothing here breaks but a bug ...; delete catch` |
| S004 (widened) | `check/scenarios.ts` | a scenario's `branch` names a map with no `where`, or its `when` is neither that `where` nor `else`, or its `to` is not the map itself | as today |

The rules that need no change, and why:

- **Typing the rule.** `elementInputs` already answers the element as `item`, typed from `over`, after G012 and
  G004 judged `over`. `checkWhere` types the rule over `item` plus the typed reads of the map's `in`, with
  `expr.check`, exactly as `checkRule` types a switch's rule over its `in`. A map with no `run` has no operation
  to type its `in` against, so each value of `in` is typed by its own read, as a switch's `in` is.
- **The answer's type.** `nodeOut` in `check/graph-reads.ts` answers `{ kind: 'list', of: returns }` for a map.
  For a map with no `run` it answers the type of `over`.
- **Layers and effects.** A `where` is pure and allowed in any layer. A map with no `run` reaches nothing, so L002,
  L009 to L011, G014 and G015 have nothing to judge.
- **Static fields.** `by` and `sum` are `static`. A template there is P001, as for any static field
  (`check/inputs.ts`).

**How invariants and `prove.ts` see a kept list.** This is the question RFC 0007's guard depends on, so it is
answered here rule by rule.

1. *A map with no `run` is not a site.* `sitesOf` in `packages/compiler/src/sites.ts` lists a node that "runs a
   native operation that answers" the shape (`madeArity`). A keep runs nothing, so `madeArity` answers nothing
   for it, and the compiler lowers no guard at it. This is safe because a keep makes no value. Each element it
   answers is the very value of `over`, and that list came from a site: a node that made it, the graph's `in`, or
   a domain operation's answer, which "was made inside the graph that answers it, and judged there". Keeping some
   of the elements does not change any of them. Where the elements of `over` sit inside a field of another value,
   they are judged where that field's value was made, as today; a keep neither closes nor widens that gap.
2. *A map with `run` and `where` is a site exactly when it is one today*: its operation is native and answers the
   shape, with arity `list`. The guard is lowered as today, a `map` over the answer (`guardMap` in
   `guard-lowering.ts`), and so it judges each kept element's result. A dropped element made nothing and is
   judged nothing.
3. *A rule a `where` checked does not count as held.* `narrowedBy` in `check/prove.ts` counts a conjunct as
   established only when a switch routes to the site: "A rule routes to a node only when it held"
   (`narrowing.ts`). A `where` routes no node; it chooses which elements the operation is handed. The value at
   the site is the operation's answer, not the element, so a fact about the element is not a fact about the
   value. The one case where the answer is the element is a `#make` handed the element whole
   (`"bind": { "value": "" }`). That case is better written as a keep with no `run`, which is not a site at all
   (rule 1). The direction is the safe one: `prove.ts` says "Being wrong here silently removes a guard". A rule not
   counted adds a guard, and never removes one.
4. *I003 does not change.* "No graph makes or takes the shape it holds over" still reads `sitesOf`. A keep does
   not make a value, so it does not count as reaching the shape.

### Runtime behaviour

**The kernel, `packages/engine/src/spec.ts` and `map.ts`.**

- `KMap` gains `where?: { when: (values: Record<string, unknown>) => boolean; label: string }`, the shape of one
  `KSwitch` rule. `handler` becomes optional: a map with no handler answers each kept element as it is.
- `NodeReport` gains `kept?: boolean`, written on every element report of a map with a `where`.
- Before an element runs, `runElement` evaluates `where.when` over `{ item: <the element>, ...broadcast }`. False:
  the element's report is `cancelled` with `kept: false`, and its handler is never called. True: `kept: true`, and
  the element runs as today, or, with no handler, is `done` with the element as its `out`, shown as the list's
  report shows that element. A rule that throws is a fault of that element.
- `collectMap` leaves dropped elements out of the answer. A dropped element is not a failure, so it never fails the
  node under `onItemFailure: 'fail'`, and it is not the "element that never started" that leaves the answer
  undecided today.
- `limit` is judged against the length of `over`, before any rule runs, as today.
- An element seeded through `initial['<id>.<index>']` is kept, since it has an answer. Indices stay the indices of
  `over`, so seeding, stubs and recorded answers keep their keys.
- A map with no handler is `pure`: each kept element's answer is a function of the element alone.

**The compiler, `lowerNode` in `packages/compiler/src/compiler.ts`.** It lowers `where` with
`expr.compilePredicate`, as it lowers a switch's rules, with the rule's text as `label`. A map with no `run` is
lowered with no `handler`, no `redact` of an operation, and `pure: true`.

**The rehearsal, `packages/runtime/src/branches.ts` and `rehearse-reached.ts`.**

- `switchesOf` also yields one found decision for every map with a `where`, at the map's own path. It is a switch
  with one rule and an `else`: `{ rules: [{ label: <where>, to: <map id> }], else: <map id> }`. `branchesOf` solves
  it into two cases, *kept* (the rule true) and *dropped* (the rule false).
- In `meet`, a demand of the `where` is traced through one frame: the map's own, as RFC 0038 builds a map's frame
  (its lowered `in`, `over` and `bind`), read as if it bound nothing, since `item` is the element in a `where`
  whatever `bind` says. So `item.<rest>` lands at element 0 of the list `over` reads, and 0038's `traced` follows
  that list on out, through `listHolder`, to the node or the trigger's input that holds it; a name of the map's
  `in` is that source, followed the same way. Where the trace lands on a map, the stub is `<map>.0`; where it
  stops (a list written out, `context`, a literal), the branch is `NEVER RUN` with 0038's sentence. On `main`
  today the element case is `At.element` and `ofElement` in `branches.ts`, which already reach through a
  binding's wrapper `op` (#904); 0038 replaces both with `traced`, and this RFC uses what 0038 leaves rather than
  extending what it removes. A `where` stands on the map, so its demand never needs the frames inside the
  operation: the trace starts one frame out from where a switch in the mapped graph would start.
- A switch inside the operation of a map with a `where` runs only for kept elements. The first element stands for
  all, so a case for such a switch first demands that element 0 is kept, the way it first demands that the list
  holds an element (`nonEmpty`). Likewise, `nonEmpty` for a list a keep answers demands an element in `over` *and*
  that it is kept.
- A case is reached when element 0's report says `kept: true` (*kept*) or `kept: false` (*dropped*).

**Scenarios.** A recorded scenario for a `where` writes
`"branch": { "graph": ..., "node": "<map>", "when": "<where>" | "else", "to": "<map>" }`. `wilanis regress`
replays it and re-evaluates the rule; S004 accepts it (above). The scenario schema changes only in two
descriptions: `branch.node` is "the switch, or the map whose `where` this scenario takes", and `branch.to` is
"... or the map itself, for a `where`".

**Reports and traces.** `trace.ts` names a map span `<id> map ×<n>`; with a `where` it says
`<id> map ×<n>, kept <k>`. A dropped element's span is a cancelled one.

`fuzz` and `start` need no change: a generated list goes through the rule like any other.

### Discoverability

- `wilanis describe` on a graph (`nodeLine` in `graph-said.ts`): a map with a `where` adds `where <rule>` after
  what it maps; a map with no `run` reads `    active  keeps all where has(item.active) && item.active == true`.
- `wilanis describe @std/list.port.json` lays out `totals`, and prints `by` as "a path within `$T` to a string".
  The two keywords are printed wherever a native field carries them.
- The viewer (`packages/view/src/graphs.ts` and `client/index.html`) shows the rule on the map node, and draws a
  map with no `run` as a keep. The port page shows `within` and `reaches` on a field.
- `docs/model.md`: *Graphs* says what `where` does and what a map with no `run` answers. *The standard library is
  four ports* gains `totals` in the `@std/list` list.
- `packages/runtime/templates/CLAUDE.md`: the `graph` row (above); *Types are declared* and *The standard library*
  name `#totals`; *Many at once* says a `where` keeps the elements a rule holds for. The node-naming rule gains: a
  keep is the plural of what it keeps (`active`, `across`).
- The refusals carry hints that name the edit, as the table says.

### Plugin contract

None. `PluginModule` does not change. The plugins that walk calls (`plugin-auth/src/rules.ts`,
`plugin-queue/src/sites.ts`, `plugin-storage/src/calls.ts`) skip a map with no `run` through `callOf`.

## Compatibility

Every change is compatible under RFC 0008, and is made in place.

- `node/map.schema.json`: `where` is a new optional field, and its absence means what a map meant before. `run`
  leaves `required` but the `anyOf` keeps it required wherever `where` is absent. `dependentRequired` refuses only
  a map with no `run`, which no document has today. Every map that validated still validates and means the same.
- `common.schema.json`: `within` and `reaches` are new optional keywords on a native contract's field. No document
  in a tree writes a native contract.
- `scenario.schema.json`: two descriptions only.
- `@std/list.port.json#totals` and `@std/Total.shape.json` are a new operation and a new shape a plugin grants.

The three schema files sit under `packages/core/schemas/`, so the implementing pull requests wait on the
maintainer's `decision` job. The documents this repository holds (`example/`, `libraries/`, every plugin's
`docs/`) change in the same commits, and `npm run test:all` is the compatibility check.

## Tests

**Sabotage tests**, in `packages/runtime/test/example.test.ts`, each breaking the example's `digest.graph.json`
once it carries `active` and `tiers`:

| Code | The edit | Expect |
|---|---|---|
| G011 | `active.where` set to `"item.tier"` | G011 at `nodes/active/where`, "is string, not boolean" |
| G011 | `active.where` set to `"item.active == true"` (no `has`) | G011, "may be missing" |
| G011 | `active.where` set to `"item.activ == true"` | G011, naming the path |
| G006 | `lines` gains `"where"` and `"in": { "item": "x" }` beside its `bind` | G006 at `nodes/lines/in/item` |
| G0nn | `tiers.in.by` set to `"teir"` | G0nn at `nodes/tiers/in/by` |
| G0nn | `tiers.in.by` set to `"active"` (optional, and a boolean) | G0nn |
| G0nn | `tiers.in.sum` set to `"name"` (a string) | G0nn at `nodes/tiers/in/sum` |
| D001 | `active` gains `"concurrency": 2` | D001 (`concurrency` needs `run`) |
| D001 | `active` loses `where` | D001 (neither `run` nor `where`) |
| G024 | a switch `catch`es `active` | G024 |
| S004 | a scenario's `branch` names `active` with `"when": "item.tier == 'gold'"` | S004 |

**Kernel tests**, in `packages/engine/test/`: a map with a `where` and a handler runs only kept elements and
answers their results in order; a map with no handler answers the kept elements; a dropped element is `cancelled`
with `kept: false` and does not fail a map under `fail`; `collect` answers only kept outcomes; `limit` counts
`over`; a seeded element is kept; a rule that throws is a fault of that element; a map whose rule keeps nothing
answers `[]`.

**Compiler tests**, in `packages/compiler/test/`: a map with no `run` is not in `sitesOf` for `Customer`, so the
digest lowers no guard at `active`. This is what a tree that passes cannot show, as `packages/compiler/test`
holds today.

**Rehearsal tests**, in `packages/runtime/test/`: the digest's trigger rehearses `active` into *kept* and
*dropped*; a switch behind a map with a `where` is reached with element 0 kept; a list a keep answers is made
non-empty through its `over`. `wilanis rehearse --check` on the example stays green once the recorded scenarios
are written.

**`@std` tests**, beside the plugin: `totals` groups in first-seen order, counts, sums, answers 0 without `sum`,
answers `[]` for an empty list, and faults on a key that is not a string.

## Implementation plan

Each step is one pull request and one sub-issue of #855.

1. **The kernel keeps.** `KMap.where`, an optional `handler`, `NodeReport.kept`, `runElement` and `collectMap` in
   `packages/engine/src/map.ts`, the trace span. Engine tests only; no document can say it yet.
2. **A map may say `where`.** `map.schema.json` (`where`, the `anyOf`, `dependentRequired`), `MapNode` and
   `callOf` in core, every reader of `run` moved to `callOf` (compiler, runtime, view, the three plugins),
   `checkWhere` (G011), G006 and G024 widened, `nodeOut` for a keep, `sitesOf` skipping a keep, the lowering. The
   example's digest gains `active` and `activeCount`, `Digest.shape.json` gains `active`, and the sabotage tests of
   the table land with it. Waits on the `decision` job.
3. **The rehearsal steers a `where`.** `switchesOf`, `meet`, `nonEmpty` and the reach of a switch behind a kept
   element in `branches.ts` and `rehearse-reached.ts`; S004 and the two descriptions in `scenario.schema.json`; the
   example's recorded scenarios rewritten. Lands after RFC 0038's implementation, on its `traced`. Waits on the
   `decision` job.
4. **A reader sees it.** `describe` (`graph-said.ts`), the viewer, `docs/model.md`, the template's `CLAUDE.md`.
   Can be taken by a new contributor (`good first issue`) once step 2 has landed.
5. **A path within the element is typed.** `within` and `reaches` in `common.schema.json` and `Field`, the G0nn
   rule in `check/inputs.ts`, `describe` and the port page printing them. Waits on the `decision` job.
6. **`@std/list#totals`.** The operation, `@std/Total.shape.json`, the handler, the `@std` tests; the example's
   digest gains `tiers` and its sabotage tests; the template and `model.md` name it.

Steps 1 and 5 can run beside each other. Step 6 needs step 5. Steps 3 and 4 need step 2.

**Order with the open RFCs.** Three other RFCs touch the same files. Each lands as one more optional part on the
same objects, so none changes what another means; the order only decides who rebases.

- **RFC 0038 lands first.** It rewrites the element walk (`traced` in `frames.ts`, a map as a frame, `meet` reading
  the trace), and step 3 here is written on it. Steps 1, 2 and 4 to 6 do not touch the rehearsal and may land
  before 0038; step 3 waits for 0038's implementation.
- **RFC 0041 (`after`)** adds `after` to `map.schema.json`, `MapNode`, `KMap`, `lowerNode` and `nodeLine`, the same
  places as steps 1, 2 and 4. Whichever lands second adds its field beside the other's. They meet in four places,
  and each follows from what both RFCs already say:
  - *A map with both waits, then keeps.* 0041 says "no element starts before every node under `after` has
    answered". The `where` is part of starting an element, so no rule is tried before the wait is over either.
  - *A keep may say `after`.* `after` is a wait, not part of a call, so it stays outside `dependentRequired`: a map
    with no `run` may wait. `lowerNode` copies `after` onto the `KMap` whether or not it has a handler.
  - *A node may wait for a keep.* A keep answers like any node, `[]` when it keeps nothing, so a node whose
    `after` names it starts once it has answered. 0041's G0n1 refuses only an unknown node, the node itself or a
    switch; a keep is none of these.
  - *Nothing new is read.* A `where` reads `item` (from `over`) and the map's `in`, which 0041's G0n2 already counts
    as what the map reads. `after` names no element, so a `where` cannot read a node it only waits for: the rule
    reads what `in` gives it, and a node named only under `after` is not in `in`.
  `nodeLine` prints both: `active  keeps all where <rule>  after <ids>`.
- **RFC 0037** adds `names` to `common.schema.json → $defs/field` and to `Field`, where step 5 adds `within` and
  `reaches`. The keywords are independent: `names` marks a field that names a connection or a store, `within` a
  field that names a path in the element. A field never needs both. Either may land first.

Every new refusal code in these RFCs is a placeholder (`G0nn`) until its implementing pull request lands, so the
three RFCs do not compete for a number.

## Drawbacks and alternatives

**What it costs.** `MapNode.run` becomes optional, and every reader of a node's `run` learns that a map may call
nothing. Once the field is optional, TypeScript names each such place; they are in the compiler, the runtime, the
viewer, and three plugins. (`packages/deploy/src/helm.ts` calls an `isMap`, but it is the `yaml` package's, and
deploy reads no map's `run`.) The rehearsal gains one more kind of decision. Two keywords join a
native field's grammar. A `where` is one more place a decision can sit, beside a switch.

**Do nothing; teach the workaround.** The plugin that reads the data answers it already split or already summed,
as the consumer's `@copies` and `@guidance` do. The template would say: "a graph cannot filter or sum a list; a
plugin answers it split". That is #791's exact complaint: the decision moves into plugin code the checker cannot
type and the rehearsal cannot steer, and every tree writes its own copy. The consumer's tree is the evidence that
this is not hypothetical.

**A switch inside a mapped graph.** Today an author can write a graph per element with a switch, and route the
dropped elements to a `refuse`. With `onItemFailure: collect` the map then answers `{ ok, value }` for every
element. But no node can drop the failed ones, so the answer still has every element. It also turns "not wanted"
into "failed", which a report then shows as a failure. Rejected.

**`@std/list#keep` with the rule as a string input.** One operation, no schema change to the map. But the rule
would be a value handed to a handler. The checker would have to learn that one input of one operation is an
expression over another input's element type, and the rehearsal cannot steer a decision taken inside a handler.
#855 says it directly: filtering "belongs on the node ... so the checker types it and `rehearse` can steer it".
Rejected.

**A fourth node type, `keep`.** `{ "type": "@wilanis/node/keep.schema.json", "over": ..., "where": ... }` reads
plainly and leaves `map` as it is. `model.md` already says a fourth node type is a compatible change. It costs
about as much: every place that switches on a node's type learns it, as every reader of `run` learns `callOf`. It
gives up `where` on a map that runs something, which is the same rule with an operation after it. And it is two
words for one idea: "the elements a rule holds for". The review chose one node with an optional part (*Open
questions*, 1).

**`run` stays required; a keep is a `#make` of the element.** No schema change beyond `where`. The author writes
`"run": "@std/object.port.json#make", "bind": { "value": "" }, "in": { "type": "<the element's shape>" }` to keep
elements unchanged. That is a call per element whose only job is to say "nothing", and it is a made site of the
shape (`sitesOf`), so a shape with an invariant gets a guard per kept element that judges a value already judged.
It is the kind of tax #791 was written about. Rejected.

**Group and sum as two operations.** `group` answers `{ key, items: $T[] }[]` and `sum` adds a `number[]`. Each
is smaller. But a graph cannot then put a sum beside its key: a map over the groups answers sums in order, and
nothing joins two lists by index. The author would need a graph per group. `totals` answers the pair the
consumer needed in one step. `group` can come later, when a tree needs the elements of each group.

**Parallel lists instead of paths.** `totals` could take `keys: string[]` and `values: number[]`, each made by a
map running `#make` with `"bind": { "value": "tier" }` and `"in": { "type": "string" }`. That needs no new
keywords, since `bind` is already typed (G012). But it costs two maps per total, and the two lists must have the
same length, which the checker cannot say. Rejected for the keywords, which also serve any later operation that
takes a path within an element (sorting by a field, for one).

**The `@std` plugin's own `check`.** `totals` could type its paths in an X rule of the `@std` plugin, with no
schema change. But a plugin's `check` sees the scope, not the typed reads of a graph
(`PluginCheckContext` in `packages/core/src/plugin.ts`). To know the element type of `{{all}}` it would have to
type the graph again, which is the compiler's work done a second time. Rejected under "a rule lives in one place".

## Open questions

Decided in review on #919:

1. **`run` becomes optional on a map.** One node for "the elements a rule holds for", with or without an operation
   after it. The fourth node type `keep`, and a required `run` with a `#make` per element, are the alternatives
   above, not taken.
2. **G011 is widened** to a map's `where`. The rule is the same ("a rule answers a boolean over typed inputs") and
   so is the fix; a new code would split one rule in two places.
3. **`within` and `reaches` are keywords** on a native contract's field, so the compiler types a path within the
   element in one place.
4. **`totals` is written as above:** one operation; `sum` is 0 when no `sum` is given; the key is a string only;
   totals come in the order each key first appears. A total with no `sum` could leave `sum` absent instead, but
   then every read of `{{t.sum}}` into a required number would need a switch first ("No absence", `model.md`).
5. **This RFC lands before 1.0, in M14.** Every change is compatible, but each changes a schema, and M14 cuts 1.0
   "only when every accepted RFC that changes a schema has landed or been withdrawn". The freeze waits for it;
   `docs/roadmap.md` says so in M14's paragraph, and #855 carries the M14 milestone.

May be decided during implementation, or later:

6. **Does a `has()` in a `where` narrow the kept element?** Today `has(x)` in a switch's rule proves `x` present for
   the routed node. A `where` could do the same for each element of its answer, so a later map could read
   `item.active` without a `has()`. That needs a type for "this shape, with `active` required", which the type
   system does not have; `nodeOut` would have to make one. Recommendation: not in this RFC; wait for a tree that
   needs it.
7. **Should a `where` count toward an invariant where a `#make` retypes the kept element whole?** Rule 3 above says
   no. Recommendation: keep it no until a tree shows a guard that this would remove.
8. **Two keys.** The consumer's `risk` counts per module and per priority. With this RFC that is a keep per
   priority and a `totals` by module after each. A `by` that takes a list of paths would do it in one node.
   Recommendation: wait for a second tree.
