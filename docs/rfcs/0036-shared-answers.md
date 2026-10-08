# RFC 0036: Recorded scenarios share their answers: each distinct node answer kept once per directory

- **Status:** draft
- **Areas:** `area:core` (`scenario.schema.json`, a new `answers.schema.json`, `ScenarioDoc`, `AnswersDoc`, `HOME`,
  one module that reads a pointer), `area:compiler` (three `S` rules, S002 over a shared answer), `area:runtime`
  (`writeRecorded` and `checkRecorded` write and compare the shared file; `regress`, `describe` and `ls` read a
  pointer; `wilanis scenarios --pin`), `area:view` (the scenario page reads a pointer; a page for the shared file).
  Nothing in the engine, nothing in a plugin.
- **Tracking issue:** #877
- **Depends on:** RFC 0018 (implemented: the recorded directories, `Owner`, `--check`). RFC 0008 (accepted: the
  freeze of `schemas-v1`, issue #91). Issue #875, which writes each scenario on one line and keeps `--check`'s byte
  comparison; this RFC builds on that rendering and lands after it.

## Summary

The scenarios a command records in one directory share their node answers. A *node answer* is what one node did in
a recorded run: its status, the reason it refused with, the operation that ran, where a switch routed, and what it
answered. Each distinct answer is written once, in an `answers` document at the top of the directory
(`scenarios/rehearsed/answers.json`, `scenarios/edges/answers.json`), keyed by a 16-character digest of its canonical
JSON. A recorded scenario's `expect.nodes` maps each node path to that digest instead of writing the answer again.
On a tree with 738 recorded scenarios, the node answers go from 255 MB to 2 MB, and the scenarios without
indentation go from 318 MB to about 75 MB. The command that owns the directory (`Owner` in
`packages/runtime/src/recorded-dir.ts`) writes, removes and checks the shared file as one more file it owns. A
hand-written scenario still writes its nodes inline, and `wilanis scenarios --pin` copies a recorded scenario out with
every answer inline. Every reader of `expect.nodes` (the S rules, `regress`, `describe`, the viewer) reads a pointer
through one function in core, so each one sees the answer it sees today. The RFC also weighs recording fewer nodes
per scenario, and recommends against it: the nodes it would drop are the only record of what the tree hands a stubbed
effect.

## Motivation

Recorded scenarios cost far more than what they hold.

**What a tree pays today.** Measured on a tree with 738 recorded scenarios:

| Form | Size |
|---|---|
| On disk, indented as `--record` writes today | 723 MB |
| Without indentation (issue #875) | 318 MB |
| Gzipped, file by file | 41 MB |
| In git (packed) | 6.7 MB |

The directory grew from 239 MB to 691 MB over four features. The files hold 268,055 node answers. Only 3,326 of them
are distinct, and those 3,326 take 2 MB. The node answers take 255 MB of the 318 MB.

On this repository's `example/scenarios/`: 121 files, 407 KB on disk, 269 KB without indentation. They hold 1,220
node answers, of which 202 are distinct (31 KB). There the answers are half the bytes (134 KB), because an example
scenario has 10 nodes on average. A scenario of the measured tree has 363.

**Who pays.** Every checkout pays this on disk. Every command that loads the tree pays it in time: the loader
(`walk` in `packages/core/src/paths.ts`) reads every `*.json` under the root, so `wilanis check`, `describe` and the
viewer parse and validate every scenario, and `wilanis regress` then replays each. CI pays it on every run. A tree
becomes expensive to check out and test in the cloud.

**The cause.** `expect.nodes` holds every node of the run, and each answer is written in full in each file. `pick`
in `packages/runtime/src/fuzz.ts` walks the whole report, nested graphs included, and `did` writes each node's
`status`, `reason`, `handler`, `selected` and `out`. Two scenarios that pass through the same graph with the same stub
write the same answers twice. The answer `{"status":"cancelled"}` alone is written 480 times in the example. Nothing
in the format lets two scenarios share an answer.

**What #875 does, and what it leaves.** Issue #875 writes each scenario without indentation: `rendered` in
`recorded-dir.ts` becomes `JSON.stringify(doc) + '\n'`. That halves the bytes for a one-line change, and keeps the
byte comparison `checkRecorded` makes. It does not change the schema, and it leaves every repeated answer in place:
255 of its 318 MB. This RFC removes the repeats.

**What this gives.** Sizes without indentation, after #875:

| | Example (121 files) | Tree with 738 scenarios |
|---|---|---|
| Today, with #875 | 269 KB | 318 MB |
| Node answers in them | 134 KB | 255 MB |
| The same answers, each once | 31 KB | 2 MB |
| With this RFC: scenarios and `answers.json` | about 220 KB | about 75 MB (70 to 80) |

The example's figure is measured: each scenario rewritten with a 16-character digest per node, plus one answers
file. The measured tree's figure is an estimate. It is the 63 MB that are not node answers, plus the 2 MB of distinct
answers, plus one pointer per node: 268,055 pointers of about 37 bytes each (the example's average, with node paths
of 15.5 characters) is 10 MB. Longer node paths add about 0.27 MB per character. I have not measured the result
gzipped or in git.

**What this does not try to solve.** It does not change what a run records (`did` and `pick` are unchanged), what
`regress` compares, or what it prints. It does not share `stubs`, `in` or `context` between scenarios (see Open
questions). It does not change plain `wilanis fuzz`, which writes to `scenarios/fuzz/`, is ignored by git, and keeps
its answers inline. It does not compress anything. It does not share answers between two directories, or between a
tree and the trees it includes.

## Guide-level explanation

**Words.** A *node answer* is the object `did` writes for one node: `{ "status": "done", "selected": "noCustomer",
"out": "noCustomer" }`. A *digest* is a short name computed from an answer's content: the same answer always has the
same digest, and two different answers have different ones. The *answers file* of a recorded directory is one
document, `answers.json` at the top of the directory, that holds each distinct node answer of the directory's
scenarios once, under its digest. A *pointer* is a digest written in `expect.nodes` in place of the answer.

**A recorded scenario.** `wilanis rehearse example --record` writes the `noCustomer` branch of `get-row`, reached from
`GET /customers/{id}`, as below. The file is shown indented here; #875 writes it on one line.

```json
{
  "$schema": "https://raw.githubusercontent.com/wilanis/wilanis-js/main/packages/core/schemas/scenario.schema.json",
  "description": "get-customer: get-row 'outcome' when status == 404 routes to noCustomer, which refuses as missing. Written by wilanis rehearse --record; regenerate it, do not edit it.",
  "generated": "rehearse",
  "trigger": "@features/customers/edge/get-customer.trigger.json",
  "branch": { "graph": "@features/customers/data/get-row.graph.json", "node": "outcome", "when": "status == 404", "to": "noCustomer" },
  "seed": 1,
  "in": { "id": "hotel403" },
  "context": { "...": "as today" },
  "stubs": { "...": "as today" },
  "answers": "@scenarios/rehearsed/answers.json",
  "expect": {
    "status": "failed",
    "reason": "missing",
    "nodes": {
      "op": "6e95cc4702be185c",
      "op.fetched": "d8dbfda2f39b977c",
      "op.outcome": "57a449dbd5d11643",
      "op.noCustomer": "44f43d678904b84b",
      "op.upstreamFailed": "a0af58eabbdc1659",
      "op.unreachable": "a0af58eabbdc1659",
      "op.customer:made": "a0af58eabbdc1659",
      "op.customer:check": "a0af58eabbdc1659",
      "op.customer": "a0af58eabbdc1659",
      "op.customer:violated": "a0af58eabbdc1659"
    }
  }
}
```

Two things changed. `expect.nodes` holds a digest per node instead of an answer. `answers` names the document that
holds those answers. Everything else is what `--record` writes today.

**The answers file.** `--record` writes it beside the scenarios, at the top of the directory it owns:

```
{"$schema":"https://raw.githubusercontent.com/wilanis/wilanis-js/main/packages/core/schemas/answers.schema.json","description":"The node answers the scenarios under scenarios/rehearsed/ share, each once, under its digest. Written by wilanis rehearse --record; regenerate it, do not edit it.","generated":"rehearse","answers":{
"44f43d678904b84b":{"handler":"@std/outcome.port.json#refuse","reason":"missing","status":"failed"},
"57a449dbd5d11643":{"out":"noCustomer","selected":"noCustomer","status":"done"},
"6e95cc4702be185c":{"handler":"graph:@features/customers/data/get-row.graph.json","reason":"missing","status":"failed"},
"a0af58eabbdc1659":{"status":"cancelled"},
"d8dbfda2f39b977c":{"handler":"@http/http.port.json#request","out":{"body":{"active":true,"email":"hotel","extra8":["lima","Zulu-9"],"id":"india","name":"","note":"india","registrar":"bravo","tier":"lima"},"headers":{"extra7":"charlie87"},"status":404},"status":"done"}
}}
```

Each answer is on its own line, in its canonical form, and the lines are sorted by digest. The canonical form is the
exact text the digest is computed from, so anyone can check a line. A pull request that changes behaviour shows, in
this file, the answers added and the answers no scenario needs any more, one line each.

**Replaying.** `wilanis regress example` reads each pointer from the answers file and diffs the run as it does today.
Its lines do not change:

```
scenarios/rehearsed/customers.get-customer/customers.get-row.outcome.noCustomer.scenario.json: DIFF branch 'status == 404' → noCustomer no longer routes there: op.outcome: routed noCustomer → upstreamFailed; ...
```

**Checking.** `wilanis scenarios example --check` compares the answers file as one more file of the directory:

```
stale    scenarios/rehearsed/answers.json
stale    scenarios/rehearsed/customers.get-customer/customers.get-row.outcome.noCustomer.scenario.json
2 file(s) differ from what the solver writes for this tree -- run wilanis rehearse --record and review the diff
```

**Keeping a run by hand.** Today the template's `CLAUDE.md` tells an agent to copy a recorded file into
`scenarios/`, give it a description and drop `generated`. A copy of a file with pointers would point into a file
that `--record` rewrites, and an answer the copy needs could disappear on the next record. So a hand-written scenario
writes its answers inline, and one command makes the copy:

```
$ wilanis scenarios example --pin scenarios/rehearsed/customers.get-customer/customers.get-row.outcome.noCustomer.scenario.json
wrote scenarios/customers.get-row.outcome.noCustomer.scenario.json with every answer inline -- give it a description of your own
```

**The refusal an author meets.** Copy the recorded file by hand and drop `generated`:

```
S0n1  @scenarios/customers.get-row.outcome.noCustomer.scenario.json#expect/nodes/op.outcome
    node 'op.outcome' points at the shared answer 57a449dbd5d11643, and a scenario written by hand holds its answers itself: no command keeps the answers file for it
    → wilanis scenarios --pin <the recorded file> writes the copy with every answer inline; or write this node's answer in place of the digest
```

## Reference

### Documents and schemas

**`common.schema.json`** gains two definitions. Neither changes what any document may say today.

- `$defs/nodeAnswer`: the object a scenario's `expect.nodes` holds today (`status` required; `handler`, `out`,
  `selected`, `reason`), moved here unchanged, with its descriptions, so that `scenario.schema.json` and
  `answers.schema.json` read it from one place.
- `$defs/answerDigest`: a string matching `^[0-9a-f]{16}$`. "The digest of a node answer: the first 16 hexadecimal
  characters of the SHA-256 of its canonical JSON (RFC 8785). It names the answer in the answers document the scenario
  names."

**`scenario.schema.json`** changes in two places.

- `expect.nodes.additionalProperties` becomes `anyOf: [{ $ref: nodeAnswer }, { $ref: answerDigest }]`. "What each
  node did, by its dotted path: the answer itself, or the digest of an answer the document `answers` names holds. A
  command that records writes digests; a person writes answers." A string never meant anything here before, since
  every answer is an object with a required `status`, so the two forms cannot be confused.
- A new optional top-level `answers` (path): "The answers document this scenario's digests name: the `answers.json`
  at the top of the directory the command that wrote it owns. Present exactly when a node is a digest (S0n2)."

**`answers.schema.json`** is a new document kind. Its `$id` is under the published base, its `$schema` enum accepts
the URL and the alias `@wilanis/answers.schema.json`, and it carries the optional `label` every kind carries.

- `description` (required): what the file is, written by the command.
- `generated` (required, enum `rehearse`, `edges`): "The command that wrote this file and owns the directory it sits
  in. It writes the file whole each time it records, so an answer no scenario points to is never kept."
- `answers` (required): an object whose keys match `answerDigest` (`propertyNames`) and whose values are
  `nodeAnswer`. "Each distinct node answer of the scenarios in this directory, once, under its digest."
- `additionalProperties: false`.

Plain `wilanis fuzz` (`generated: 'fuzz'`) writes no answers file, so the enum leaves it out.

**`packages/core/src/model.ts`**: `ScenarioNode` (the node answer type, today written inline in `ScenarioDoc`) is
named and exported. `ScenarioDoc` gains `answers?: string`, and `expect.nodes` becomes `Record<string, ScenarioNode |
string>`. `AnswersDoc extends Envelope` with `generated: 'rehearse' | 'edges'` and `answers: Record<string,
ScenarioNode>`. `Kind` and `DocByKind` gain `answers`.

**A pointer is read in one place.** A new module, `packages/core/src/answers.ts`, holds:

- `canonicalJson(value): string`: RFC 8785. For the values a run records, that is `JSON.stringify` with the keys of
  every object sorted by UTF-16 code unit, the order JavaScript's default sort gives.
- `answerDigest(answer: ScenarioNode): string`: SHA-256 (`node:crypto`) over the UTF-8 bytes of `canonicalJson`, the
  first 16 hexadecimal characters.
- `nodesOf(scenario: ScenarioDoc, answers: AnswersDoc | undefined)`: answers `{ nodes: Record<string, ScenarioNode>;
  unresolved: string[] }`. Each digest is replaced by the answer it names, each inline answer is kept, and a digest the
  answers document does not hold is listed in `unresolved`.

The compiler, the runtime and the viewer all call `nodesOf`, so no reader resolves a pointer its own way.

**Why this digest.** SHA-256 is in Node with no dependency, and its output does not depend on the platform. The
canonical form makes the digest a function of the answer, not of the order in which a run happened to write its keys.
Sixteen hexadecimal characters are 64 bits. Among *n* answers, the chance that two share a digest is about
n² / 2^65: 3 × 10⁻¹³ for the measured tree's 3,326, and 3 × 10⁻⁸ for a million. The writer also checks: two different
canonical texts with one digest refuse the write, naming both, so a collision is never silent. A full digest (64
characters) would add 48 bytes per pointer, about 13 MB on the measured tree, to guard against a case the writer
already refuses. Hexadecimal and not base64: it has no case, so it reads the same on a filesystem that ignores case,
and it holds no character that a shell or a URL treats specially. Base64url would save 5 bytes per pointer, about
1.3 MB on the measured tree.

**Why one file per directory, and who owns it.** A recorded directory has one owner, the command whose `Owner` in
`recorded-dir.ts` names it: `REHEARSED` (`wilanis rehearse --record`) or `EDGED` (`wilanis fuzz --edges`). That
command already writes, removes and checks every file in it. The answers file is one more such file, carrying the
same `generated` mark, so the rules of RFC 0018 hold for it unchanged. One file per tree would have two writers that
run apart, and neither could write the file whole. The cost: an answer both directories hold is written twice. Every
distinct answer of the measured tree takes 2 MB together, so the cost is below that.

**Placement.** `HOME` in `packages/core/src/placement.ts` gains `answers: { dir: 'scenarios', why: 'answers are what
the recorded scenarios beside them share' }`. `misplacedDir` reads only the first segment, so `scenarios/rehearsed/`
is home. The name `answers.json` is fixed, as `feature.json` is.

**`packages/runtime/templates/CLAUDE.md`**: a row for `answers` ("the node answers the recorded scenarios of one
directory share, each once, under its digest; written by `wilanis rehearse --record` and `wilanis fuzz --edges` beside
what they record; regenerate it, never edit it"; home `scenarios/`, at the top of a recorded directory). The `scenario`
row and step 3 say to keep a run with `wilanis scenarios --pin <file>`, where today they say to copy the file. The rule
list's `S scenarios` gains S0n1, S0n2 and S0n3.

**`wilanis new answers`**: not added. An answers file is written only by a command, as RFC 0018 decided for a
scenario.

### Ports, operations and kinds granted

None.

### Checker rules

Codes are placeholders. The implementing pull request takes the next free codes of the S family. The rules live in
`packages/compiler/src/check/scenarios.ts`, beside S001 to S005, or in a `check/answers.ts` beside it if the file would
pass the house rule's 300 lines. `judgeTree` in `checker.ts` judges answers documents where it judges scenarios.

| Code | Where it lives | Refuses when | Hint |
|---|---|---|---|
| S0n1 | `check/scenarios.ts`, at `expect/nodes/<id>` | a scenario with no `generated` writes a digest for a node. Its answers file is rewritten by a command that does not know the scenario, so an answer it needs may disappear | `wilanis scenarios --pin <the recorded file> writes the copy with every answer inline; or write this node's answer in place of the digest` |
| S0n2 | `check/scenarios.ts`, at `answers` or `expect/nodes/<id>` | a node is a digest and the scenario names no `answers`; `answers` names no answers document; the document's `generated` is not the scenario's; or it holds no answer under the digest. Also a scenario that names `answers` and has no digest | `wilanis rehearse --record (or wilanis fuzz --edges) writes the scenarios and their answers file together: run it and review the diff` |
| S0n3 | `check/scenarios.ts`, at `answers/<digest>` of an answers document | the key is not `answerDigest` of the answer under it: the line was edited by hand | `answers.json is written by the command its generated names: regenerate it, do not edit it` |

**S002 reads the answer, wherever it is.** S002 refuses a reason on a node that did not end `failed`. For an inline
answer it is judged as today, at `expect/nodes/<id>/reason`. A shared answer is judged once, in the answers document,
at `answers/<digest>/reason`, since its status and reason are both in that one answer. `checkPinnedReasons` takes a
map of answers, so one function judges both.

**What the checker does not judge.** An answer no scenario points to is not refused. It changes no scenario's
meaning, and `--record` never writes one, so a file holding one is stale, which is `--check`'s to say (RFC 0018 keeps
staleness out of the checker).

### Runtime behaviour

**Writing.** A new module, `packages/runtime/src/recorded-answers.ts`, exports `sharedOf(docs, dir, owner)`. It takes
the scenarios a command would write today, with inline answers, and answers the same scenarios with digests and
`answers` set, and the one `AnswersDoc` they point into. `recorded-dir.ts` calls it inside `writeRecorded` and
`checkRecorded`, so `record.ts` (`scenarioOf`) and `fuzz-edges.ts` keep building inline documents and need no change.
`sharedOf` throws when two different canonical answers share a digest, naming both. It writes no answers file when the
directory gets no scenario.

**Rendering.** A scenario is rendered as #875 renders it, on one line. The answers file is rendered as the Guide shows
it: the envelope on the first line, then one answer per line in its canonical form, sorted by digest, then `}}`. Both
are pure functions of the documents, so `--check` keeps comparing bytes.

**Ownership.** `onDisk` in `recorded-dir.ts` lists `answers.json` at the top of the directory beside the
`*.scenario.json` files, and `wroteIt` reads its `generated` mark as it reads a scenario's. So, with no new rule:

- `--record` writes the answers file whole, each time. An answer no scenario points to any more is not in the new
  file, so it is removed with nothing else to decide.
- An `answers.json` the owner did not write (no `generated`, or another command's) is in the way, and refuses the
  write, as a hand-written scenario in the way does today.
- `--check` lists the answers file `stale` when its bytes differ from what the command writes today, `missing` when the
  command would write one and there is none, and `extra` when there is one the owner wrote and it would write none now.
  It prints the one hint RFC 0018 gives.

**Reading.**

| Reader | Today | With a pointer |
|---|---|---|
| S002, `checkPinnedReasons` in `check/scenarios.ts` | reads `reason` and `status` of each node | inline answers as today; shared answers judged once in the answers document (above) |
| `regress` in `fuzz.ts` (`replayedDiffs`, `diffOf`, `branchFirst`, `switchPath`) | reads `expect.nodes` as answers | `replayedDiffs` calls `nodesOf` once per scenario and hands `diffOf` the resolved map; the diff and its lines are unchanged. A digest `nodesOf` cannot resolve is a `DIFF` naming it (`op.x: points at 57a4… which <answers> does not hold`), never a throw; `wilanis regress` runs `check` first, which refuses it as S0n2 |
| `routedLines` and `scenarioLines` in `scenario-said.ts` (`wilanis describe`) | reads `selected` of each node | `scenarioLines` takes the scope, finds the answers document by `answers`, and reads the resolved map |
| the viewer, `scenarioView` in `packages/view/src/model.ts` and `scenarioEl` in `client/index.html` | the page reads `d.expect.nodes` raw | the view model hands the page the resolved nodes (below); the page no longer reads `expect.nodes` itself |
| `solvedAgain` and `replayedDoc` in `rehearse-recorded.ts` | do not read `expect.nodes` | unchanged |
| `scenariosOf`, `expectsSaid`, `provesSaid` | read `trigger`, `policy`, `branch`, `expect.status`, `reason`, `unreachable` | unchanged |

**`wilanis scenarios --pin <file> [--to <path>]`.** It reads the scenario, replaces every digest with its answer
(`nodesOf`), drops `generated` and `answers`, and writes it to `scenarios/<file name>`, or to `--to`. The description
keeps its first sentence and ends with `Pinned from <file>; say here why it is kept.` It refuses a file that exists,
and a path outside `scenarios/` or inside a directory a command owns (`refusedDir`). The work is in `tools.ts`, so it
can be called without the CLI. `scenario-flags.ts` accepts `--pin` beside no other flag, and `--check` beside no
`--pin`.

**Plain `wilanis fuzz`**: unchanged. Its files are ignored by git, and a person copies one up to keep it, which a file
with pointers would not allow.

**`run`, `start`, the embedder, the engine, plugins**: unchanged.

### Discoverability

- `wilanis ls answers` lists each answers document, marked `(rehearse)` or `(edges)` as `writtenMark` marks a
  scenario.
- `wilanis describe <answers.json>` gains `answersLines` in `scenario-said.ts`, the arm `kindBody` in `discovery.ts`
  dispatches to: `holds N answers, shared by M scenarios (K nodes) under <dir>/`, and `generated by <command>:
  regenerate, do not edit`.
- `wilanis describe <scenario>` prints what it prints today. Its `routedLines` read the resolved answers.
- The viewer's scenario page shows the table "Expected per node" as today: node, status, routes to, answers. The view
  model builds the rows from `nodesOf`. A row whose answer lives in the shared file carries a small `shared` badge.
  The badge links to the answers page at that answer (`#<digest>`), and its title says how many scenarios share it.
  The page never shows the digest in place of the answer, and never shows the raw file.
- The answers document gets a page (`renderDocPage`, `case 'answers'`): one sentence on what the file is and who
  writes it, then a table with one row per answer: status, routes to, the operation that ran (linked as a handler is
  linked elsewhere), what it answered, and how many scenarios use it. Each row opens to the scenarios and node paths
  that point at it, each a link. The view model computes these counts from the registry.
- The manifest lists answers documents as it lists every loaded document (RFC 0026); `manifest.golden.json` is
  regenerated.
- `wilanis map`: unchanged.

### Plugin contract

None. `PluginModule` is unchanged.

## Compatibility

Every change is judged under RFC 0008's definitions: *compatible* when every document that validated before still
validates and means the same thing, *breaking* otherwise.

| Change | Under RFC 0008 |
|---|---|
| `expect.nodes` accepts a digest beside an answer | compatible: every scenario written before validates, and no string was accepted before |
| `answers` on a scenario | compatible: a new optional field |
| the `answers` document kind | compatible: RFC 0008 names a new document kind as compatible |
| `nodeAnswer` and `answerDigest` in `common.schema.json` | compatible: a definition moved, with the same content |
| S0n1, S0n2, S0n3 | compatible: each refuses only a document that uses the new form, so no document written before is refused |
| what `--record` and `fuzz --edges` write | not a schema change. Every committed recorded directory is stale once, and `--check` asks for `--record`, as #875 does |

So the change is compatible, and RFC 0008 would let it land after #91 in place, without `schemas-v2`. It should land
before #91 all the same. A 1.0 runtime is what trees pin. A 1.0 runtime that does not read an answers file cannot read
a tree that a later runtime recorded, and a tree like the measured one that starts at 1.0 would carry its scenarios at
four times the size. Landing before #91 also lets every tree pay the one re-record of #875 and the one of this RFC in the same
release.

Recording fewer nodes (proposal 2, below) would be *breaking* unless it is opt-in. Today a node in the run that is
absent from `expect.nodes` is a diff (`x: new`). If an absent node meant "not judged", a hand-written scenario that
omits a node would replay `same` where it replays `DIFF` today: the same document, a new meaning. Under RFC 0008 that
change must land before #91, or be made opt-in by a new field (compatible), or go to `schemas-v2`.

## Tests

Sabotage tests through `planted` in `packages/runtime/test/sabotage-scenarios.test.ts`, where S004 and S005 are tested
(plant a document, answer the codes):

| Code | The edit |
|---|---|
| S0n1 | a recorded scenario copied into `scenarios/` with `generated` dropped and its digests kept |
| S0n2 | a digest with no `answers`; `answers` naming `@scenarios/rehearsed/none.json`; `answers` naming the edges file from a rehearsed scenario (`generated` differs); a digest the file does not hold; `answers` set and no digest |
| S0n3 | one answer of `scenarios/rehearsed/answers.json` with its `status` changed and its key kept |
| S002 | a shared answer with `reason` and status `done`, refused at `answers/<digest>/reason` of the answers document; an inline one, as today |
| none | a hand-written scenario with inline answers; a recorded one whose every digest resolves |

Core, in `packages/core/test/validate.test.ts`: the baseline gains an answers document and a scenario with digests; a
digest of 15 characters, an upper-case digest, an answers document with `generated: "fuzz"`, and an answer without
`status` are refused. A new `packages/core/test/answers.test.ts`: `canonicalJson` sorts keys at every depth and
matches RFC 8785's examples for the values a run records; `answerDigest` of `{"status":"cancelled"}` is
`a0af58eabbdc1659` whatever order its keys were written in; `nodesOf` resolves, keeps inline answers, and lists what it
cannot resolve.

Runtime:

| What | Asserts | Where |
|---|---|---|
| the record shares | `--record` on a copy of the example writes `answers.json` with one entry per distinct answer (202 for the example as it stands; the test counts, it holds no literal) and no scenario holds an inline answer | `record.test.ts` |
| the record is deterministic | a second `--record` writes the same bytes; `--check` answers no stale, missing or extra | `record.test.ts` |
| the record is a passing suite | `checkTree` answers no refusal; `regress` answers `same` for every scenario | `record.test.ts` |
| a changed answer | `get-row`'s first rule changed: `regress` prints the same `DIFF` lines as before this RFC; `--check` lists the scenario and `answers.json` stale | `record.test.ts` |
| no orphan | a branch removed: the new `answers.json` holds no answer only that branch used | `record-owned.test.ts` |
| ownership | an `answers.json` with no `generated` in the directory refuses the write | `record-owned.test.ts` |
| a collision | `sharedOf` given two answers and a digest function that answers one digest for both throws, naming both | `record-owned.test.ts` |
| edges | `fuzz --edges` writes `scenarios/edges/answers.json`; its `--check` judges it | `fuzz-edges.test.ts` |
| pin | `scenarios --pin` writes an inline copy that `check` accepts and `regress` replays `same`; it refuses an existing file and a path in an owned directory | `scenarios-check.test.ts` |
| describe | `describe` of a scenario with digests prints the same routed lines as one with inline answers; `describe` of `answers.json` prints the counts | `describe-scenario.test.ts` |
| the committed directories | `checkScenarios` and `regress` pass on `example/scenarios` and `libraries/access/scenarios/rehearsed` as they stand | `committed-scenarios.test.ts`, `libraries/access/test/access.test.ts` |

Viewer, in `packages/view/test/view.test.ts`: the scenario page shows the same rows for a scenario with digests as for
one with inline answers, with the `shared` badge linking the answers page; the answers page lists each answer with its
count.

## Implementation plan

Each step is one pull request and one sub-issue. Readers land before the writer, so no commit writes a form that a
reader in the same commit cannot read.

1. **Core: the schemas.** `nodeAnswer` and `answerDigest` in `common.schema.json`; `expect.nodes` and `answers` in
   `scenario.schema.json`; `answers.schema.json`; `ScenarioNode`, `AnswersDoc`, the `Kind` entry and `HOME.answers`;
   the validate baseline; the template's row. Lands before #91.
2. **Core: reading a pointer.** `packages/core/src/answers.ts` with `canonicalJson`, `answerDigest`, `nodesOf`, and
   its test. (`good first issue`)
3. **Compiler: the rules.** S0n1, S0n2, S0n3; `checkPinnedReasons` over a map of answers, so S002 judges a shared
   answer in the answers document; `judgeTree` judges answers documents; the sabotage tests; the rule list in the
   template's `CLAUDE.md`.
4. **Runtime and viewer: the readers.** `regress` and `scenarioLines` read through `nodesOf`; `answersLines`,
   `ls answers`; the viewer's scenario page from resolved rows, and the answers page. Tested with a planted scenario
   that points, since nothing writes one yet.
5. **Runtime: the writer.** `recorded-answers.ts` (`sharedOf`); `writeRecorded` and `checkRecorded` write and compare
   `answers.json`; `onDisk` lists it; the ownership, determinism, orphan, collision and edges tests.
6. **Runtime: `wilanis scenarios --pin`.** In `tools.ts`, the flag in `scenario-flags.ts`, the template's step 3 and
   `scenario` row, and fuzz's description sentence. Test.
7. **The trees.** Re-record `example/scenarios/rehearsed`, `example/scenarios/edges` and
   `libraries/access/scenarios/rehearsed`; regenerate `manifest.golden.json`; say in the README or changelog line that
   tells hosts how to regenerate that every recorded directory goes stale once. After #875 has landed.

## Drawbacks and alternatives

**A scenario no longer reads alone.** A reviewer who opens one recorded file sees digests, not answers. That is the
cost of the gain. Three things pay it back: `regress` says what changed in words, as today; `describe` and the viewer
show the answers resolved; and a pull request's diff of `answers.json` lists, one line each, the answers that are new
or gone. For the one file a person wants to read whole and keep, `--pin` writes it inline.

**Gzip (`.scenario.json.gz`).** Not taken. File by file it gives 41 MB on the measured tree, smaller than this RFC's
75 MB on disk. But a gzipped file is binary in git: a pull request shows no diff, a reviewer cannot read it, and an
agent cannot read it with the tools it reads the rest of the tree with. The loader would also have to learn a second
file format for one kind. Git already compresses what it stores (6.7 MB packed), so gzip saves disk in a checkout and
nothing in the repository. This RFC removes the repeats instead, and the files stay text, reviewable and readable.

**Doing nothing beyond #875.** Not taken. #875 leaves 318 MB, of which 255 MB are repeats, and that share grows with
every node a graph gains, since every scenario through the graph writes the node again. The measured tree grew from
239 to 691 MB over four features.

**A hand-written scenario that points.** Not taken. If a person's file could point into `answers.json`, `--record`
would have to keep every answer such a file needs. The generated file would then depend on files no command writes,
and deleting a person's file would change a generated one. Inline answers for a hand-written file keep RFC 0018's rule:
the recorded directory is a function of the tree, and a person's file is the person's.

**Sharing whole subtrees instead of single answers.** A nested graph's nodes, under one call, are often the same in
many scenarios, so one digest per call would be smaller still. Not taken: a change to one node would change the
digest of every subtree above it, and the diff in review would name a subtree, not the node that moved.

**Proposal 2: record only the nodes a scenario needs.** Not recommended. The question was: which nodes let `regress`
say which node first differs on the path the scenario pins? Those are:

- every switch the run passed through, with its `selected` (the path);
- the node the run ended at (the refuse node and its reason, or the node whose answer is the output), and the run's
  `output` and `reason`, which `expect` already holds outside `nodes`;
- the top-level node of each call into a graph the path enters, with its `handler`.

On the example, that keeps about 415 of the 1,220 nodes. After proposal 1 it takes the example from about 220 KB to about
190 KB. On the measured tree, assuming the example's proportions, it would take about 75 MB to about 68 MB. I have not
measured it there.

What `regress` could no longer say, that it says today:

- **`<node>: out changed` for a node off that list.** This is the loss that matters. `did` records what each node
  answered, not what it was called with, and every effect is stubbed in a replay. So the only record of what the tree
  hands an effect is the answer of the node that built it: a `make` that composes the record a `put` writes. Change
  that `make` to drop a field, and today `regress` says `op.record: out changed`. With only the path recorded, the
  stubbed `put` answers the same, the routing is the same, and the output is the same: `regress` says `same` for a
  change that loses data.
- **`<node>: ran A → B` for a nested call.** A binding changed under a call below the top level would go unseen.
- **`<node>: new` and `<node>: gone`.** A node added to or removed from a graph on the path would go unseen.

That first guarantee is worth keeping, so this RFC does not propose proposal 2. A smaller record that keeps it would
record what each effect was called with (`NodeReport.in`, which the engine's report already carries) and drop the pure
nodes between. That changes what a run records, which is RFC 0006's and not this RFC's.

One narrower cut loses no guarantee about a node that ran: a node absent from `expect.nodes` is expected `cancelled`.
`regress` would still say `new` for a node that runs and is not recorded. It would only stop saying `new` and `gone`
for nodes that did not run. On the example it removes 480 of 1,220 pointers and takes about 220 KB to about 200 KB
(9%). On the measured tree, assuming the example's proportions, it saves about 4 MB of 75 MB. It changes the meaning of
an absent node, so it is breaking unless opt-in (see Compatibility). It is an Open question, and I recommend against
it for now.

## Open questions

1. **The digest's length.** Proposed: 16 hexadecimal characters of SHA-256, with the writer refusing a collision.
   Recommendation: keep it. A full digest costs about 13 MB on the measured tree for no case the writer does not
   already catch.
2. **Should `stubs` share the answers file too?** A stub is an effect's answer, and in the example a call node's `out`
   equals its stub in 123 of 153 cases. The example's stubs are 30 KB, with 47 distinct values out of 189. A stub may
   be a string, so a digest there could not be told from a value: it would need a field of its own (`stubbed: { path:
   digest }`). I do not know what the stubs weigh on the measured tree. Recommendation: not in this RFC. Measure the
   measured tree after step 7, and propose it there if the stubs are a large share of what is left.
3. **Proposal 2's narrow cut ("absent means cancelled").** Recommendation: no for now. It saves about 5% after
   proposal 1 and changes the meaning of an absent node. Revisit only if the measured tree is still too large after
   step 7, and then as an opt-in field.
4. **`wilanis scenarios --pin`, or only a written step?** Without a command, the template would tell an agent to copy
   the file and paste each answer from `answers.json` by hand. Recommendation: the command. It is the one way to keep
   the step RFC 0018 already documents working, and an agent should not resolve digests by hand.
5. **Land before #91?** The change is compatible, so it could land after. Recommendation: before, for the reasons under
   Compatibility.
6. **One line per answer in `answers.json`.** #875 writes a scenario on one line. Recommendation: one answer per line,
   sorted by digest, so a pull request's diff lists the answers added and removed. It costs one byte per answer.
