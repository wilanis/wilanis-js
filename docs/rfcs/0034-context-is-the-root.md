# RFC 0034: `context` is the root: one word for what a kind hands, where it is declared and where it is read

- **Status:** draft
- **Areas:** `area:core`, `area:compiler`, `area:engine`, `area:runtime`, `area:view`, `area:access`
- **Tracking issue:** #525
- **Depends on:** none. RFC 0029 fixed the three places the request is read and is unchanged by this; RFC 0009,
  RFC 0015 and RFC 0020 spell the root this RFC renames and are amended in the implementing pull request.

## Summary

The root a trigger's `fire.in`, a policy's `decide.in` and `proves`, a resolver's `read` and an invariant's
`requires.proves` read is spelled `context`, the word the trigger kind already declares it under
(`trigger-kind.context`) and the guard already adds to (`guard.context`). `request` stops being a word of the
language: it leaves the reserved roots, the engine's pseudo-nodes, the lowered IR, the scenario a run is kept as,
the schema descriptions, `describe`, the viewer and the template. After this a reader who sees `{{context.params.id}}`
in a trigger finds the field under `context.fields.params` in the document its `kind` line names, and nothing in
between translates one word into another. Two discoverability gaps close with it: `kind` in `trigger.schema.json`
gains the description it never had, and `wilanis describe` on a trigger says which kind hands the `context` its
`fire.in` reads.

## Motivation

An HTTP trigger kind declares what it hands under `context`:

```json
"context": {
  "fields": {
    "params": { "type": "$Params", "description": "the route's placeholders, each a string the route guarantees" }
  }
}
```

and the guard declares what it adds under `guard.context`. The trigger that reads it writes `{{request.params.id}}`.
Nothing in the trigger, in `trigger.schema.json` (`kind` is a bare `$ref` with no description) or in the kind
document says that `request` is the name of that block. The knowledge lives in the template `CLAUDE.md`, in one
schema description, and in the T003 refusal an author meets after guessing wrong. An agent that has read the kind
document, which is what the language tells it to do, has read the word `context` and is then asked to write
`request`. That is the one translation in a language whose whole design is that what a document names, a reader
can open.

The word is also the wrong one. `request` is HTTP's. The example fires `customer.port.json#digest` from a cron tick
whose context is `scheduled`, `fired` and `missed`; nobody requested anything. A command's context is `flags`,
`args`, `cwd` and `file`. The README merged as #524 exists to say that the language never learns what HTTP is, and
its own JSON blocks spell an HTTP word at the root of every read. Every trigger kind a plugin ships, and every
policy and resolver written to be kind-agnostic, carries that word.

This RFC does not change what may read the context or where: RFC 0029's rule, `fire.in`, `decide.in` and a
resolver's `read` and nowhere else, stands, and L002 still refuses a domain graph that reads it. It does not
change what any kind hands, nor how a resolver is bound under `reads`, nor how the guard adds `principal`,
`session` and `challenge`. It does not add an alias: there is one spelling after it, as there was one before.

## Guide-level explanation

A trigger names its kind, and the kind is the declaration of what the trigger may read. The route from the
example, after this RFC:

```json
{
  "label": "GET /customers/{id}",
  "kind": "@http/http.trigger-kind.json",
  "settings": { "route": "/customers/{id}", "method": "GET" },
  "in": "@customers/edge/IdRequest.shape.json",
  "out": "@customers/edge/CustomerView.shape.json",
  "fire": {
    "run": "@customers/domain/customer.port.json#get",
    "in": { "id": "{{context.params.id}}" }
  }
}
```

`{{context.params.id}}` is `context.fields.params` in `@http/http.trigger-kind.json`, and `wilanis describe` on the
kind prints that block under the heading `context`. `wilanis describe` on the trigger says so as well:

```
fires   @customers/domain/customer.port.json#get
    id ← {{context.params.id}}
    context is what @http/http.trigger-kind.json hands  → wilanis describe @http/http.trigger-kind.json
```

A policy attachment gives the guard its credentials from the same root, `"token": ["{{context.headers.authorization}}",
"{{context.cookies.session}}"]`, and a policy proves what the guard added: `"proves": ["context.principal",
"context.session"]`. A resolver reads it for the data layer, `"read": "context.session.id"`, and a data graph binds
that read under `reads` and spells `{{sid}}` exactly as it does today. An invariant that names what must be
established writes `"requires": { "proves": ["context.principal"] }`.

A trigger that still spells the old word is refused where it reads it, with the new spelling in the message:

```
T003  @features/customers/edge/get-customer.trigger.json#fire/in
    fire.in: id: 'request': the root is context, what the trigger kind hands; write {{context.params.id}}
    → wilanis describe @http/http.trigger-kind.json shows what this kind hands
```

## Reference

### Documents and schemas

No document kind is added and no field moves. What changes in `packages/core/schemas/`:

- `trigger.schema.json`: `kind` gains a description: "The trigger kind this trigger is of: a document a plugin
  grants (`@http/http.trigger-kind.json`, `@cli/cli.trigger-kind.json`). It declares the `settings` this trigger
  may carry and the `context` its `fire.in` and its policies read as `{{context.*}}`; `wilanis describe` on it
  shows both." `fire`'s description says `{{context.*}}` where it says `{{request.*}}`.
- `trigger-kind.schema.json`: the document description says the context is "what a trigger's input mapping,
  a policy and a resolver read as `context.*`".
- `resolvers.schema.json`, `policy.schema.json`, `invariant.schema.json`, `graph.schema.json`,
  `binding.schema.json`, `common.schema.json`, `project.schema.json`, `plugin.schema.json`: every description
  that spells `request.*` spells `context.*`. The `resolverRef` example in `common.schema.json` stays
  `@customers/edge/request.resolvers.json#agent`, since the example's file keeps its name (a resolvers
  document is named by its author, and "the request's resolvers" is what that one is).
- `scenario.schema.json`: the `request` property is renamed `context`, "the context the run read, for a trigger
  whose kind hands one; what `fire.in` and any policy read from". `ScenarioDoc` follows. No scenario is
  committed in this repository; a consumer's scenarios under `scenarios/` are rewritten by `wilanis fuzz`.
- `packages/runtime/templates/CLAUDE.md`: every `request.*` reads `context.*`; the bullet that today says
  "`request.*` (the trigger kind's context ...)" says "`context.*` is what the trigger kind declares under
  `context` and the guard adds under `guard.context`", and points at `wilanis describe <kind>`.

The interfaces in `packages/core/src/model.ts` do not change: no document carries the root as a key.

### Ports, operations and kinds granted

None added or changed. The three kinds this repository ships (`@http/http.trigger-kind.json`,
`@cli/cli.trigger-kind.json`, `@schedule/schedule.trigger-kind.json`) already declare their context under
`context`; their prose descriptions that say `request.body`, `request.params`, `request.flags` say `context.*`.
`@auth/plugin.json`'s `guard.context` is already the word; its prose and `@auth/session.port.json`'s follow.

### Checker rules

No new code. The rules that read the root keep their codes and change what they say:

| Code | Where it lives | Change |
|---|---|---|
| T003 | `check/triggers.ts`, through `requestOnly` in `check/typing.ts` | the root accepted is `context`; a read whose root is `request` is refused with "the root is context, what the trigger kind hands; write {{context.<path>}}" |
| A005, A006 | `check/access.ts` (`checkAttachment`, `checkGuardRead`) | walk reads rooted at `context` |
| A001 (`proves`, `decide.in`) | `check/access.ts` (`provesFaultIn`, `checkPolicy`) | "'…', which is not a context.* path", hint "write context.principal, context.session…" |
| G003 | `check/graph-reads.ts` (`rootReadRaw`) | "graphs do not read context.* -- a resolvers document does; bind it under reads and read {{name}}" |
| P006 | `check/judge.ts` (`RESERVED`) | `context` joins the reserved names and `request` leaves them: a node, constant or resolver named `context` is refused as a reserved root; one named `request` no longer is |
| B007, B008 | `check/project.ts` | a startup step or its bound graph reading `context.*` is refused, as `request.*` is today |
| X105 | `plugin-auth/src/scoped.ts` | a scope resolver reads `context.session.attributes.<name>` |

Every message and hint in the compiler and the plugins that spells `request` spells `context`; the messages
above are the ones a reader meets first.

### Runtime behaviour

The engine's pseudo-nodes (`PSEUDO` in `packages/engine/src/sources.ts`, the doc comment on `KSource.ref` in
`spec.ts`) are `in`, `const`, `context`. `lowerRef` in `packages/compiler/src/lower.ts` writes a resolver read and a
direct read as `{ ref: 'context', path }`; `Roots.request` is `Roots.context`; `compiler.ts` seeds the initial
values under `context`. `Embedder.fire` and `gate.ts` fill templates from `{ context }`. `fuzz.ts` and
`rehearse.ts` read a scenario's `context`. The trace prints the pseudo-node by its name, so a span that read the
request says `context.params.id`, in the tree's word. Nothing else the embedder, the handlers, `rehearse`, `fuzz`,
`regress` or `start` do changes.

`RunContext.request` in `packages/engine/src/spec.ts`, the field a handler receives, is renamed `context` in the
same step so that no TypeScript name in the engine spells the retired word (see Open questions).

### Discoverability

- `wilanis describe <trigger>`: `fireLines` in `packages/runtime/src/discovery.ts` adds one line after the
  reads when any of them is rooted at `context`: `context is what <kind> hands  → wilanis describe <kind>`.
  A policy attachment's `gives the guard` lines say the same once when they read `context.*`.
- `wilanis describe <trigger-kind>`: the heading `context (request.*):` becomes `context:`.
- `wilanis describe <plugin>` for the guard: `guard.context` is printed as `adds to context:`.
- The viewer: `requestNode` in `packages/view/src/reads.ts` and the store's node in `stores.ts` are the
  `context` node, labelled "Context", "what the trigger kind hands, read through …"; the kind page's heading in
  `client/index.html` reads "Context it hands: what context.* holds".
- `wilanis map` and `wilanis ls`: unchanged; neither prints the root.
- `README.md`: the sentence #524 left out, after the route block: the `context` the route reads is what its
  kind declares, and the checker types every path in `fire.in` against that declaration. Its blocks are
  re-copied from the example, which the fitness function `a-readme-snippet-is-a-document-in-the-tree` enforces.

### Plugin contract

`PluginModule` in `packages/core/src/plugin.ts` does not change. `RunContext` in `packages/engine/src/spec.ts`,
which every handler receives, renames its `request` field to `context`; the `@http` plugin's `serve.ts` and
the `@auth` plugin's handlers are the readers in this repository and move with it.

## Compatibility

IR v1 changes in place, as RFC 0008 allows before 1.0: the pseudo-node `request` in a lowered `KSource` becomes
`context`. A lowered spec is never written to disk, so no artifact reads differently; the one persisted record
of a run, a scenario, renames its key in the same step, and this repository commits none. The schemas change in
place: every description that spells `request.*` spells `context.*`, `kind` gains a description, and
`scenario.schema.json` renames one property. A consumer tree written against the served schemas and spelling
`{{request.*}}` is refused by T003, A001 or G003 with the new spelling in the message; nothing is published to
npm, so no consumer exists outside this repository. No `schemas-v2`.

The 12 documents of `example/` and the 13 of `libraries/access/` that spell the root migrate in the implementing
pull request, one word each. RFC 0009, RFC 0015 and RFC 0020, accepted and not yet implemented, are amended to the
new spelling in the same pull request. RFC 0005, RFC 0012, RFC 0029 and the other implemented RFCs that spell
`request.*` are the record of what was decided when, and stay as written; `docs/model.md` and `docs/demo.md` are
current documents and move.

## Tests

| Test | Where | What it does |
|---|---|---|
| the schema | `packages/core/test/validate.test.ts` | the baseline trigger, policy, resolvers and scenario documents spell `context`; a scenario with a `request` key is refused |
| T003 | `packages/runtime/test/example.test.ts`, sabotage | `{{request.params.id}}` in `get-customer.trigger.json`: T003, message names `context` |
| P006 | sabotage | a node with `"id": "context"` in `get-row.graph.json`; a resolver named `context` in `request.resolvers.json`; a node named `request` is accepted |
| A001 | sabotage | `"proves": ["request.principal"]` in `signed-in.policy.json`: the message says "not a context.* path" |
| G003 | sabotage | `{{context.headers.host}}` in a data graph body: "graphs do not read context.*" |
| the walk holds | existing A005, A006, T004, B007, B008, X105 cases, expectation unchanged | the migrated documents check clean and each sabotage answers its code |
| the example | `packages/runtime/test/example.test.ts`, `libraries/access/test` | `codes(EXAMPLE)` is empty after the migration |
| the engine | `packages/engine/test` | a spec reading `{ ref: 'context' }` runs; `PSEUDO` no longer holds `request` |
| the trace | `packages/runtime/test/trace.test.ts` | a span that read the context prints `context.params.id` |
| `describe` | `packages/runtime/test/tools.test.ts` | the trigger prints the `context is what … hands` line, and not for a trigger whose `fire.in` reads nothing; the kind prints `context:` |
| the viewer | `packages/view/test/view.test.ts` | `create-row`'s context node is labelled "Context" and its port opens `@customers/edge/request.resolvers.json` |
| the README | `fitness/a-readme-snippet-is-a-document-in-the-tree.fitness.ts` | every JSON block matches the migrated example |

## Implementation plan

1. The word moves, atomically: `RESERVED`, `requestOnly`, `rootReadRaw`, `provesFaultIn`, `checkAttachment`,
   `lowerRef` and `Roots` in the compiler; `PSEUDO`, `KSource`'s comment and `RunContext` in the engine;
   `compiler.ts`, `gate.ts`, `fuzz.ts`, `rehearse.ts` and the `@http` and `@auth` plugins' readers in the
   runtime; every schema description, `kind`'s new description and the scenario key in core; the validate
   baseline; the 25 documents of the two trees; the three kinds' and the guard's prose; the template
   `CLAUDE.md`; `docs/model.md`; the existing tests' expectations; the sabotage cases above. One pull request,
   because no alias means the compiler and the documents cannot move apart. Waits for the maintainer's approval
   in CI, since schemas change.
2. Runtime: the `context is what … hands` line in `fireLines` and the `gives the guard` lines; the kind's and
   the guard's `describe` headings; tests. (`good first issue`)
3. Viewer: the context node and the kind page's heading; test. (`good first issue`)
4. Docs: the README sentence and its re-copied blocks; `docs/demo.md`; RFC 0009, RFC 0015 and RFC 0020 amended.
   (`good first issue`)

The index row and the roadmap line are added in the pull request that proposes this RFC; no task carries them.

## Drawbacks and alternatives

**Cost.** About 25 documents, 22 pages under `docs/`, 11 schemas, 16 source files and 40 test files spell the
word, and step 1 moves most of them in one pull request. Pre-1.0 with nothing published is the one time this
costs a diff and nothing else; after 1.0 it would be `schemas-v2`.

**`context` is a common word.** The engine already has `RunContext`, the kind's block is "the context", and the
run's field becomes `ctx.context` in a handler. The RFC accepts that: the language has one word for the thing an
author reads, and the internal names are the ones that bend to it.

**Rename the kind's `context` to `request` instead.** One key in two schemas and the guard's manifest, no
document moves. It fixes the mismatch and bakes the HTTP word into every kind a plugin will ever ship, including
the cron kind that has no request. Rejected.

**`@self.request`, `@context.body.name`.** `@` has one meaning in this language, a document path a reader can
open, and discoverability is built on that. A root spelled `@…` that opens nothing would be the first exception.
Rejected.

**`{self.request}`, a second brace form.** Two interpolation grammars for one job is the ambiguity this RFC
removes, in a new place. Rejected.

**Accept both spellings for a while.** Two words for one thing is the defect. There is no consumer to migrate.
Rejected.

**A root per kind: `{{route.params.id}}`, `{{command.flags.code}}`.** It reads well in a trigger and destroys
the reason policies and resolvers are kind-agnostic: a policy proves `context.principal` for a route and a command
alike, and a resolver serves data graphs behind operations fired from three kinds. Rejected.

## Open questions

- Whether `RunContext.request`, the TypeScript field a handler receives, renames with the language. This RFC says
  yes, so that no name in the engine spells the retired word; the cost is `ctx.context` in every handler. To be
  decided before `accepted`.
- Whether the implemented RFCs that spell `request.*` (0005, 0012, 0029 among them) are amended or left as the
  record. This RFC leaves them; `docs/model.md` is the current statement. To be decided before `accepted`.
- The exact wording of the new `describe` line and of `kind`'s description may be settled during implementation.
