# RFC 0008: Versioning the intermediate representation

- **Status:** accepted
- **Areas:** area:core area:runtime area:process
- **Tracking issue:** #10
- **Depends on:** none

## Summary

The documents a tree is made of are the intermediate representation (IR). Its version is the path segment
in the schema URL every document names: `main` until 1.0 is published, then the tag `schemas-v1`. Until
1.0, v1 changes in place. From 1.0 on, v1 is frozen: a compatible change is made in place and a breaking
change opens the tag `schemas-v2`, and a runtime says which IR versions it reads and promises the same
semantics for a document it accepts.

## Motivation

An application written by an agent may run for years and be regenerated rarely. If the meaning of a
document changes under it, the tree that passed `wilanis check` yesterday fails, or worse, passes and
behaves differently. The report's item 22 asks for explicit compatibility semantics; the user's decision
is: one version, v1, until we publish, then the compatibility rules apply. This RFC writes those rules
down so the freeze is a fact and not a habit.

## Guide-level explanation

Every document names its kind and its version in one line:

```json
"$schema": "https://raw.githubusercontent.com/wilanis/wilanis-js/main/packages/core/schemas/graph.schema.json"
```

or the alias `@wilanis/graph.schema.json`, which the loader reads as the version the runtime prefers.
Until 1.0, `main` is the address and `packages/core/schemas/` there is what the URL serves. At 1.0 the
tag `schemas-v1` is cut and every URL moves to it. That address never changes again. The commit the tag
names does, to each compatible change (below), so the tag carries only what keeps a v1 document's meaning,
where a branch would carry every change.

**Before 1.0.** v1 is the working draft, and 1.0 waits for it: it is published only when no accepted RFC
still changes a schema, so what is frozen is final (`docs/roadmap.md` puts it last for that reason). A schema may change in place, a kind may be renamed, a rule
may tighten. Documents in this repository (`example/`, `libraries/`, every plugin's `docs/`) are updated
in the same commit, so `npm test` is the compatibility check.

**From 1.0 on.** A change to v1 is *compatible* when every document that validated before still
validates and means the same thing: a new optional field, a new document kind, a new node type, a new
port a plugin grants, a new refusal for something that was already wrong. Compatible changes are made
in place and the tag `schemas-v1` is moved to the new commit (a compatible change keeps every document's
meaning, so the address may follow it). A change is *breaking* when a valid document stops validating or changes
meaning: a required field added, a field removed or renamed, a default changed, a rule that now refuses
a document it accepted. A breaking change is tagged `schemas-v2`, with new `$id`s; the
`schemas-v1` tag stays where it was.

**What the runtime promises.** A runtime release states the IR versions it reads. A document of a
version it reads runs with the semantics that version's RFCs describe; a document of a version it does
not read is refused at load with the version it wanted and the runtime that reads it. `wilanis check`
prints the IR version of the tree beside the runtime's.

## Reference

### Documents and schemas

- `SCHEMA_BASE` in `packages/core/src/published.ts` holds the base URL; the version is the ref in its path,
  `main` or the tag `schemas-vN` (`irOf`). A breaking change moves it to the next tag, and the tag it leaves
  stays where it was.
- Every schema's `$id` and `$schema` enum carry the URL; `validate.ts` joins the kinds in `model.ts`
  with the schemas, so a version is one list in one place.
- `project.json` gains nothing: the version is per document, as today. Mixing versions in one tree is
  refused (see Checker rules).

### Ports, operations and kinds granted

None.

### Checker rules

| Code | Where it lives | Refuses when | Hint |
|---|---|---|---|
| D013 | `ir-version.ts` (core's loader) | a document names an IR version this runtime does not read | "this runtime reads v1; the document names v2: upgrade @wilanis/runtime, or rewrite the document against v1" |
| D014 | `ir-version.ts` (core's loader) | two documents of one tree name different IR versions | "a tree is one version: upgrade the rest, see docs/rfcs/0008" |

Numbers were assigned when step 3 landed; both rules live in the loader (see Decided during implementation).

### Runtime behaviour

- `wilanis check` and `wilanis describe project` print `IR v1, runtime reads v1`.
- The loader refuses a version it does not read before any other rule runs.

**A runtime reads one IR version, and that is deliberate.** A build of `@wilanis/runtime` reads exactly one
version; it does not read a v1 tree and a v2 tree side by side, and `runtime reads v1` is the whole of what
that line can say. Reading two would mean every rule in the checker, every lowering in the compiler and every
document kind carrying two meanings at once, judged by which tree it came from -- the checker's rules span
kinds, and a rule that must ask which version it is judging is a rule written twice. That is the cost the
per-kind alternative was rejected for in Drawbacks, and it is the same cost here, paid by the reader as well
as the code: a refusal would have to say which version it was refusing under.

A tree moves with `wilanis upgrade`, which rewrites its documents from one version to the next and is the
only supported path between them. A fleet that cannot move every tree at once pins the runtime it has --
versions are npm versions, and an old runtime keeps reading the trees it always read.

**An npm major of `@wilanis/runtime` may drop an IR version**, with the notice the ecosystem already
expects rather than a rule of our own invention: the version is deprecated in a minor release, which warns
on load and names `wilanis upgrade` and the version that will drop it, and it is removed no sooner than the
next major. A tree that has not moved keeps working on the runtime it is pinned to; nothing stops
serving because a newer runtime was published.
- Refusal codes and `at` paths are part of the promise: a code keeps its meaning within a version
  (RFC 0019 makes the full statement).

### Discoverability

`docs/rfcs/README.md` lists which RFCs are v1 and, later, which are v2. The README's "Schemas" section
already states the address rule; it gains the compatible/breaking definitions above.

### Plugin contract

A plugin's `plugin.json` names the IR version of the documents under its `docs/`; a plugin whose
documents are of a version the runtime does not read is refused at load with the same rule.

## Compatibility

This RFC is the compatibility rule. It changes no schema. It changes the README and adds two loader
rules that cannot fire on any v1 tree today.

## Tests

- A copy of the example with one document rewritten to a `schemas-v2` URL expects the version refusal.
- A copy with two versions mixed expects the mixing refusal.
- Both in `packages/runtime/test/sabotage-ir-version.test.ts`, beside the other sabotages; the plugin's case in
  `packages/core/test/ir-version.test.ts`.

## Implementation plan

1. Write the compatible/breaking definitions into `README.md → Schemas` (good first issue).
2. Print the IR version in `wilanis check` and `describe project`.
3. The two loader rules and their sabotage tests.
4. `wilanis upgrade`, when there is a second version to move to: it rewrites a tree's documents from one
   version to the next, in place, and says what it changed. Not written before v2 exists, since there is
   nothing for it to do.
5. The deprecation warning on load, when a version is first deprecated: it names `wilanis upgrade` and the
   major that will drop the version.
6. At 1.0: tag `schemas-v1` as frozen in the README and in this RFC's status.

## Drawbacks and alternatives

Freezing means a bad early decision lives in v1 for as long as v1 is read. The alternative, versioning
per kind, would let a graph be v2 while a shape is v1; it was rejected because the checker's rules
span kinds, so a version is a property of the tree.

## Decided during implementation

- D013 is a document of a version this runtime does not read, D014 a tree that mixes versions.
- Both rules are in core, `packages/core/src/ir-version.ts`, and `loadTree` runs them first. The table placed the
  mixing rule in the compiler's `check/project.ts`, but a `D` code is made only in core and in the runtime's project
  loader (`fitness/a-refusal-code-is-made-where-its-family-lives.fitness.ts`), and the checker runs after the loader,
  too late to judge anything before the rest.
- "Before any other rule" is read literally. The loader reads the `$schema` of every document the load will read
  before it judges one: the tree's, each include's `project.json` and the features taken from it, and the `docs/` of
  each plugin `project.json` names, a list read off it before it is judged by core's `listedIn`, the one reader the
  runtime also finds the packages with. A tree either rule refuses is answered with those refusals alone and nothing registered, so no D001 and
  no checker rule follows. Each document is parsed twice, once for its version and once to be judged.
- The alias names no version of its own and is read as the one this runtime reads, as the Guide says, so the alias
  beside the v1 URL is one version and mixes nothing.
- A runtime reads one version, so a tree that mixes two always holds documents it cannot read. D013 refuses each of
  them at its `$schema`, and D014 is said once, at `project.json` with no `at`, naming each version, how many
  documents name it and one of them. A tree wholly of another version is one version: D013 at every document, no
  D014.
- A `schemas-v1` address names v1, so a runtime still reading `main` does not refuse it as D013. It stays D001, an
  address this runtime's schemas are not published under until 1.0 (step 6).
- The hint is written for a document newer than the runtime, the one case a v1 runtime meets. A runtime reading v2
  meets older documents, and step 4, `wilanis upgrade`, gives that case its own.
- `irOf` moved from the runtime's manifest to `packages/core/src/published.ts`, beside `SCHEMA_BASE`, with `IR_READ`
  (the version this runtime reads) and `irOfSchema` (the version a `$schema` names). The manifest's `ir` and the
  `IR v1, runtime reads v1` line read `IR_READ`.
- The sabotage tests are in a file of their own rather than `example.test.ts`, which is at the house rule's file
  length.
