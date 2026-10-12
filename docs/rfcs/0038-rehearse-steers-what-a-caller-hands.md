# RFC 0038: Rehearse steers what a caller hands: a graph's `in` followed out through maps and calls

- **Status:** draft
- **Areas:** `area:runtime` (`branches.ts`, `frames.ts`, a new `demands.ts`, `rehearse-held.ts`,
  `rehearse-reached.ts`, `rehearsal-report.ts`, the template's loop step 2), `area:compiler` (one private method
  exported, `takesWhole`).
  Nothing in core, the engine, a plugin or the viewer. No schema changes.
- **Tracking issue:** #850
- **Depends on:** RFC 0018 (implemented: the walk, `NEVER RUN`, the recorded unreachable scenario). RFC 0035
  (implemented: a guard on `in` held upstream, #625). Issue #904, landed in #928 (commits 60abb1db and d4578624): a
  stubbed mapped list holds exactly one element (`ONE_ELEMENT` in `nonEmpty`), a read of `in` reaches the element
  through calls that hand it down as they got it, the binding wrapper `<map>.0.op` among them (`elementPathOf`), and
  a read is mapped through the map's `bind` (`handedAs`, `throughBind`, `FoundList.bind` and `FoundList.unwrapped`).
  This RFC builds on that code and does not specify it again. It amends one sentence of RFC 0035 and what RFC 0018's
  `NEVER RUN` says; on acceptance, both headers gain `Amended by: RFC 0038`.
- **Order with RFC 0039** (#919, keep and group a list): RFC 0039 edits `meet` and `switchesOf` and relies on the
  element walk this RFC rewrites. This RFC lands first, and RFC 0039 follows the spec written here: the trace in
  `frames.ts`, `meet` in `demands.ts`, and `FoundList.in` beside `bind`.

## Summary

Today `wilanis rehearse` can steer a switch or a guard that reads `in` in two cases only: `in` is still the
trigger's own input, or `in` is the element of the map that runs the switch's graph. Every other read of `in` is
reported `NEVER RUN -- ... comes from nothing the rehearsal sets`. After this RFC, the rehearsal follows each read of
`in` outward, one frame at a time, through calls and through maps, until it names something it can set: a node's
answer, an element of a list a node holds, or the trigger's input. A map is followed like a call: each name it
hands its operation is either a field of the element (`bind`, or `item`, which #904 already follows) or a value its
`in` hands every element, which this RFC follows too.
So a value a map hands each element beside the element, a value a calling graph copies from a node into the called
graph's `in`, and a guard on each element a map writes are all steered. A demand never lands past a guard: where the
trace meets a guard's answer, it is written into what the guard judges. Where the trace stops -- text composed from
reads, a list written out, `context`, a literal or a constant -- the branch stays `NEVER RUN`, and the sentence says
where the trace stopped, why, and what edit makes it steerable. A branch that a literal or a constant closes on one
path, and that a run takes on another, is not a problem, as a branch held upstream is not.

## Motivation

One consumer tree (review-harness, `GAPS.md`) met this five times. Each time the author rewrote the tree around the
rehearsal, not around the business.

- **M2: a value a map hands each element.** `scan.graph.json` maps `triage.port.json#judge` over the findings and
  hands each element the previous run's id: `"in": { "runId": "{{runId}}", "previousRunId": "{{latest.run.id}}" }`.
  A switch on `in.previousRunId` inside the judging graph is `NEVER RUN`. The author split the operation in two,
  `#judge` and `#judgeFirst`, and chose between two maps with the switch `isThereABaseline`.
- **M12: the element itself, behind a binding.** A switch on `in` in a graph a map reaches through a port and a
  binding stands at `<map>.0.op`, and the rehearsal took the element only at exactly `<map>.0`. The author had a node
  of the graph answer what the switch reads (`facts` in `priority.graph.json`, `seen` in `diagram.graph.json`), so
  the rehearsal stubs that node. #904 (#928) fixed this part: it is on `main`, and this RFC only builds on it.
- **M16 (second half): a value a calling graph hands.** A switch on `in` that the calling graph composed or copied
  from one of its nodes is `NEVER RUN` (`meet` in `branches.ts`). The author made the value a node's answer in the
  called graph (`GraphVolatileFiles.shape.json` and node `counted` in `activity-report.graph.json`; node `asked` in
  `commit-to-review.graph.json`).
- **Item 12: a guard on each element a map writes.** `refresh.graph.json` maps `site.port.json#write` over
  `{{plan.writes}}`. The write's data graph takes a guarded shape as its `in`, so the compiler lowers a guard at
  `in:check` for each element. Both branches are `NEVER RUN`. The author moved the invariant from each write to the
  whole plan (`writes-name-nothing-private.invariant.json` on `Plan.shape.json`) and wrote the reason into the
  invariant's description.

After #904, the cause is one gap in the walk, in two places:

- At a map, `atNode` records how the map hands each element (`handedAs`: its `bind`, or `item`; and `unwrapped` for a
  list guard's nested spec), but not the map's own `in`, the values it hands every element alike. `throughBind` in
  `frames.ts` says so: a name the map does not bind "comes from the map's own `in`, so steering the element would not
  move it". So nothing can follow such a read out of the mapped graph.
- `meet` in `branches.ts` answers `'unreachable'` for every read of `in` that is neither the trigger's input
  (`at.steerable`) nor the element, reached through calls that hand it down unchanged (`elementPathOf`). The doc
  comment of `elementPathOf` says why: "Nothing where a call composes the value or takes it from a node of its own,
  since steering the element would not move it then." A value a call takes from a node is exactly what can be
  followed, to that node.

The code already follows `in` outward in three narrower places, all through `handedOut` and `passedAs` in
`frames.ts`. `heldOutwards` follows the list a map runs over out to the node that holds it (`listHolder`,
`ownInputAt`). `tracedOut` follows a guard's inputs out to one node, but only to ask whether that node already judged
the value (`upstreamOf`, `heldUpstream` in `rehearse-held.ts`). `elementPathOf` follows a read out to the element.
None crosses a map, and none is used to steer an ordinary switch to a node.

RFC 0035 described what happens to a guard on `in` whose value nothing judged upstream, in terms of the walk as it
was (lines 259-261):

> This is a statement about one run path, not a proof: the guard stays in the lowered spec, and a caller that hands
> the data graph a value no guard judged -- a trigger firing `keep` directly, a field composed on the way -- is
> steered through it, or reported as a branch that can never run, as before.

"As before" meant: steered when the value is the trigger's own input, `NEVER RUN` otherwise. The new evidence is
that "otherwise" is most of a real tree: a value copied from a node, or handed through a map, which the rehearsal
can set. This RFC keeps RFC 0035's rule for a value held upstream, and changes "as before" to "followed out, as
this RFC says". `rehearse-held-guards.test.ts` pins the old behaviour in one case ("is still unreachable where the value is
not the one upstream judged"), and that case changes (see *Tests*).

Two small parts of #850 are not in this RFC:

- *Exactly one element*, *the binding wrapper* and *the element read through `bind`* are #904, landed in #928.
- *The wrong message* ("is the trigger's own input", the issue's fourth bullet) was fixed by #844 (commit 1d69cfbd):
  `uncoveredBy` now says "comes from nothing the rehearsal sets". This RFC makes that sentence precise.

This RFC does not try to:

- steer more than one element of a list (the first element stands for all, as #904 made true);
- invert a composed value, such as text with reads in it;
- vary `context`, which the trigger kind and the guard hand;
- change how a switch in the same graph as the node it reads is steered;
- add a checker rule, a document kind or a field.

## Guide-level explanation

**A frame** is a call the walk entered to reach a switch: its path, and what it hands the spec it runs. The walk
keeps the calls since the last map as frames (`FoundSwitch.from`, `FoundList.from`), and each map it entered as a
`FoundList`. A map hands its operation two kinds of value. The element arrives under the names in `bind` (each one a
path inside the element, `""` for the whole element), or whole as `item` when there is no `bind`. Every name in the
map's `in` is *broadcast*: every element gets the same value (`elementInputs` in `packages/engine/src/map.ts`).
Since #904 the rehearsal follows the first kind. After this RFC it follows the second too, and it goes on past the
map, out through the frames the map stands in.

**The trace** is how the rehearsal finds what to set for a read of `in`. It starts at the switch's input, for example
`in.previous`, and walks the frames from the innermost outward. At each frame it asks what the frame handed under that
name. A frame that hands its own `in` on unchanged is a step with no change. A name the frame copies from a node ends
the trace at that node. A name the frame copies from its own `in` continues one frame further out. A bound name of a
map ends at element 0 of the list the map runs over. The trace stops early at anything it cannot set, and says so.

Here is the case the consumer met, in the small tree `nonemptyTree` that `packages/runtime/test/rehearse-stubs-trees.ts`
already builds. `all` scans, makes an `Info`, and judges each finding. The map hands each element two fields of the
finding and, beside them, the scan's run:

```json
{
  "type": "@wilanis/node/map.schema.json",
  "id": "judged",
  "run": "@features/rv/domain/triage.port.json#judge",
  "over": "{{scanned.findings}}",
  "bind": { "score": "score", "name": "name" },
  "in": { "previous": "{{info.run}}" }
}
```

The test tree copies the element into a node, `facts`, and switches on that; it was written before #904. Since #904
a switch on `in.score` is steered, but a switch on `in.previous` is not. After this RFC the author writes what they
mean:

```json
{
  "label": "Judge",
  "in": "@features/rv/domain/JudgeIn.shape.json",
  "out": { "type": "@features/rv/domain/Verdict.shape.json", "from": ["high", "first", "low"] },
  "nodes": [
    {
      "type": "@wilanis/node/switch.schema.json",
      "id": "isHigh",
      "in": { "score": "{{in.score}}" },
      "rules": [{ "when": "score > 5", "to": "isFirst" }],
      "else": "low"
    },
    {
      "type": "@wilanis/node/switch.schema.json",
      "id": "isFirst",
      "in": { "previous": "{{in.previous}}" },
      "rules": [{ "when": "len(previous) == 0", "to": "first" }],
      "else": "high"
    },
    { "type": "@wilanis/node/run.schema.json", "id": "high", "run": "@std/object.port.json#make",
      "in": { "value": { "name": "{{in.name}}", "level": "{{in.previous}}" }, "type": "@features/rv/domain/Verdict.shape.json" } },
    { "type": "@wilanis/node/run.schema.json", "id": "first", "run": "@std/object.port.json#make",
      "in": { "value": { "name": "{{in.name}}", "level": "first" }, "type": "@features/rv/domain/Verdict.shape.json" } },
    { "type": "@wilanis/node/run.schema.json", "id": "low", "run": "@std/object.port.json#make",
      "in": { "value": { "name": "{{in.name}}", "level": "low" }, "type": "@features/rv/domain/Verdict.shape.json" } }
  ]
}
```

`isHigh` reads `in.score`. The trace goes through the binding wrapper `op` (field for field, a step with no change),
then through the map: `score` is bound to the element's `score`. So the demand lands at element 0 of what `scanned`
answers: `scanned.findings.0.score`. That is #904's case, and it works on `main` today. `isFirst` reads
`in.previous`. Through the map, `previous` is broadcast from `{{info.run}}`. So the demand lands on node `info`, at
`run`. Today the rehearsal prints:

```
features/rv/domain/judge  switch 'isFirst'  0/2 branches
  ??  when len(previous) == 0  NEVER RUN -- previous comes from nothing the rehearsal sets, so the rehearsal cannot vary it
  ??  anything else            NEVER RUN -- previous comes from nothing the rehearsal sets, so the rehearsal cannot vary it
```

After this RFC:

```
features/rv/domain/judge  switch 'isFirst'  2/2 branches
  ok  when len(previous) == 0  answered from 'first'
  ok  anything else            answered from 'high'
```

The example tree has the same shape in `features/customers/domain/backfill-customers.graph.json`: a map of
`customer.port.json#repair` over `{{rawCustomers}}`, bound to `repair-kept.graph.json` and `repair-row.graph.json`,
whose switch `isWhole` reads `in.email` and `in.tier`. The backfill is a startup step, not a trigger, so the
rehearsal does not walk it today; a trigger that fires `#backfill` would be steered the same way.

**A call.** A calling graph that hands `"in": { "level": "{{facts.level}}" }` to a graph whose switch reads
`in.level` is steered at node `facts`, field `level`. An object written out in the call is followed field by field:
`"in": { "meta": { "level": "{{facts.level}}" } }` and a read of `in.meta.level` also land at `facts.level`.

**A guard on each element.** In the consumer's `refresh.graph.json`, `written` maps `site.port.json#write` over
`{{plan.writes}}` with every field bound by its own name. If the invariant stands on `PageEdits`, the write's data
graph has a guard at `in:check`, at `written.0.op.in:check`. It reads `in.privateHits` and `in.links`. The trace
lands at `plan`, path `writes.0.privateHits`. Both branches run: `holds` answers from `in:ok`, and `violated`
refuses on purpose as `invariant`. The author can put the invariant back on each write.

**Never past a guard.** A demand never lands on a guard's answer. Where the trace reaches `<id>`, the answer of a
guard at a made site, it is written at `<id>:made`, the value the guard judges. Where it reaches `in:ok`, it goes on
as `in`, out to the caller. So the upstream guard judges what the rehearsal wrote. If the demand breaks that guard's
rule, the run ends there, and the branch says so.

Take the tree of `packages/runtime/test/rehearse-held-guards.test.ts`. `register-person` makes a `Person` at node
`person` (guarded at `person:check`) and calls `keep`, whose data graph takes a `Person` (guarded at `in:check`).
Suppose the call hands `"name": "{{person.name}}"` and `"email": "{{in.email}}"`. The values do not all come from one
judged node, so the guard is not held upstream. Its `violated` branch demands `len(name) == 0`. The trace follows
`name` to `person`, and writes the empty name at `person:made`. `person:check` judges it first:

```
features/people/data/keep-person  guard 'in:check' A person is reachable  1/2 branches
  ok  holds     answered from 'in:ok'
  ??  violated  NEVER RUN -- the rehearsal did not reach it: the run ended at 'person:violated' in features/people/domain/register-person, which refused as invariant
```

This is the truth about that path: the name comes from `person`, which a guard of the same rule already judged, so
`keep` can never be handed an empty one there. A stub written past `person:check`, at `person`, would show a run
the tree can never make. Where every input the guard reads is copied from one judged node, the branches are held
upstream, as RFC 0035 says, and nothing changes.

**What stays `NEVER RUN`, on purpose.** The trace stops at a value nothing in the rehearsal can set without lying
about the tree. The sentence names the field, the place the trace stopped, and the edit:

| Where the trace stops | What `NEVER RUN` says |
|---|---|
| text with reads in it (`"{{a}}-{{b}}"`), or a list written out | `in.label is composed at 'judged' in features/rv/domain/all, so the rehearsal cannot vary it: hand it as one read of a node, or decide before the call` |
| `context` | `in.who reads context.principal at 'asked' in features/rv/domain/all, which the rehearsal does not vary` |
| an element of a list that is composed or literal | `in.score is an element of the list composed at 'judged' in features/rv/domain/all, so the rehearsal cannot vary it` |
| anything else the trace cannot name | `in.x comes from nothing the rehearsal sets, so the rehearsal cannot vary it` (today's sentence) |

A literal and a constant are different. The tree fixes the value, so a run on that path always hands it. Where the
literal meets the branch's demand, the case needs no steering and runs. Where it does not, the branch is *closed on
this path*: no run of the tree takes it there. That is a fact about the tree, not a gap in the walk:

```
  --  anything else  closed on this path: 'judged' in features/rv/domain/all hands the literal 'full'
```

A closed branch is not a problem when another path runs it, as a branch held upstream is not. When every path closes
it, no run of the tree takes it at all, and it is `NEVER RUN`, a problem:

```
  ??  anything else  NEVER RUN -- every caller hands a literal it excludes: 'judged' in features/rv/domain/all hands 'full'
```

## Reference

### Documents and schemas

None. No document kind, field or schema changes. A recorded unreachable scenario's `expect.unreachable` is free text
(RFC 0018); it now holds the new sentences.

### Ports, operations and kinds granted

None.

### Checker rules

None. The rehearsal changes; the checker does not.

### Runtime behaviour

All of it is in `packages/runtime/src`, beside one function the compiler exports (`takesWhole`, below).

**1. A map hands two kinds of value, and the walk records both.** `FoundList` already says how a map hands each
element: `bind` (the lowered `bind`, or `{ item: [] }` where it binds nothing) and `unwrapped` (a list guard's nested
spec reads its `in` as the element), both from `handedAs` in `frames.ts`. It gains the map's own `in`:

```ts
export interface FoundList {
  // at, over, fromTriggerIn, from, bind, unwrapped: as on main
  /** The sources the map hands every element alike, by name: its lowered `in`. A name here is never in `bind` (G006). */
  in?: Record<string, unknown>;
}
```

`handedAs` returns it beside `bind`, so `atNode` changes by nothing but what `handedAs` answers. The walk keeps
emptying `entered` at a map, as it does today: the whole way out from a switch is already in hand, as
`found.from`, then the innermost list, then that list's `from`, then the next list out, and so on to the trigger's
spec. A call into a graph that takes its input whole is *unwrapped* in the same sense as a list guard's spec: the
call hands it `{ in: <source> }`, and the graph reads that source as its `in` (`nestedRoots` in
`packages/compiler/src/compiler.ts`). So `Frame` gains the same word, not a new one:

```ts
export interface Frame {
  at: string;
  in: Record<string, unknown>;
  /** True where the spec the call runs takes its input whole, handed under the one key `in`. */
  unwrapped?: boolean;
}
```

`atNode` sets it from `takesWhole` in `packages/compiler/src/compiler.ts`, the one place that decides it. That is a
private method of `Compiler` today; it becomes a function the compiler exports, so the rehearsal asks it rather
than deciding again. Today `passedAs` reads such a frame only for a whole read (`path` empty), and calls any deeper
read composed.

**2. One trace.** `frames.ts` gains one function that follows a read outward through the frames and the maps:

```ts
/** A read of `in` followed out through the calls and maps that handed it down: where it lands, or where and why it stopped. */
export function traced(read: { ref: string; path: string[] }, found: Pick<FoundSwitch, 'from' | 'lists'>): Landed | Stopped;
```

It walks `found.from` from the last frame to the first, then the innermost list as a map hop, then that list's
`from`, and so on out. A read `in.<name>.<rest>`:

- in a frame that hands nothing by name (the binding wrapper, `op`): unchanged, one frame further out;
- in an `unwrapped` frame: the frame's source for `in`, with `<name>.<rest>` under it;
- at a map, where `throughBind` maps the read into the element (a bound name, `item`, or an `unwrapped` guard spec):
  the element at that path. It lands at element 0 of the list `over` reads, which `listHolder` finds, as `ofElement`
  writes it today;
- at a map, where `<name>` is one of the map's `in` sources: that source, with `<rest>` under it, read in the frames
  the map stands in;
- in a call frame, where `<name>` is one of its `in` sources: that source, with `<rest>` under it. A `ref` source
  continues; an `object` source is entered at the next path segment; anything else stops the trace.

The trace lands when a source names something other than `in`:

- a node of the frame's spec: `{ node, prefix, path }`. Where the node is `<id>`, the answer of a guard at a made
  site, the landing is `<id>:made`; where it is `in:ok`, the trace goes on as `in`. A guard is read by the ids the
  compiler gave it (`guardsOf`, `idsOf`), as `heldUpstream` reads it. This holds for traced demands only: a switch
  that reads a node of its own graph is steered at that node, as today (decision 2, see *Decisions*).
- an element of a list a node holds, as above;
- the trigger's input, where the frames and maps run out on `in`: `{ input: path }`.

It stops, with the place and the reason, at:

- `concat` (text with reads in it) or `list` (a list written out): `composed`;
- `value` (a literal): `literal`, with the value;
- `const`: `literal`, with the value of the constant from the graph's `constants`, where the graph declares it;
- `context`: `context`, with the path;
- a list `over` that is composed or literal, for a bound name: `composed list`;
- a name the frame or map does not hand at all: `nothing`, today's sentence.

`traced` replaces five helpers of `frames.ts`: `handedOut`, `passedAs`, `heldOutwards`, `tracedOut` and
`elementPathOf`. `throughBind` stays, as the map hop's first case. `handedAs` stays, and answers `in` too.
`listHolder`, `ownInputAt` and `upstreamOf` read through `traced`, so the list a map runs over is found across an
outer map too, and `frames.ts` stays one module about frames.

**3. `meet` follows the trace, in a module of its own.** `branches.ts` is at about 296 of the 300 lines the house
rules allow, so the demand side moves out. A new module, `packages/runtime/src/demands.ts`, holds where one demand is
met: `meet`, `ofElement`, `ofInput`, `stubTarget`, `standIn`, `write`, `lay` and the `At` interface, moved from
`branches.ts` as they are, and the new landings. `branches.ts` keeps the walk (`switchesOf`, `atNode`), the lists
(`nonEmpty`), and the cases (`casesFor`, `steer`), and imports `meet` and `lay`. In `meet`, the first case stays: a
read of `in` where `in` is still the trigger's own (`at.steerable`) is a patch to the input. Every other read of `in`
is traced:

- landed on a node: a stub, through `stubTarget` as today (so a call a binding meets by delegation is stubbed at its
  effect, `<path>.op`). A node that is a map is stubbed at `<map>.0`, as `ofElement` does today;
- landed on an element: `ofElement`, as today;
- landed on the trigger's input: a patch, as `ofInput` makes one;
- stopped at a literal: no demand where the literal meets it (`fits` in `domains.ts`); `closed`, with the sentence,
  where it does not;
- stopped anywhere else: `unreachable`, with the sentence.

`At.element` and `At.frames` give way to the `FoundSwitch` the trace reads. `Case` gains `why?: Record<string,
string>`, the sentence for each field in `unreachable`, and `closed?: string`. `uncoveredBy` in
`rehearse-reached.ts` joins the sentences. A field with no sentence keeps today's.

**4. Held across a map.** `heldUpstream` in `rehearse-held.ts` reads `upstreamOf`, which now crosses maps. A guard's
value that lands at element 0 of a node that is a guarded *list* site of the same shape (`Guard.arity === 'list'`,
whose map judges every element) is held there. Without this, a demand on such a guard would be written at the
list's `<id>:made`, judged by the list's own guard first, and read as "did not reach it".

**5. The report.** `Decision['branches'][number]` in `rehearsal-report.ts` gains `closed?: string`. `branchLine`
prints it as `--  <branch>  closed on this path: <sentence>`, and it is no problem. `mergeBranch` treats it as it
treats `held`: a run on another path stands for it. A branch closed on every path is printed as `NEVER RUN -- every
caller hands a literal it excludes: <sentence>` and is a problem. `recordedOf` (`rehearse-recorded.ts`) records a
closed branch as it records an unreachable one, with the sentence; `regress` re-solves it as it re-solves an
unreachable one (`solvedAgain`), so a caller that stops handing the literal reads `is reachable now`.

**What does not change.** The solver (`solve.ts`, `domains.ts`). `reach` and `answering`: they call `casesFor`, so a
switch they steer is steered by the trace too. The engine and every plugin; the compiler only exports `takesWhole`.
`fuzz --edges`. A switch that reads a node of its own graph is steered at that node, as today, even where the node is
a guard's answer (decision 2).

### Discoverability

- `wilanis rehearse` prints the new sentences and the `closed` lines above.
- A recorded unreachable scenario's `expect.unreachable`, and `wilanis describe <scenario>` and the viewer's
  scenario page that print it, carry the new sentence.
- `packages/runtime/templates/CLAUDE.md`, loop step 2: the paragraph #944 added ("Rehearse steers three things: ...
  A value that a map's own `in` gives or that a caller composes stays `NEVER RUN` ...") is replaced by: "Rehearse
  steers a value a switch or a guard reads where it can follow it to something it sets: the trigger's input, a node's
  answer, or an element of a list a node holds -- through every call and every map on the way, including a value a
  map's `in` hands every element. It never writes a value past a guard a caller's value went through. To steer a
  switch inside a map, it gives the list it sets one element; a literal or composed list keeps what it has. Text
  composed from reads, a list written out and `context` stop it, and `NEVER RUN` names the node where it stopped:
  hand the value as one read of a node there, or decide before the call. A literal or a constant closes the branches
  it excludes on that path; that is fine where another path runs them."

### Plugin contract

None.

## Compatibility

No schema changes, so IR v1 is untouched. Every document validates and keeps its meaning.

What changes is the rehearsal's output, and so what `--record` writes:

- A branch that was `NEVER RUN` and is now steered runs. Its recorded unreachable scenario reads `branch ... is
  reachable now` under `regress`, and `rehearse --check` lists the file stale and a new one missing. This is the diff
  RFC 0018 designed for: `rehearse --record` rewrites it.
- A branch that stays `NEVER RUN` has a new sentence, so its recorded file is stale under `--check` once.
- A branch that is now steered can steer other branches' runs through `answering` and `reach`, so other recorded
  files of the same trigger may change too.
- The example and `libraries/access` rehearse with no `NEVER RUN` today, so their recorded directories should not
  change. `committed-scenarios.test.ts` and `access.test.ts` hold that, and each step below runs them.
- One test pins the old behaviour: `rehearse-held-guards.test.ts`, "is still unreachable where the value is not the
  one upstream judged". Its expectation changes (see *Tests*). That is the amendment to RFC 0035.

## Tests

All in `packages/runtime/test/`. Each tree passes `checkTree` first, as the existing rehearse tests require. The
element read through `bind` and through the binding wrapper is #904's, and `rehearse-map-element.test.ts` already
holds it; it must pass unchanged once `traced` replaces `elementPathOf`. The trees
go in a new `rehearse-handed-trees.ts`, built with the helpers `rehearse-stubs-trees.ts` exports (`treeOf`, `map`,
`decide`, `make`), since that file is near the house limit. The cases go in a new `rehearse-handed.test.ts`.

- **A value a map broadcasts (M2).** The `isFirst` switch above: both branches settle; the stub is at `info`, path
  `run`.
- **A value a call copies from a node (M16).** A graph calls a port operation with `{ "level": "{{facts.level}}" }`;
  the bound graph switches on `in.level`. Both branches settle; the stub is at `facts`.
- **An object written out.** The same with `{ "meta": { "level": "{{facts.level}}" } }` and a read of
  `in.meta.level`.
- **A rename on the way.** A call hands `{ "tier": "{{in.level}}" }` and the trigger's input carries `level`: the
  case patches the input at `level`.
- **A guard on each element (Item 12).** A map of a port operation over a node's list, bound to a data graph whose
  `in` is a guarded shape: `in:check` settles `holds` from `in:ok` and `violated` as `invariant`.
- **Held across a map.** The same, where the list is a guarded list site of the same shape upstream: both branches
  `held upstream by guard '<id>:check'`.
- **The amended case.** `rehearse-held-guards.test.ts`, the `draft` variant, which hands `"name": "{{in.name}}"` and
  `"email": "{{person.email}}"`. The solver's `violated` case demands only `len(name) == 0` (checked against the
  built solver: `branchesOf` answers `{ name: { maxLen: 0 } }` for the else). The trace follows `name` to the
  trigger's input and patches it. So `in:check` is `2/2`: `holds` answers from `in:ok`, and `violated` refuses on
  purpose as `invariant`. The test is renamed "is steered where the value is not the one upstream judged". The other
  three cases of that file do not change.
- **Never past a guard.** A fourth variant of the same tree hands `"name": "{{person.name}}"` and
  `"email": "{{in.email}}"`: `in:check` is `1/2`, and `violated` is `NEVER RUN -- the rehearsal did not reach it:
  the run ended at 'person:violated' in features/people/domain/register-person, which refused as invariant`.
- **What stays.** Text composed from two reads: the `composed` sentence naming the node and the graph. `context`: the
  `context` sentence. A literal that meets the rule: the branch settles. A literal that excludes it, on the only path:
  `NEVER RUN -- every caller hands a literal it excludes`. The same graph reached by a second trigger that hands
  another value: the branch settles there, and the first path prints `closed on this path`; the rehearsal is ok.
- **Recorded.** `rehearse --record` on the tree with one literal caller writes the closed branch as an unreachable
  scenario with the sentence, and `regress` answers `same`. Change that caller's literal to one the branch accepts:
  `regress` answers `is reachable now` for that file, and `rehearse --check` lists it stale.
- **Nothing else moves.** `committed-scenarios.test.ts` (the example's directories, byte for byte) and
  `libraries/access/test/access.test.ts` pass unchanged, and so does every existing `rehearse-*.test.ts`.

## Implementation plan

Each step is one pull request and one sub-issue of #850. #904 has landed (#928), so step 1 can start once this RFC is
accepted. RFC 0039 (#919) follows this plan's step 2, since it edits `meet` and `switchesOf` after them.

1. **One trace, and `meet` in its own module.** Move `meet` and its helpers from `branches.ts` to `demands.ts` as
   they are (no change of behaviour). `FoundList.in` from `handedAs`; `Frame.unwrapped` from `takesWhole`, which the
   compiler exports. `traced` in `frames.ts` replaces `handedOut`, `passedAs`, `heldOutwards`, `tracedOut` and
   `elementPathOf`; `listHolder`, `ownInputAt`, `upstreamOf` and the element case of `meet` read through it. The
   tests: every existing rehearse test unchanged, `rehearse-map-element.test.ts` among them.
2. **`meet` follows the trace.** Landings on a node and on the trigger's input; never past a guard. The tests: M2,
   M16, the object, the rename, Item 12, and the changed `draft` case.
3. **Held across a map.** `heldUpstream` over a guarded list site. The test: held across a map.
4. **Why the trace stopped.** The stop reasons, `Case.why` and `Case.closed`, the sentences in `uncoveredBy`, the
   `closed` line and `mergeBranch` in `rehearsal-report.ts`, `recordedOf` for a closed branch. The tests: what stays,
   and recorded. (`good first issue` once steps 1 and 2 have landed: the sentences and the report are small and
   self-contained.)
5. **Say it.** The template's paragraph in loop step 2, in place of the one #944 added; `Amended by: RFC 0038` in the headers of RFC 0018 and RFC
   0035; the consumer can then remove its workarounds (`facts`, `seen`, `counted`, `#judgeFirst`, and the
   invariant on `Plan`), which is theirs to do.

## Drawbacks and alternatives

**Cost.** Each demand on `in` walks the frames and maps out from the switch once. The walk already keeps them
(`found.from`, each list's `from`), so nothing new is carried. They are few (one per call or map on the way), so the
cost is small next to the runs the rehearsal makes. `frames.ts` gains one function and loses five; `branches.ts`
loses the demand side to `demands.ts`.

**The literal's `closed` state is new.** It adds one state to a branch beside `held`. Without it, a data graph that
two callers call with two different literals would read `NEVER RUN` on each path for the branch the other runs, and
the rehearsal would fail on a tree that is correct.

**Never past a guard can hide a branch that is reachable.** A demand written into `<id>:made` changes only the
field the switch reads. If the upstream rule reads that field too, the stand-in may break it where a real value
that changes another field as well would not. The branch then reads "did not reach it: the run ended at
'<id>:violated'". That sentence names the guard, so the author sees why. The other choice, writing past the guard,
shows runs the tree can never make, which is worse for a tool whose output is trusted as coverage.

**A stub can still hold what no real run holds.** Never past a guard covers only the demands this RFC adds. The
rehearsal already stubs pure nodes to steer other decisions: `answering` steers `person:check` to `holds` by
stubbing `person:made`, whatever the trigger's input says. So in the amended `draft` case, the patched empty `name`
reaches `keep` while `person:made` holds a generated name. The rehearsal then reports `violated` reached, though no
real run reaches it: a real `person:made` reads the same empty name and `person:check` refuses first. Today the same
branch is `NEVER RUN`, for the wrong reason. This comes from how every rehearsal run is built (RFC 0018, #844), not
from the trace, and this RFC does not change it: issue #950 holds it (decision 3).

**Alternatives considered.**

- *Do nothing; teach the workaround.* The template says what cannot be steered, and the author copies the value
  into a node of the graph that reads it (`@std/object.port.json#make`), or decides before the call. That works,
  and the consumer did it five times. But it adds a node or an operation that exists only for the tool, it moves an
  invariant away from the value it is about (Item 12), and it doubles an operation (M2). The tree should say the
  business; the tool should read it.
- *Stub the called graph's `in` directly.* The engine would accept a stub for a call's input. That needs a change in
  the engine, and it fabricates a value no caller hands: it would pass a literal, a composed text and a guard alike.
- *Run until a seed takes the branch.* RFC 0018 rejected guessing: the solver reads the rules so that no branch is
  left to chance.
- *Invert composed values.* Parse `"{{a}}-{{b}}"` back into `a` and `b`. Text does not invert in general; a list
  written out drops missing parts (`readSource` filters `undefined`), so its indexes move. Both stay stopped.
- *Write past a guard,* as a switch in the same graph is steered today. Rejected above.

## Decisions

The maintainer settled these on the pull request (#930), each as recommended:

1. **A branch a literal closes on one path and a run takes on another is not a problem**, as `held` is not
   (`mergeBranch`). A literal is the tree's own choice, not a gap in the walk; keeping today's rule, where the worse
   of two paths wins, would fail a correct tree whose two callers hand two different literals. The `closed` state
   stays.
2. **Never past a guard applies to traced demands only.** A switch that reads a guard's answer in its own graph is
   still steered at that answer, as it is today; this RFC does not change it.
3. **Whether a stub `answering` writes is realistic is its own issue**, #950, since the problem predates this RFC: a
   stub of a guard's `<id>:made` that `answering` writes can hold a value the node's own inputs would never make.

## Open questions

To decide during implementation:

1. Whether `traced` gives up after a fixed number of frames. The walk already stops at a handler it has seen
   (`seen` in `atNode`), so frames are bounded by the tree; a limit seems unneeded.
2. The exact words of each sentence, as long as each names the field, the node, the graph and the edit.
