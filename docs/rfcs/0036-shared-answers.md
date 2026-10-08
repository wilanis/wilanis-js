# RFC 0036: Recorded scenarios share their answers: each distinct node answer kept once per directory

- **Status:** accepted
- **Areas:** `area:core` (`scenario.schema.json`, a new `answers.schema.json`, `ScenarioDoc`, `AnswersDoc`, `HOME`,
  one module that reads a pointer), `area:compiler` (two `S` rules; S002 and S003 read through that module),
  `area:runtime` (`writeRecorded` and `checkRecorded` write and compare the shared file; `regress`, `describe` and `ls`
  read a pointer; `wilanis scenarios --pin`), `area:view` (the scenario page reads a pointer; a page for the shared
  file). Nothing in the engine, nothing in a plugin.
- **Tracking issue:** #877
- **Depends on:** RFC 0018 (implemented: the recorded directories, `Owner`, `--check`). RFC 0008 (accepted: the
  freeze of `schemas-v1`, issue #91). Issue #875 (merged), which writes each scenario on one line and keeps
  `--check`'s byte comparison; this RFC builds on that rendering.

## Summary

The scenarios a command records in one directory share what their runs answered. A *node answer* is what one node
did in a recorded run: its status, the reason it refused with, the operation that ran, where a switch routed, and
what it answered. A *stub value* is what one stubbed effect answered. Each distinct node answer and each distinct stub
value is written once, in an `answers` document at the top of the directory (`scenarios/rehearsed/answers.json`,
`scenarios/edges/answers.json`), under a 16-character digest of its canonical JSON. A recorded scenario's
`expect.nodes` maps each node path to a digest instead of writing the answer again, and a new map, `sharedStubs`,
maps each stubbed path to a digest instead of writing the value in `stubs`. On a tree with 738 recorded scenarios,
the scenarios without indentation go from 318 MB to about 28 MB. The command that owns the directory (`Owner` in
`packages/runtime/src/recorded-dir.ts`) writes, removes and checks the shared file as one more file it owns. A
hand-written scenario still writes its answers and stubs inline, and `wilanis scenarios --pin` copies a recorded
scenario out with everything inline. Every reader of `expect.nodes` and `stubs` (the S rules, `regress`, `describe`,
the viewer) reads a pointer through one of two functions in core, so each one sees the value it sees today. The RFC
also weighs recording fewer nodes per scenario, and decides against it: the nodes it would drop are the only record
of what the tree hands a stubbed effect.

## Motivation

Recorded scenarios cost far more than what they hold.

**What a tree pays today.** Measured on a tree with 738 recorded scenarios:

| Form | Size |
|---|---|
| Indented, as `--record` wrote before #875 | 723 MB |
| On one line, as #875 (merged) writes it | 318.2 MB |
| Gzipped, file by file | 41 MB |
| In git (packed) | 6.7 MB |

The directory grew from 239 MB to 691 MB over four features. On one line, its 318.2 MB are:

| Part | Size | Entries | Distinct |
|---|---|---|---|
| `expect.nodes` | 267.4 MB, of which 11.7 MB are node paths | 268,055 node answers | 1,485 (2.1 MB) |
| `stubs` | 50.3 MB | 106,767 stub values | 404 (0.2 MB) |
| everything else (`in`, `context`, `description`, ...) | about 0.5 MB | | |

Only 335 of the 738 `expect.nodes` maps are distinct.

On this repository's `example/scenarios/`, measured per directory, on one line:

| | `rehearsed/` (58 files) | `edges/` (63 files) |
|---|---|---|
| On one line | 138,356 bytes | 130,395 bytes |
| `expect.nodes`, node paths included | 62,437 bytes (paths 7,839) | 71,265 bytes (paths 11,016) |
| node answers, distinct | 531, of which 165 distinct (23,879 bytes) | 689, of which 77 distinct (11,723 bytes) |
| `stubs` | 22,484 bytes | 7,787 bytes |
| stub values, distinct | 130, of which 42 distinct (5,918 bytes) | 59, of which 12 distinct (1,276 bytes) |

An example scenario has 10 nodes on average. A scenario of the large tree has 363.

**Who pays.** Every checkout pays these bytes on disk. Every command that loads the tree reads them: the loader
(`walk` in `packages/core/src/paths.ts`) reads every `*.json` under the root, so `wilanis check`, `describe`, the
viewer and `wilanis regress` parse and validate every scenario. CI reads them on every run. This RFC measures bytes on
disk and bytes read. It does not promise a time: `regress` still replays every scenario, and each replay runs as it
does today.

**The cause.** `expect.nodes` holds every node of the run, and `stubs` holds every effect's answer, each written in
full in each file. `pick` in `packages/runtime/src/fuzz.ts` walks the whole report, nested graphs included, and `did`
writes each node's `status`, `reason`, `handler`, `selected` and `out`. Two scenarios that pass through the same graph
with the same stub write the same answers and the same stub twice. The answer `{"status":"cancelled"}` alone is
written 480 times in the example. Nothing in the format lets two scenarios share an answer or a stub.

**What #875 did, and what it leaves.** Issue #875 (merged) writes each scenario on one line: `rendered` in
`recorded-dir.ts` is `JSON.stringify(doc) + '\n'`. That halves the bytes for a one-line change, and keeps the byte
comparison `checkRecorded` makes. It does not change the schema, and it leaves every repeat in place: 317.7 of the
318.2 MB are `expect.nodes` and `stubs`. This RFC removes the repeats.

**What this gives.** On one line, as #875 writes them:

| | Example `rehearsed/` | Example `edges/` | Tree with 738 scenarios |
|---|---|---|---|
| Today | 138,356 | 130,395 | 318.2 MB |
| Nodes shared (scenarios + `answers.json`) | 95,442 + 27,698 = 123,140 | 85,361 + 13,682 = 99,043 | about 70 MB |
| Nodes and stubs shared (scenarios + `answers.json`) | 78,935 + 34,498 = 113,433 | 80,262 + 15,210 = 95,472 | about 28 MB |

The example's figures are bytes, measured: a script rewrote each scenario as this RFC writes it and wrote each
directory's `answers.json` as the Guide shows it. The example goes from 268,751 to 222,183 bytes with nodes shared,
and to 208,905 with nodes and stubs shared. It gains less than the large tree because its scenarios are small, and
their `in`, `context` and `description` are a larger share.

The large tree's figures are computed from parts measured on it. Paths stay: the node paths are 11.7 MB and the stub
paths 5.1 MB, both measured as the sum of the keys' lengths. A pointer costs about 22 bytes: 16 characters, the two
quotes around the digest, the two quotes around its path (the measured lengths count no quotes), a colon and a comma.
The answers file holds the distinct values with their digests:

- nodes shared: 0.5 + 50.3 + 11.7 + 268,055 × 22 B (5.9) + 2.1 ≈ 70 MB;
- nodes and stubs shared: 0.5 + 11.7 + 5.1 + (268,055 + 106,767) × 22 B (8.2) + 2.3 ≈ 28 MB.

The pointers' 22 bytes and the answers file's size are close approximations; every other term is measured. I have
not measured the result gzipped or in git.

**What this does not try to solve.** It does not change what a run records (`did` and `pick` record what they
record today), what `regress` compares, or what it prints. It does not share `in` or `context`. It does not change
plain `wilanis fuzz`, which writes to `scenarios/fuzz/`, is ignored by git, and keeps everything inline. It does not
compress anything. It does not share values between two directories, or between a tree and the trees it includes. It
does not make a replay faster.

## Guide-level explanation

**Words.** A *node answer* is the object `did` writes for one node: `{ "status": "done", "selected": "noCustomer",
"out": "noCustomer" }`. A *stub value* is the value a scenario's `stubs` gives one stubbed effect. A *digest* is a
short name computed from a value's content: the same value always has the same digest, and two different values have
different ones. The *answers file* of a recorded directory is one document, `answers.json` at the top of the
directory, that holds each distinct node answer and each distinct stub value of the directory's scenarios once, under
its digest. A *pointer* is a digest written in place of the value.

**A recorded scenario.** `wilanis rehearse example --record` writes the `noCustomer` branch of `get-row`, reached from
`GET /customers/{id}`, as below. The file is shown indented here; since #875 (merged) it is written on one line.

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
  "sharedStubs": {
    "op.customer:made": "e653cfde59e39113",
    "op.fetched": "fe434f59137f740d"
  },
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

Two things changed. `expect.nodes` holds a digest per node instead of an answer. `sharedStubs` holds a digest per
stubbed path, in place of `stubs`. Everything else is what `--record` writes today. The scenario does not name its
answers file: it is always the `answers.json` of the recorded directory the scenario sits in (*Which answers file*,
below).

**The answers file.** `--record` writes it beside the scenarios, at the top of the directory it owns:

```
{"$schema":"https://raw.githubusercontent.com/wilanis/wilanis-js/main/packages/core/schemas/answers.schema.json","description":"The node answers and stub values the scenarios under scenarios/rehearsed/ share, each once, under its digest. Written by wilanis rehearse --record; regenerate it, do not edit it.","generated":"rehearse","nodes":{
"44f43d678904b84b":{"handler":"@std/outcome.port.json#refuse","reason":"missing","status":"failed"},
"57a449dbd5d11643":{"out":"noCustomer","selected":"noCustomer","status":"done"},
"6e95cc4702be185c":{"handler":"graph:@features/customers/data/get-row.graph.json","reason":"missing","status":"failed"},
"a0af58eabbdc1659":{"status":"cancelled"},
"d8dbfda2f39b977c":{"handler":"@http/http.port.json#request","out":{"body":{"active":true,"email":"hotel","extra8":["lima","Zulu-9"],"id":"india","name":"","note":"india","registrar":"bravo","tier":"lima"},"headers":{"extra7":"charlie87"},"status":404},"status":"done"}
},"stubs":{
"e653cfde59e39113":{"active":true,"email":"echo","id":"juliet527","name":"Zulu-9","note":"golf154","tier":"kilo"},
"fe434f59137f740d":{"body":{"active":true,"email":"hotel","extra8":["lima","Zulu-9"],"id":"india","name":"","note":"india","registrar":"bravo","tier":"lima"},"headers":{"extra7":"charlie87"},"status":404}
}}
```

(Only the lines this scenario uses are shown.) Each value is on its own line, in its canonical form, and the lines
of each map are sorted by digest. The canonical form is the exact text the digest is computed from, so anyone can
check a line. A pull request that changes behaviour shows, in this file, the values added and the values no scenario
needs any more, one line each.

**Replaying.** `wilanis regress example` reads each pointer from the answers file, fires the run with the stub values
it names, and diffs the run as it does today. Its lines do not change:

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
`scenarios/`, give it a description and drop `generated`. A copy with pointers would point into a file that
`--record` rewrites, and a value the copy needs could disappear on the next record. So a hand-written scenario writes
its answers and stubs inline, and one command makes the copy:

```
$ wilanis scenarios example --pin scenarios/rehearsed/customers.get-customer/customers.get-row.outcome.noCustomer.scenario.json
wrote scenarios/customers.get-row.outcome.noCustomer.scenario.json with every answer and stub inline -- give it a description of your own
```

**The refusal an author meets.** Copy the recorded file by hand and drop `generated`:

```
S006  @scenarios/customers.get-row.outcome.noCustomer.scenario.json#expect/nodes/op.outcome
    node 'op.outcome' points at the shared answer 57a449dbd5d11643, and a scenario written by hand holds its answers itself: no command keeps an answers file for it
    → wilanis scenarios --pin <the recorded file> writes the copy with every answer and stub inline; or write this node's answer in place of the digest
```

## Reference

### Documents and schemas

**`common.schema.json`** gains two definitions. Neither changes what any document may say today.

- `$defs/nodeAnswer`: the object a scenario's `expect.nodes` holds today (`status` required; `handler`, `out`,
  `selected`, `reason`), moved here unchanged, with its descriptions, so that `scenario.schema.json` and
  `answers.schema.json` read it from one place.
- `$defs/answerDigest`: a string matching `^[0-9a-f]{16}$`. "The digest of a node answer or a stub value: the first 16
  hexadecimal characters of the SHA-256 of its canonical JSON (RFC 8785). It names the value in the answers document
  of the directory the scenario sits in."

**`scenario.schema.json`** changes in two places.

- `expect.nodes.additionalProperties` reads the value's type: `if: { type: "string" }`, `then: { $ref: answerDigest
  }`, `else: { $ref: nodeAnswer }`. "What each node did, by its dotted path: the answer itself, or the digest of an
  answer the directory's answers document holds. A command that records writes digests; a person writes answers."
  `if`/`then` rather than `anyOf`, so a bad inline answer gets one refusal (the `nodeAnswer` one), not one per
  alternative. Every answer today is an object with a required `status`, so a string never meant anything here, and
  the two forms cannot be confused.
- A new optional top-level `sharedStubs`: an object whose values are `answerDigest`. "dotted node path -> the digest
  of the value its operation returned, held under `stubs` in the directory's answers document. A command that records
  writes this in place of `stubs`; a person writes `stubs`. A path is in one of the two, never both."

**Why a separate map for stubs, and not a pointer in `stubs`.** A stub value can be any JSON: an effect may answer a
string, and a string of 16 hexadecimal characters is a value an effect may answer. So a bare string in `stubs` could
be a value or a pointer, and no reader could tell. An object form (`{ "$answer": "<digest>" }`) has the same flaw one
level down: an effect may answer an object with a `$answer` key, and the format would need an escape rule for it. A
separate map cannot be confused: `stubs` keeps exactly its meaning today, a value per path, and `sharedStubs` holds
only digests. It costs nothing more than a pointer in `stubs` would: one path and one digest per stub.

**`answers.schema.json`** is a new document kind. Its `$id` is under the published base, its `$schema` enum accepts
the URL and the alias `@wilanis/answers.schema.json`, and it carries the optional `label` every kind carries.

- `description` (required): what the file is, written by the command.
- `generated` (required, enum `rehearse`, `edges`): "The command that wrote this file and owns the directory it sits
  in. It writes the file whole each time it records, so a value no scenario points to is never kept."
- `nodes` (required): an object whose keys match `answerDigest` (`propertyNames`) and whose values are `nodeAnswer`.
  "Each distinct node answer of the scenarios in this directory, once, under its digest."
- `stubs` (required): an object whose keys match `answerDigest` and whose values are any JSON. "Each distinct stub
  value of the scenarios in this directory, once, under its digest."
- `additionalProperties: false`.

The two maps are apart because their values are judged apart: a node answer is a `nodeAnswer` and S002 reads it,
while a stub value is any JSON. Both use the one digest function. Plain `wilanis fuzz` (`generated: 'fuzz'`) writes
no answers file, so the enum leaves it out.

**`packages/core/src/model.ts`**: `ScenarioNode` (the node answer type, written inline in `ScenarioDoc` today) is named
and exported. `ScenarioDoc` gains `sharedStubs?: Record<string, string>`, and `expect.nodes` becomes
`Record<string, ScenarioNode | string>`. `AnswersDoc extends Envelope` with `generated: 'rehearse' | 'edges'`,
`nodes: Record<string, ScenarioNode>` and `stubs: Record<string, unknown>`. `Kind` and `DocByKind` gain `answers`.

**A pointer is read in one place.** A new module, `packages/core/src/answers.ts`, holds:

- `canonicalJson(value): string`: RFC 8785. For the values a run records, that is `JSON.stringify` with the keys of
  every object sorted by UTF-16 code unit, the order JavaScript's default sort gives.
- `answerDigest(value): string`: SHA-256 (`node:crypto`) over the UTF-8 bytes of `canonicalJson`, the first 16
  hexadecimal characters. The same function names node answers and stub values.
- `answersFor(registry, scenarioPath): Loaded<AnswersDoc> | undefined`: the scenario's answers document, as *Which
  answers file* says.
- `nodesOf(scenario: ScenarioDoc, answers: AnswersDoc | undefined)`: answers `{ nodes: Record<string, ScenarioNode>;
  unresolved: string[] }`. Each digest is replaced by the answer under `nodes` in the answers document, each inline
  answer is kept, and a digest the document does not hold is listed in `unresolved`.
- `stubsOf(scenario: ScenarioDoc, answers: AnswersDoc | undefined)`: answers `{ stubs: Record<string, unknown>;
  unresolved: string[] }`: `stubs` as written, with each path of `sharedStubs` given the value under `stubs` in the
  answers document, and a digest it does not hold listed in `unresolved`.

The compiler, the runtime and the viewer read `expect.nodes` only through `nodesOf`, and a scenario's stubs only
through `stubsOf`, so no reader resolves a pointer its own way.

**Which answers file.** A scenario's answers file is the `answers.json` of the nearest directory that holds the
scenario, strictly below `scenarios/` (`answersFor`). For `scenarios/rehearsed/customers.get-customer/x.scenario.json`,
that is `scenarios/rehearsed/answers.json`. Two `--record <dir>` directories are both `rehearse`, so a mark alone
could not tell their files apart; the place can. The scenario does not name the file: a field that must equal what
the place already says would only be one more thing to get wrong. The viewer and `describe` show the file found.

**Why this digest.** SHA-256 is in Node with no dependency, and its output does not depend on the platform. The
canonical form makes the digest a function of the value, not of the order in which a run happened to write its keys.
Sixteen hexadecimal characters are 64 bits. Among *n* values, the chance that two share a digest is about
n² / 2^65: about 10⁻¹³ for the large tree's 1,889 (1,485 answers and 404 stub values), and 3 × 10⁻⁸ for a million.
The writer also checks: two different canonical texts with one digest refuse the write, naming both, so a collision
is never silent. A full digest (64 characters) would add 48 bytes per pointer, 18 MB on the large tree's 374,822
pointers, to guard against a case the writer already refuses. Hexadecimal and not base64: it has no case, so it reads
the same on a filesystem that ignores case, and it holds no character that a shell or a URL treats specially.
Base64url would save 5 bytes per pointer, about 1.9 MB on the large tree.

**Why one file per directory, and who owns it.** A recorded directory has one owner, the command whose `Owner` in
`recorded-dir.ts` names it: `REHEARSED` (`wilanis rehearse --record`) or `EDGED` (`wilanis fuzz --edges`). That
command already writes, removes and checks every file in it. The answers file is one more such file, carrying the
same `generated` mark, so the rules of RFC 0018 hold for it unchanged. One file per tree would have two writers that
run apart, and neither could write the file whole. The cost: a value both directories hold is written twice. All
distinct values of the large tree take 2.3 MB together, so the cost is below that.

**Placement.** `HOME` in `packages/core/src/placement.ts` gains `answers: { dir: 'scenarios', why: 'answers are what
the recorded scenarios beside them share' }`. `misplacedDir` reads only the first segment, so `scenarios/rehearsed/`
is home. The name `answers.json` is fixed, as `feature.json` is, and a rule holds it. `misplacedKind` in
`packages/core/src/documents.ts` gains a D003 branch beside the feature's: an `answers` document whose file name is
not `answers.json` is refused, with the message `an answers document is answers.json at the top of a recorded
directory` and the hint `move it to <its directory>/answers.json, or change its $schema to the kind this file is`.
`answersFor` reads only files of that name, so without the rule a misnamed answers file would load and be read by
no one.

**`packages/runtime/templates/CLAUDE.md`**: a row for `answers` ("the node answers and stub values the recorded
scenarios of one directory share, each once, under its digest; written by `wilanis rehearse --record` and `wilanis
fuzz --edges` beside what they record; regenerate it, never edit it"; home `scenarios/`, at the top of a recorded
directory). The `scenario` row and step 3 say to keep a run with `wilanis scenarios --pin <file>`, where today they
say to copy the file. The rule list's `S scenarios` gains S006 and S007.

**`wilanis new answers`**: not added. An answers file is written only by a command, as RFC 0018 decided for a
scenario.

### Ports, operations and kinds granted

None.

### Checker rules

The codes are the next free ones of the S family, S006 and S007, taken in step 3. The rules live in
`packages/compiler/src/check/scenarios.ts`, beside S001 to S005, or in a `check/answers.ts` beside it if the file would
pass the house rule's 300 lines. `judgeTree` in `checker.ts` judges answers documents where it judges scenarios.

| Code | Where it lives | Refuses when | Hint |
|---|---|---|---|
| S006 | `check/scenarios.ts`, at `expect/nodes/<id>` or `sharedStubs` | a scenario with no `generated` writes a digest for a node, or has `sharedStubs`. Its answers file is rewritten by a command that does not know the scenario, so a value it needs may disappear | `wilanis scenarios --pin <the recorded file> writes the copy with every answer and stub inline; or write the value in place of the digest` |
| S007 | `check/scenarios.ts`, at `expect/nodes/<id>` or `sharedStubs/<path>` | a node or a stub is a digest, and the scenario's answers file (`answersFor`) does not exist, carries another `generated` than the scenario, or holds no value under that digest in the map it reads (`nodes` for a node, `stubs` for a stub). Also a path that is in both `stubs` and `sharedStubs` | `wilanis rehearse --record (or wilanis fuzz --edges) writes the scenarios and their answers file together: run it and review the diff` |

**S002 and S003 read through core.** S002 refuses a reason on a node that did not end `failed`. For an inline answer
it is judged as today, at `expect/nodes/<id>/reason`. A shared answer is judged once, in the answers document, at
`nodes/<digest>/reason`, since its status and reason are both in that one answer. `checkPinnedReasons` takes a map of
answers, so one function judges both. S003 refuses a `cancelAt` that is not a stubbed path; it reads the paths
through `stubsOf`, so a path under `sharedStubs` counts. (No command writes `cancelAt` today, so this only keeps the
rule true.)

**What the checker does not judge.** A value no scenario points to is not refused. It changes no scenario's meaning,
and `--record` never writes one, so a file holding one is stale. Whether the answers file is what the command writes
today, a hand edit included, is `--check`'s to say: RFC 0018 keeps staleness out of the checker, and so does this RFC.

### Runtime behaviour

**Writing.** A new module, `packages/runtime/src/recorded-answers.ts`, exports `sharedOf(docs, dir, owner)`. It takes
the scenarios a command would write today, with everything inline. It answers the same scenarios with digests in
`expect.nodes`, `sharedStubs` in place of `stubs`, and the one `AnswersDoc` they point into. `recorded-dir.ts` calls
it inside `writeRecorded` and `checkRecorded`, so `record.ts` (`scenarioOf`) and `fuzz-edges.ts` keep building inline
documents and need no change. `sharedOf` throws when two different canonical values share a digest, naming both. When
no scenario of the directory has a node or a stub -- every branch unreachable, or no scenario at all -- it answers no
answers file, and none is written.

**Rendering.** A scenario is rendered as #875 renders it, on one line. The answers file is rendered as the Guide shows
it: the envelope opens the first line; each map opens on its own line; each value is on its own line, in its
canonical form, sorted by digest, with a comma after every value but the last of its map; an empty map is `{}`. Both
are pure functions of the documents, so `--check` keeps comparing bytes.

**Ownership.** `onDisk` in `recorded-dir.ts` lists `answers.json` at the top of the directory beside the
`*.scenario.json` files, and `wroteIt` reads its `generated` mark as it reads a scenario's. So, with no new rule:

- `--record` writes the answers file whole, each time. A value no scenario points to any more is not in the new file,
  so it is removed with nothing else to decide.
- An `answers.json` the owner did not write (no `generated`, or another command's) is in the way, and refuses the
  write, as a hand-written scenario in the way does today.
- `--check` lists the answers file `stale` when its bytes differ from what the command writes today, `missing` when the
  command would write one and there is none, and `extra` when there is one the owner wrote and it would write none now.
  It prints the one hint RFC 0018 gives.

**Reading.**

| Reader | Today | With a pointer |
|---|---|---|
| S002, `checkPinnedReasons` in `check/scenarios.ts` | reads `reason` and `status` of each node | inline answers as today; shared answers judged once in the answers document (above) |
| S003, `checkCancelAt` in `check/scenarios.ts` | reads the keys of `stubs` | reads the keys `stubsOf` answers |
| `regress` in `fuzz.ts`: `replayedDiffs`, `diffOf`, `branchFirst`, `switchPath` | reads `expect.nodes` as answers and fires with `sc.stubs` | `replayedDiffs` calls `answersFor`, `nodesOf` and `stubsOf` once per scenario, fires with the resolved stubs, and hands `diffOf` the resolved nodes; the diff and its lines are unchanged |
| `regress`: `cancelledReplay` in `fuzz.ts` | removes `cancelAt` from `sc.stubs` | removes it from the resolved stubs |
| `regress`, a digest that does not resolve | | a `DIFF` naming it (`op.x: points at 57a4… which scenarios/rehearsed/answers.json does not hold`), never a throw; `wilanis regress` runs `check` first, which refuses it as S007 |
| `routedLines` and `scenarioLines` in `scenario-said.ts` (`wilanis describe`) | reads `selected` of each node; prints no stub (RFC 0018) | `scenarioLines` takes the scope and reads the nodes `nodesOf` answers; still prints no stub, and adds `answers  <the file answersFor found>` where a node or a stub is shared |
| the viewer, `scenarioView` in `packages/view/src/model.ts` and `scenarioEl` in `client/index.html` | the page reads `d.expect.nodes` raw; shows no stub | the view model hands the page the nodes `nodesOf` answers, and the page no longer reads `expect.nodes` itself; it still shows no stub |
| `fuzz --edges` | writes through `writeRecorded` | shares through `sharedOf` there, with no change of its own |
| plain `fuzz` | writes inline | unchanged: its files are ignored by git, and a person copies one up to keep it, which a file with pointers would not allow |
| `solvedAgain`, `replayedDoc` in `rehearse-recorded.ts`; `scenariosOf`, `expectsSaid`, `provesSaid` | read neither `expect.nodes` nor `stubs` | unchanged |

**`wilanis scenarios --pin <file>`.** It reads the scenario, replaces every digest with its value (`nodesOf`,
`stubsOf`), writes the stubs back under `stubs`, drops `generated` and `sharedStubs`, and writes the result directly
under `scenarios/`, as `scenarios/<file name>`. It takes no destination: `refusedDir` accepts every directory below
`scenarios/` outside `fuzz/` and `edges/`, so it cannot tell which of them a command owns, and the one place no
command owns is `scenarios/` itself. The description keeps its first sentence and ends with `Pinned from <file>; say
here why it is kept.` It refuses a file that exists there. The work is in `tools.ts`, so it can be called without the
CLI. `scenario-flags.ts` accepts `--pin` beside no other flag, and `--check` beside no `--pin`.

**`run`, `start`, the embedder, the engine, plugins**: unchanged.

### Discoverability

- `wilanis ls answers` lists each answers document, marked `(rehearse)` or `(edges)` as `writtenMark` marks a
  scenario.
- `wilanis describe <answers.json>` gains `answersLines` in `scenario-said.ts`, the arm `kindBody` in `discovery.ts`
  dispatches to: `holds N node answers and M stub values for the scenarios under <dir>/`, and `generated by <command>:
  regenerate, do not edit`.
- `wilanis describe <scenario>` prints what it prints today, with its routed lines read through `nodesOf`, and one
  line naming the answers file where it shares anything.
- The viewer's scenario page shows the table "Expected per node" as today: node, status, routes to, answers. The view
  model builds the rows from `nodesOf`, so a shared answer shows as an inline one does. The page never shows a digest
  in place of a value, and never shows the raw file. It links the answers file where the scenario shares anything.
- The answers document gets a page (`renderDocPage`, `case 'answers'`): one sentence on what the file is and who
  writes it, then two tables. Node answers: digest, status, routes to, the operation that ran (linked as a handler is
  linked elsewhere), what it answered. Stub values: digest, value.
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
| `sharedStubs` on a scenario | compatible: a new optional field |
| the `answers` document kind | compatible: RFC 0008 names a new document kind as compatible |
| `nodeAnswer` and `answerDigest` in `common.schema.json` | compatible: a definition moved, with the same content |
| S006, S007 | compatible: each refuses only a document that uses the new form, so no document written before is refused |
| what `--record` and `fuzz --edges` write | not a schema change. Every committed recorded directory is stale once, and `--check` asks for `--record`, as #875 did |

So the change is compatible, and RFC 0008 would let it land after #91 in place, without `schemas-v2`. The schema step
lands before #91 all the same (decided in review, below). A 1.0 runtime is what trees pin. A 1.0 runtime that does
not read an answers file cannot read a tree that a later runtime recorded, and a tree like the large one that starts
at 1.0 would carry its scenarios at more than ten times the size. Landing before #91 also keeps the re-record this
RFC asks for before 1.0, as the one #875 (merged) asked for is.

Recording fewer nodes (proposal 2, below) would be *breaking* unless it were opt-in. Today a node in the run that is
absent from `expect.nodes` is a diff (`x: new`). If an absent node meant "not judged", a hand-written scenario that
omits a node would replay `same` where it replays `DIFF` today: the same document, a new meaning.

## Tests

Sabotage tests through `planted` in `packages/runtime/test/sabotage-scenarios.test.ts`, where S004 and S005 are tested
(plant a document, answer the codes):

| Code | The edit |
|---|---|
| S006 | a recorded scenario copied into `scenarios/` with `generated` dropped and its digests kept; the same with only `sharedStubs` kept |
| S007 | a node digest the directory's `answers.json` does not hold; a stub digest it does not hold under `stubs`, though it holds it under `nodes`; a recorded scenario moved under a second `--record` directory whose `answers.json` lacks its digests; a recorded scenario in a directory with no `answers.json`; an `answers.json` marked `edges` above a `rehearse` scenario; a path in both `stubs` and `sharedStubs` |
| S002 | a shared answer with `reason` and status `done`, refused at `nodes/<digest>/reason` of the answers document; an inline one, as today |
| S003 | a hand-written scenario with `cancelAt` naming a path under `stubs` passes, as today; one naming no path refuses |
| none | a hand-written scenario with inline answers and stubs; a recorded one whose every digest resolves |

D003, in `packages/runtime/test/sabotage-unproved.test.ts` beside the project document's D003 case: an answers
document named `scenarios/rehearsed/shared.json` is refused; one named `scenarios/rehearsed/answers.json` is not.

Core, in `packages/core/test/validate.test.ts`: the baseline gains an answers document and a scenario with digests and
`sharedStubs`; a digest of 15 characters, an upper-case digest, an answers document with `generated: "fuzz"`, and a
node answer without `status` are refused, the last with exactly one refusal. A new `packages/core/test/answers.test.ts`:
`canonicalJson` sorts keys at every depth and matches RFC 8785's examples for the values a run records;
`answerDigest` of `{"status":"cancelled"}` is `a0af58eabbdc1659` whatever order its keys were written in; `answersFor`
finds the nearest `answers.json` and none at `scenarios/` itself; `nodesOf` and `stubsOf` resolve, keep inline values,
and list what they cannot resolve.

Runtime:

| What | Asserts | Where |
|---|---|---|
| the record shares | `--record` on a copy of the example writes `answers.json` with one entry per distinct node answer and stub value (165 node answers and 42 stub values for `rehearsed/`, 77 and 12 for `edges/`, as the example stands; the test counts, it holds no literal); no scenario holds an inline answer or a `stubs` | `record.test.ts` |
| the record is deterministic | a second `--record` writes the same bytes; `--check` answers no stale, missing or extra | `record.test.ts` |
| the record is a passing suite | `checkTree` answers no refusal; `regress` answers `same` for every scenario | `record.test.ts` |
| a changed answer | `get-row`'s first rule changed: `regress` prints the same `DIFF` lines as before this RFC; `--check` lists the scenario and `answers.json` stale | `record.test.ts` |
| no orphan | a branch removed: the new `answers.json` holds no value only that branch used | `record-owned.test.ts` |
| no file for nothing | a directory whose every branch is unreachable gets no `answers.json` | `record-unreachable.test.ts` |
| ownership | an `answers.json` with no `generated` in the directory refuses the write | `record-owned.test.ts` |
| a collision | `sharedOf` given two values and a digest function that answers one digest for both throws, naming both | `record-owned.test.ts` |
| edges | `fuzz --edges` writes `scenarios/edges/answers.json`; its `--check` judges it | `fuzz-edges.test.ts` |
| pin | `scenarios --pin` writes an inline copy directly under `scenarios/` that `check` accepts and `regress` replays `same`; it refuses an existing file | `scenarios-check.test.ts` |
| describe | `describe` of a scenario with digests prints the same routed lines as one with inline answers, and names the answers file; `describe` of `answers.json` prints the counts | `describe-scenario.test.ts` |
| the committed directories | `checkScenarios` and `regress` pass on `example/scenarios` and `libraries/access/scenarios/rehearsed` as they stand | `committed-scenarios.test.ts`, `libraries/access/test/access.test.ts` |

Viewer, in `packages/view/test/view.test.ts`: the scenario page shows the same rows for a scenario with digests as for
one with inline answers; the answers page lists each node answer and each stub value.

## Implementation plan

Each step is one pull request and one sub-issue, and each leaves `tsc -b` and `npm test` passing.
Readers land before the writer, so no commit writes a form that a reader cannot read.

1. **Core: the schemas.** `nodeAnswer` and `answerDigest` in `common.schema.json`; `expect.nodes` and `sharedStubs` in
   `scenario.schema.json`; `answers.schema.json`; `AnswersDoc` (in `recorded.ts`), the `Kind` entry and
   `HOME.answers`; the validate baseline; the D003 branch for `answers.json` in `misplacedKind` (`documents.ts`) and
   its sabotage cases; D008's move for an answers document; the template's row; the answers page in the viewer and its
   test. `ScenarioDoc`'s types do not change in this step, so no reader breaks. Lands before #91.
2. **Core and every reader: one way to read a pointer.** `packages/core/src/answers.ts` with `canonicalJson`,
   `answerDigest`, `answersFor`, `nodesOf`, `stubsOf`, and its test. In the same pull request, `ScenarioNode` is named (in `recorded.ts`),
   `expect.nodes` becomes `ScenarioNode | string` and `ScenarioDoc` gains `sharedStubs`, and every reader the type
   change would break goes through the new functions, so `tsc -b` passes:
   - `check/scenarios.ts`: `checkPinnedReasons` and `checkCancelAt` read through `nodesOf` and `stubsOf`;
   - `fuzz.ts`: `did`, `pick` and `nodeDiffs` take and answer `ScenarioNode` (`Record<string, ScenarioNode>` for
     `pick`) where they are typed `ScenarioDoc['expect']['nodes']` today; `branchFirst` and `switchPath` take the
     resolved nodes `nodesOf` answers; `replayedDiffs` resolves once and hands them on to `diffOf`; `cancelledReplay`
     takes the stubs `stubsOf` answers;
   - `scenario-said.ts`: `routedLines` reads the resolved nodes;
   - the viewer: `scenarioView` in `model.ts` hands the page the resolved rows, and `scenarioEl` in
     `client/index.html` stops reading `d.expect.nodes`.

   Tested with a planted scenario that points, since nothing writes one yet.
3. **Compiler: the rules.** S006, S007; S002 judged in answers documents; `judgeTree` judges answers documents; the
   sabotage tests; the rule list in the template's `CLAUDE.md`.
4. **Runtime: the answers document shown.** `answersLines`, `ls answers`, the answers line of a scenario's
   `describe`. The viewer's answers page landed in step 1. (`good first issue`)
5. **Runtime and the trees: the writer.** `recorded-answers.ts` (`sharedOf`); `writeRecorded` and `checkRecorded` write
   and compare `answers.json`; `onDisk` lists it; the ownership, determinism, orphan, no-file, collision and edges
   tests. This step changes the bytes `--record` and `fuzz --edges` write, so in the same pull request:
   `example/scenarios/rehearsed`, `example/scenarios/edges` and `libraries/access/scenarios/rehearsed` are
   re-recorded, `manifest.golden.json` is regenerated, and the README or changelog line that tells hosts how to
   regenerate says that every recorded directory goes stale once. Otherwise `committed-scenarios.test.ts`,
   `libraries/access/test/access.test.ts` and CI's `wilanis scenarios example --check` would fail until a later step.
6. **Runtime: `wilanis scenarios --pin`.** In `tools.ts`, the flag in `scenario-flags.ts`, the template's step 3 and
   `scenario` row, and fuzz's description sentence. Test.

## Drawbacks and alternatives

**A scenario no longer reads alone.** A reviewer who opens one recorded file sees digests, not values. That is the
cost of the gain. Three things reduce that cost: `regress` says what changed in words, as today; `describe` and the
viewer show the answers resolved; and a pull request's diff of `answers.json` lists, one line each, the values that are new
or gone. For the one file a person wants to read whole and keep, `--pin` writes it inline.

**Gzip (`.scenario.json.gz`).** Not taken. File by file it gives 41 MB on the large tree, more than this RFC's
28 MB. And a gzipped file is binary in git: a pull request shows no diff, a reviewer cannot read it, and an agent
cannot read it with the tools it reads the rest of the tree with. The loader would also have to learn a second file
format for one kind. Git already compresses what it stores (6.7 MB packed), so gzip saves disk in a checkout and
nothing in the repository. This RFC removes the repeats instead, and the files stay text, reviewable and readable.

**Doing nothing beyond #875.** Not taken. #875 leaves 318.2 MB, of which 317.7 MB are `expect.nodes` and `stubs`, and
their repeats grow with every node a graph gains, since every scenario through the graph writes the node again. The
large tree grew from 239 to 691 MB over four features.

**A hand-written scenario that points.** Not taken. If a person's file could point into `answers.json`, `--record`
would have to keep every value such a file needs. The generated file would then depend on files no command writes,
and deleting a person's file would change a generated one. Inline values for a hand-written file keep RFC 0018's rule:
the recorded directory is a function of the tree, and a person's file is the person's.

**Sharing whole maps or subtrees instead of single answers.** Only 335 of the large tree's 738 `expect.nodes` maps are
distinct, so one digest per map, or per call's subtree, would also save the node paths (11.7 MB). Not taken: a change
to one node would change the digest of every map or subtree above it, and the diff in review would name a map, not the
node that moved.

**Proposal 2: record only the nodes a scenario needs.** Not taken. The question was: which nodes let `regress` say
which node first differs on the path the scenario pins? Those are:

- every switch the run passed through, with its `selected` (the path);
- the node the run ended at (the refuse node and its reason, or the node whose answer is the output), and the run's
  `output` and `reason`, which `expect` already holds outside `nodes`;
- the top-level node of each call into a graph the path enters, with its `handler`.

On the example, that keeps about 415 of the 1,220 nodes. On top of nodes and stubs shared, it takes the example from
208,905 to about 177,000 bytes. On the large tree, assuming the example's proportions, it saves about two thirds of
the 17.6 MB of node paths and pointers: about 28 MB to about 16 MB, estimated. I have not measured it there. With
stubs shared, that is the largest gain left, and this RFC does not take it: it keeps `regress`'s report of a changed
node off the path instead, for the reason below.

What `regress` could no longer say, that it says today:

- **`<node>: out changed` for a node off that list.** This is the loss that matters. `nodeDiffs` in `fuzz.ts` reports
  `out changed` only for a node the scenario recorded. `did` records what each node answered, not what it was called
  with, and every effect is stubbed in a replay. So the only record of what the tree hands an effect is the answer of
  the node that built it: a `make` that composes the record a `put` writes. Change that `make` to drop a field, and
  today `regress` says `op.record: out changed`. With only the path recorded, the stubbed `put` answers the same, the
  routing is the same, and the output is the same: `regress` says `same` for a change that loses data.
- **`<node>: ran A → B` for a nested call.** A binding changed under a call below the top level would go unseen.
- **`<node>: new` and `<node>: gone`.** A node added to or removed from a graph on the path would go unseen.

That first guarantee is worth keeping. A smaller record that keeps it would record what each effect was called with
(`NodeReport.in`, which the engine's report already carries) and drop the pure nodes between. That changes what a run
records, which is RFC 0006's and not this RFC's.

**The narrow cut: an absent node is expected `cancelled`.** Not taken. It loses no guarantee about a node that ran:
`regress` would still say `new` for a node that runs and is not recorded, and stop saying `new` and `gone` only for
nodes that did not run. On top of nodes and stubs shared it takes the example from 208,905 to about 189,000 bytes
(9%), and the large tree, assuming the example's proportions, from about 28 MB to about 21 MB. It changes the meaning
of an absent node, so it would be breaking unless opt-in, and every reader would have to know the rule. The gain does
not pay for a second meaning of an absent key.

## Open questions

None. Decided in review:

1. **The digest.** 16 hexadecimal characters of SHA-256 over RFC 8785 canonical JSON. The writer refuses a collision,
   naming both values.
2. **Stubs.** Shared in this RFC, in the same answers file and by the same digest, through `sharedStubs` (*Why a
   separate map for stubs*).
3. **"Absent means cancelled."** No (*The narrow cut*).
4. **`--pin`.** A flag of `wilanis scenarios`. It writes directly under `scenarios/` and takes no destination.
5. **Order.** The schema step (step 1) lands before #91, the `schemas-v1` freeze.
6. **`answers.json`'s layout.** One value per line, each map sorted by digest, so a pull request's diff lists the
   values added and removed.

## Decided during implementation

- The answers page in the viewer moved from step 4 to step 1. The fitness function
  `a-kind-is-declared-once-and-mirrored` requires a page for every kind, and step 1 adds the kind. Its test is in
  `packages/view/test/scenarios.test.ts`, beside the scenario page's.
- `ScenarioDoc`, `AnswersDoc` and, from step 2, `ScenarioNode` live in `packages/core/src/recorded.ts`, which `model.ts`
  re-exports. With them in `model.ts`, the file would exceed the house rule's 300 lines.
- An answers document sits at least one directory below `scenarios/`, since `answersFor` finds none at `scenarios/`
  itself: D003 also refuses `scenarios/answers.json`. D008 moves an answers document outside `scenarios/` to
  `scenarios/rehearsed/answers.json`, a place D003 accepts, so the fix removes the refusal (RFC 0019). `answersHome`
  in `placement.ts` says that place for both rules.
- `answersFor` walks up from the scenario's directory and stops at the first `answers.json` the registry holds. It asks
  `answersHome` whether each candidate is a place an answers document may sit, so the rule D003 and D008 follow is
  written once. `nodesOf` and `stubsOf` list the node paths and the stub paths they cannot resolve, not the digests:
  S007 refuses at a path, and a reader finds the digest under that path.
- In step 2, S002 judges a scenario's inline answers only (`nodesOf` with no answers document). A shared answer waits
  for step 3, which judges it once, in its answers document. `checkPinnedReasons` takes a map of answers and the
  pointer they sit under, so step 3 calls the same function at `nodes`. S003 counts a path under `sharedStubs` even
  when its digest does not resolve: that fault is S007's, and one fault gets one refusal.
- `regress` fires nothing for a scenario with a pointer that does not resolve. It answers one `DIFF` per pointer:
  `op.x: points at <digest>, which scenarios/rehearsed/answers.json does not hold`, `stub op.x: points at ...` for a
  stub, and `..., and no answers.json is above it` where `answersFor` finds no file.
- `scenarioLines` takes the scope and reads the routed lines through `nodesOf`. The line naming the answers file is
  step 4's (#882), as the Implementation plan says.
- The view model had no `scenarioView`. It is new in `model.ts`, called from `recordedView` so that `viewOf` stays
  within the house rule's complexity. It sets `expectedNodes` on the view, a row per node that `expectedNodesOf` in
  `packages/view/src/scenarios.ts` resolves through `nodesOf`.
- One reader the reader table did not list: `referenceIndex` in `packages/view/src/references.ts` walks every string of
  every document, and a scenario's `expect.nodes/<id>/handler` names the operation a node ran. It now reads a scenario
  through `nodesOf` and `stubsOf`, so a pointing scenario references, at the same pointers, what its inline form does.
  The answers document is walked as it is written, so it references those operations too.
- Step 3 took S006 for the rule this RFC called S0n1, and S007 for S0n2. The rules stay in `check/scenarios.ts`, which
  stays under the house rule's 300 lines, so there is no `check/answers.ts`. `judgeTree` judges each answers document
  in `judgeUses`, after the scenarios, through `checkAnswers`.
- S007 judges only a recorded scenario. A scenario written by hand that points is S006's alone, so one fault gets one
  refusal, and that includes a hand-written scenario with a path under both `stubs` and `sharedStubs`. S006 refuses each
  node written as a digest at `expect/nodes/<id>`, and `sharedStubs` once, at `sharedStubs`, whatever it holds.
- Where the answers document above a recorded scenario carries another `generated` mark, S007 reads the scenario's
  pointers as if no document were there (`nodesOf` and `stubsOf` with none), so each pointer is refused once, at its
  own path, and the message names both marks. Nothing is refused at the answers document for it.
- S002 in an answers document names the answer by its digest (`shared answer '<digest>' pins reason ...`), and its hint
  says to record the directory again, since a person does not edit the file. `checkPinnedReasons` takes where the map
  sits, what its keys name and that hint together, so one function judges both forms.
- The sabotage tests live in `packages/runtime/test/sabotage-shared-answers.test.ts`, one file for the three rules this
  RFC adds or widens. `example.test.ts` has no room under the house rule's 300 lines, and the S004 and S005 cases in
  `sabotage-scenarios.test.ts` plant a scenario of their own form.
- S006's hint names `wilanis scenarios --pin`, which step 6 (#884) adds. Until it lands, the second half of the hint,
  writing the value in place of the digest, is the fix.
