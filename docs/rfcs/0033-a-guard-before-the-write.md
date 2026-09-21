# RFC 0033: A guard before the write: a field invariant over a value an effect has already stored

- **Status:** draft
- **Areas:** `area:compiler`, `area:runtime`, `area:plugin-storage`
- **Tracking issue:** #510
- **Depends on:** RFC 0007 (invariants: the guard this RFC moves), RFC 0002 (storage: the operations the
  guard lands behind), RFC 0004 (atomic graphs: the rollback option (b) leans on)

## Summary

A field invariant is judged where a value of its shape comes into being, and where the checker cannot prove the
rule there, RFC 0007 lowers a guard at that site. When the value comes out of a store write, the site is behind
the write: the row is committed, the guard refuses the answer, and the store is left holding a row the tree
says cannot exist. Every later read of that row is guarded too, and refuses. This RFC states the failure, lays
out three ways to close it -- guard the write's input, refuse the graph shape that allows it, or both -- and
leaves the choice to the maintainer. It decides nothing.

## Motivation

`Entry` in the example carries the field invariant *An entry names a call*
(`len(url) > 0 && (method != 'DELETE' || has(agent))`). Give it an optional boolean `pinned` and state a
second rule, *A pinned entry is a GET* (`!(has(pinned) && pinned) || method == 'GET'`). Now write the data
graph a toggle wants: `@storage/store.port.json#get` the record, `switch` on `has(record.pinned) &&
record.pinned`, `#patch` the key with `{ "pinned": true }` or `{ "pinned": false }`, and answer the patched
record as `Entry`. `wilanis check` accepts the tree and lowers a guard at the node that answers.

Call the toggle on an entry whose method is `POST`. The patch commits. The guard then fires on the answer and
the route answers `500 invariant`. The row in the store now violates the rule, so `GET /monitor/{id}` over it
answers `500 invariant`, and so does `GET /monitor`, because one violating element fails the list's guard for
every caller -- until the row is removed or, on the memory engine, the process restarts. A rule meant to keep a
bad value out has instead made the store unreadable, and the graph that did it was refused nothing.

`kept-update.graph.json` in `example/` on `main` has the same defect today, without `pinned` and without a new
rule. Its `asked` node patches `url` and `method` from the caller's `EntryUpdate`; its `row` node makes the
`Entry` from `asked.record`; the guard is lowered at `row`. `PUT /monitor/{id}` changing a pinned entry's
method -- or, with the shipped rule alone, changing a `DELETE` entry's method where no agent was recorded --
corrupts the row exactly the same way. The graph is the shape the tree's own example teaches.

**The evidence that this is the graph an author writes.** Run of 2026-09-21, three arenas off `main` at
cc1c8de, each an unsupervised agent given a copy of the example and the same task. Claude Sonnet 5 and Claude
Opus 5 independently wrote the broken toggle and both hit it; the coordinator's validation of the Sonnet tree
records toggle a `POST` entry → `500 invariant`, then `GET /monitor/{id}` → `500 invariant`, then
`GET /monitor` → `500 invariant`. Claude Haiku 4.5 avoided it, but by accident of ordering: its graph happened
to read and decide before patching, so the write was never reached. Opus, on being shown the failure, rewrote
its graph to refuse `unpinnable` in a branch before the patch.

Neither of those is the rule doing its job. **The point of stating a rule once is that no graph has to
remember it.** A workaround that every author must reproduce in every graph that writes is the five
coincidences and a piece of luck RFC 0007's motivation set out to end, moved from the gates to the writes. An
invariant that can be defeated by node ordering is a rule the tree states and does not hold.

This RFC does not propose to make guards transactional in general, does not touch access invariants (they have
no run-time behaviour), and does not design a transition invariant over old and new values of a record -- that
is RFC 0007's deferred class 3, and RFC 0021's machine.

## Guide-level explanation

Nothing in this section is proposed yet; it is what the author sees today, so that each option below can be
read against it.

The tree states the rule once:

```json
{
  "$schema": "@wilanis/invariant.schema.json",
  "label": "A pinned entry is a GET",
  "description": "Only a GET may be pinned to the dashboard.",
  "holds": {
    "on": "@monitor/domain/Entry.shape.json",
    "when": "!(has(pinned) && pinned) || method == 'GET'"
  }
}
```

and the data graph behind the toggle writes, then answers:

```json
{
  "id": "asked",
  "run": "@storage/store.port.json#patch",
  "in": {
    "store": "@monitor/data/entries.store.json",
    "collection": "entries",
    "key": "{{in.id}}",
    "changes": { "pinned": true }
  }
},
{
  "id": "row",
  "run": "@std/object.port.json#make",
  "in": { "value": "{{asked.record}}", "type": "@monitor/domain/Entry.shape.json" }
}
```

`wilanis check` passes. `wilanis rehearse` reports `guard 'row' A pinned entry is a GET  2/2 branches`, and
both branches settle, because the rehearsal judges the graph and not the store. The tree is accepted, the
guard is honest about what it guards, and the store is corrupted on the first call that takes the branch.

## Reference

This section states the problem precisely and then the three options. **It assigns no codes and settles
nothing**: codes, hints and tests are written into this section when the maintainer picks an option, and the
implementation plan is empty until then.

### Where the site falls

`sitesOf` in `packages/compiler/src/sites.ts` calls a node a made site when the native operation it runs
answers the shape or a list of it -- its `returns`, with this call's variables substituted. Every write
operation of `@storage/store.port.json` answers a *wrapper*: `#put`, `#patch` and `#remove` return
`{ record?: $T }`, and `#get` the same. `arityOf` counts only a type that *is* the shape, so **no storage
operation is ever a made site.** The site is always the node downstream that unwraps `.record` --
`@std/object.port.json#make` with `"value": "{{asked.record}}"`, which is the idiom the example teaches and
the one every arena wrote.

So the ordering is structural, not accidental. `#patch` is an effect with no site on it; the site is a pure
node that reads what the effect answered; and `guardsOf` in `packages/compiler/src/guard.ts` asks
`heldWhollyAt` in `check/prove.ts` which sites are unproved and puts the three kernel nodes there. Every part
of that chain is doing what RFC 0007 says. The rule *"guard the value where it is made"* is simply the wrong
rule when the place a value is made is downstream of the effect that stored it.

One consequence worth stating plainly: the corruption is not confined to the call that caused it. A guarded
list site (`#find` answers `$T[]`, which *is* a list of the shape, so it is a site) is guarded element by
element through a `map` with `onItemFailure: 'fail'`. One bad row therefore fails the whole listing, for every
caller, until it is gone. A write that refuses has denied service to reads it never touched.

### Option (a): lower the guard onto the input of the write

Judge the record as it *will be* before `#patch` runs, and refuse before the effect.

*What it catches.* The common shape and the one all three arenas wrote: a `#get` of a key, a decision, a
`#patch` of the same key, answered as the shape. Also `#put`, whose `record` input is already `$T` and needs
no composition at all.

*What it misses.* Anything the compiler cannot compose. `#patch`'s `changes` is declared `unknown` -- a
partial object whose keys are fields of the shape -- so the value the store will hold is the existing record
laid under `changes`, and the compiler only has the existing record when the graph read it, in this graph,
from the same store, the same collection and the same key. Where the key is computed, where the read is in
another graph, where the binding between them is a delegation, or where the engine is one that patches by an
expression rather than a value, there is nothing to compose and the site stays where it is. So (a) narrows
the hole rather than closing it, and the cases it leaves are the ones an author is least likely to notice.

It also says nothing about a concurrent writer: composing read-then-patch is a compile-time guess at the row
the store will hold, and between the `#get` and the `#patch` another run may have changed it. The guard would
be judging a record that was true when read.

*What it would take.* A new kind of site, or a second way to reach one: a *pre-write* site naming the
operation, the input the record is composed into, and the nodes it is composed from. `sitesOf` answers where
a value is, so this is a new question and probably a module beside it rather than a widening of it -- the
composition is storage-specific (`store`, `collection`, `key`, `changes`), and `sitesOf` is deliberately
ignorant of storage. That points at the compiler learning what `#patch` means, which `CLAUDE.md`'s
orthogonality rule warns against; the honest alternative is a declaration on the operation itself -- a port
document saying "my input `changes` patches a record of type `$T` under `key`" -- which is a plugin-contract
change and a schema change, and so its own RFC. `heldWhollyAt` must then be asked about a composed value
rather than a node, `guardsOf` must build a guard that routes the *effect* rather than the value (the effect
becomes the `to` of the guard's switch, which is the shape `G015` already reasons about), and the four ids
RFC 0007 fixed as a contract -- `<id>:made`, `<id>:check`, `<id>`, `<id>:violated` -- have no obvious reading
for a site that is an input. The rehearsal, `describe` and the viewer all read a guard by those ids.

### Option (b): refuse the graph shape

Leave the guard where it is and refuse the tree that can misuse it: an `L` rule over a graph that is not
`atomic` and reaches an effect writing a field some invariant reads, where a site of that shape is guarded
downstream. The hint names `"atomic": true`.

*What it catches.* Every shape of the problem, including the ones (a) misses, because it does not ask what
the record will be -- only whether the write can be taken back. An atomic graph's transaction ends when a node
refuses, so the guard's `invariant` refusal rolls the patch back and the store keeps what it had. The caller
still gets `invariant`, which is the truthful answer, and no row is corrupted. The reads that (a) would have
left broken are never broken.

*What it misses.* Nothing about correctness, but it costs something (a) does not: every such graph becomes a
transaction, on trees and engines where that is not free. `@storage-memory` has no real transaction; every
`@storage/store.port.json` operation is declared `transactional: true`, so L009 and L010 are satisfied, but
what a memory engine's rollback is worth is the engine's business and worth stating in the rule's hint. It
also refuses graphs that are correct today for a reason the author cannot see locally -- the rule is about an
invariant declared in another document over a shape the graph merely stores -- so the refusal must name the
invariant, the field, and the guarded site, or it reads as the checker being arbitrary.

And it hands the author a second way to be wrong: a graph marked `atomic` to silence the refusal, on a tree
whose profile binds an engine whose rollback does nothing. That is a `B`-family question this RFC does not
have an answer for.

*What it would take.* The walk exists. `atomicReachOf` in `packages/compiler/src/check/atomic.ts` already
gathers every effect a graph reaches under a profile, with the node of the graph each descended from, and
L009/L010/L011/G014 are judged over it. The new rule is the same walk asked of a *non*-atomic graph, joined to
the guarded sites `heldWhollyAt` already answers and to which fields each invariant's rule reads (`rootsOf` in
`check/prove.ts`). The narrow judgement is: does this graph reach a write whose `changes` (or `record`) names
a field some unproved invariant over that shape reads. That is one new code in `atomic.ts`, beside the four
that live there, and its sabotage test is `kept-update.graph.json` without `atomic`.

The example must then change with it: `kept-update.graph.json` and every write graph behind `monitor.port.json`
either become atomic or are rewritten to decide before they write, and the template's guidance changes to match.

### Option (c): both

(a) where the record can be composed, (b) everywhere else. The guard stands before the write in the common
shape at no transactional cost, and the rule refuses the graph where it cannot.

*What it costs.* Two mechanisms for one rule, and an author who must read both to know why a given graph was
or was not refused. It also makes the refusal conditional on a compiler capability -- whether the composition
succeeded -- which is a bad thing for a refusal to depend on, because the tree that is refused today is
accepted tomorrow when the composition gets cleverer, and the author cannot tell from their documents which
side of the line they are on. `CLAUDE.md`'s discoverability principle asks that every refusal name the edit
that fixes it; a refusal whose presence depends on an inference the author cannot run is the opposite.

### What is common to all three

Whatever is chosen, the documentation changes that ship with this RFC's pull request are undone by it: the
paragraph in `docs/model.md` under "Invariants are stated once" and the bullet in
`packages/runtime/templates/CLAUDE.md` both tell the author to work around the hole, and both are rewritten to
describe the rule instead once there is one.

RFC 0007's "Decided during implementation" gains an entry either way, because the question it answers --
*what is a site* -- is the one this RFC reopens.

### Documents and schemas

None under any option, unless option (a) is taken in the declarative form: an operation saying in its port
document that an input patches a record. That is a `port` schema change and belongs to its own RFC.

### Ports, operations and kinds granted

None.

### Checker rules

None assigned. Option (b) and option (c) each add one code to the `L` family in
`packages/compiler/src/check/atomic.ts`, written as `L0nn` until the implementing pull request lands. Option
(a) adds no code: it moves a guard, and a guard is not a refusal at check time.

### Runtime behaviour

Under (a), a graph refuses before its effect runs, so a run report shows the `#patch` node never reached
rather than reached and answered. Under (b), the report is as it is today and the transaction's rollback is
what changes, which `rehearse` cannot see -- the rehearsal stubs effects, so neither option is visible to it,
and the rehearsal's guard line (`guard '<id>' <label>  2/2 branches`) is unchanged by either. This is worth
stating because it is the reason the defect reached three arenas: **the rehearsal reports the guard as
working, and it is working; it is standing in the wrong place, and no rehearsal can see that.**

### Discoverability

Under (b), `wilanis describe <graph>` should say which invariant forced the graph to be atomic, beside the
guards it already marks `(guard)`. Under (a), `describe` of a guarded site should say it guards an input
rather than a value, since the ids it prints would no longer be the four RFC 0007 names.

### Plugin contract

None, unless (a) is taken declaratively; see "Documents and schemas".

## Compatibility

Additive to IR v1 under (b): one new refusal, no schema change, and trees that never write a shape an
invariant holds over are untouched. Trees that do are refused until they are marked `atomic` or rewritten,
which is a breaking change to `wilanis check`'s answer for an existing tree -- appropriate for a bug, and
the example in this repository is one of them.

Under (a) the lowered spec changes shape for the affected sites, and the four guard ids RFC 0007 fixed as a
contract no longer describe every guard. `rehearsal-report.ts`, `describe` and the viewer all read those ids;
whatever replaces them must be named in this RFC before it is accepted.

## Tests

Written when an option is chosen. Whichever it is, these cases must be in the suite, since they are the
behaviour the arenas found:

- The toggle graph of "Motivation", over the memory engine, on a `POST` entry: the store must not hold a
  violating row afterwards, whether because the write never happened (a) or because it rolled back (b).
- After that call, `GET /monitor/{id}` and `GET /monitor` answer as they did before it. This is the assertion
  that matters most: today they answer `500 invariant`, and a fix that refuses the write but leaves the listing
  broken has fixed nothing.
- `kept-update.graph.json` driven to violate the shipped rule (*An entry names a call*) by updating a `DELETE`
  entry whose `agent` was never recorded.
- Under (b), the sabotage: `kept-update.graph.json` with `atomic` removed → the new `L` code.

## Implementation plan

Empty on purpose. The plan is written when the maintainer picks an option, and is one pull request per step
as usual. The one thing that can be said now is that the documentation this RFC ships alongside -- the
paragraph in `docs/model.md` and the bullet in the template -- is the first thing the implementation removes.

## Drawbacks and alternatives

**Doing nothing and documenting it**, which is what this RFC's pull request ships on its own, is a real option
and should be weighed as one. Its cost is that the tree states a rule it does not hold, and the arenas showed
that an author -- human or agent -- reaches for the graph that breaks it. Its benefit is that the mechanism
stays one rule (`guard the value where it is made`) with no exceptions, and the author who follows the
documented shape is correct.

**Making the guard's refusal a fault rather than a refusal** so that it cannot be mistaken for a declared
outcome was considered and is not an answer: the row is still in the store, and RFC 0007 already decided this
question the other way.

**Guarding on read as well as on write** -- judging a record as it comes out of a store, which is what
happens today -- is not a fix but the mechanism by which one bad row denies service to every listing. If an
option is taken that keeps the store clean, it is worth asking separately whether a read site should stay
guarded at all, or whether the store having been guarded on the way in makes the read's guard a cost with
nothing to catch. That is a question for whoever implements, not for this RFC.

**A transition invariant** (RFC 0007's class 3, RFC 0021's `machine`) states a rule over a record's old and
new values and its sites are exactly the storage operations that replace or patch one. It would put a rule
in front of the write by construction. It is not a substitute: it is a different rule, about what may change,
where a field invariant is about what may be. But whoever implements this should read RFC 0021 first, because
a class-3 site and option (a)'s pre-write site are the same place, and building them twice would be the
mistake.

## Open questions

Every one of these must be decided before `accepted`, and the first is the RFC:

1. **Which option.** (a), (b), (c), or documenting the hole and leaving the mechanism alone.
2. Under (b), what the rule does with an engine whose transaction is nominal. `@storage-memory` declares its
   operations transactional; is `atomic` over it a rollback or a promise?
3. Under (a), what the guard's ids are, given that RFC 0007 fixed four of them as a contract the rehearsal,
   `describe` and the viewer read.
4. Whether the example's write graphs become atomic or are rewritten to decide before they write. The two
   teach different things, and the template teaches whichever the example does.
5. Whether a read site stays guarded once writes are guarded. See "Drawbacks and alternatives".
