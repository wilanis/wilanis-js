# Working on wilanis

This is the `@wilanis/*` workspace. Read this before changing anything; it says where things live and which
direction dependencies may point.

## Layout

```
packages/    one npm package per directory: engine, core, compiler, runtime, view, and each plugin as plugin-<name>
libraries/   trees a project includes, published as @wilanis/<name>: pure JSON documents, each with its own test/
example/     a consumer project, JSON documents and a package.json; it includes @wilanis/access and uses every plugin
reserved/    names held on npm with no code under them; not workspace members, never built (reserved/README.md)
docs/        the language reference (model.md), the roadmap, the RFCs under rfcs/, the demos
fitness/     the decisions about the code, one claim per file; `ls fitness` is the index (fitness/README.md)
```

What is inside a package is read off the package, not kept here: `ls packages/<name>/src` for its modules, its
README for what it is for, and for a plugin `npx wilanis describe @<use>/plugin.json example` for the settings
it takes and what it grants and requires (the example names every plugin, so each resolves there).

Dependencies point one way: engine ← core ← compiler ← runtime ← view, and plugins depend on core and
engine only. The viewer is a tool over a loaded tree, not a plugin: it grants nothing to a tree and
executes nothing; `viewOf` is pure and the page under `client/` is one static file with no build step. A plugin never imports the compiler or the runtime. One plugin may import another only where that other is a **contract** it implements -- `@storage` says what a store is and an engine plugin answers it -- and the contract imports no engine, so the arrow still points one way. The runtime never reaches into a plugin's
internals; it sees the `PluginModule` contract in `packages/core/src/plugin.ts`. If a change needs an
import against this direction, the design is wrong, not the import rule. `fitness/dependencies-point-one-way.fitness.ts`
holds it against every manifest, and the engine and the compiler each have a narrower claim of their own.

Tests live beside what they test, in the package's own `test/` (`fitness/tests-live-beside-what-they-test.fitness.ts`).
The compiler's rules have no tests of their own: every checker rule is exercised through the example and its
sabotaged variants in `packages/runtime/test/example.test.ts`, where a real tree can be broken, and
`packages/compiler/test` holds only what a tree that passes cannot show (the atomic scope). A test may reach
against the arrow -- the runtime's and the viewer's tests load every plugin, a plugin's tests load the compiler
and the runtime -- only because its package names what it reaches under `devDependencies`; a `src/` file never
imports what its package names only there.

## Commands

```
npm install                 # links the workspace
npm run build               # tsc -b, project references, dependency order
npm run lint                # biome: formatting and the house rules (biome.jsonc)
npm run lint:fix            # the same, applying every safe fix
npm test                    # lint, build, then vitest
npx wilanis check example   # the CLI from the built runtime
npx wilanis check libraries/access   # the access tree on its own, with its development binding
npx wilanis start example   # run what its startup declares (the http listener among them)
npx wilanis-view example    # the viewer, on http://127.0.0.1:4400/
npm run release             # publishes every package in dependency order; refuses unless HEAD is tagged schemas-v1 (docs/roadmap.md, RFC 0008)
```

`npm test` must pass before a commit. Tests import the built `dist` of sibling packages, so a change in
core needs a build before its effect shows in a runtime test; `npm test` does that.

## Code quality

Biome lints and formats every `src/` and `test/` file; `biome.jsonc` is the one place the rules live, and says
why each is there. The house rules: a function under 50 lines and a cognitive complexity of 10; a file under
300 lines; at most 4 parameters (an options object beyond that); callbacks nested at most 3 deep; no nested
ternaries; no `!` and no `any` outside a test; a name of at least 2 characters (`_` for an ignored parameter).
A rule that bites is a design signal, not an obstacle: split the function along the steps it takes and name
each, or the file along the rule families it holds. The engine and the compiler are the reference: one class
or module per concern, a one-line doc comment on every public function saying what it answers.

Every directory meets the rules, so `npm run lint` is the whole story: it fails on a violation rather than
warning about one. The two overrides in `biome.jsonc` are not exemptions from the design but facts about the
code -- a test body is one long function and its `describe`/`it` nest, and the view model names a rule's
branches `then` and `otherwise`. Neither is a place to put new debt.

## Principles, and what they mean here

- **DRY.** A rule lives in one place. Document kinds are declared once in `model.ts` and once as a schema;
  the two mirror each other and `validate.ts` joins them. Refusal codes are produced by the checker (D R L
  G P B T A I C S) or a plugin's `check` (X); never duplicate a check in the runtime.
- **Orthogonality.** The engine knows nodes, sources and handlers; it never learns about files, shapes or
  triggers. A file's bytes live in the blob registry (`packages/runtime/src/blobs.ts`) and nowhere else: a
  `blob` value is a handle, codecs stream bodies in and out of the registry, and `@blob` operations stream
  what they read. Never buffer a blob whole beside the store. The compiler knows documents and the engine; it never learns about HTTP. Keep it that way.
  A feature is three directories -- `edge/`, `domain/`, `data/` -- and the directory *is* the layer: the
  checker reads it off the path rather than inferring a role from who references a document. A trigger fires
  a domain port operation through its `fire` run node and never names a graph, so the port is the one seam
  between the edge and the business. A binding says how a port is met and never cares which layer it is in.
  The request is read in three places only: a trigger's `fire.in`, a policy's `decide.in`, and a `resolvers`
  document (edge/) whose named reads a data graph or a binding uses as `{{name}}`. A resolver is a read, never
  an operation; the compiler lowers it to a source reference and nothing runs.
  Who is calling is the guard's business and what they may do is a policy's: the one plugin with a `guard`
  (`@auth`) verifies a credential before any graph runs and adds `request.principal`, `request.session`,
  `request.challenge` to every kind's context; a `policy` (edge/) fires a domain operation over those, and its
  graph refuses with a reason the policy maps to `deny` or `challenge`. A trigger attaches its policies
  in order, and where it attaches one it gives the guard the credentials it verifies (`in: { token: ... }`), read from
  the kind's context like any input; the runtime's embedder runs the gate (`gate` in `packages/runtime/src/gate.ts`), never a kind. No graph
  ever validates a token or a code, and no kind ever checks access.
  A tree may include trees (`project.json → includes`, npm packages only): the loader walks their `features/` as
  if local, marks each document `included`, brings their aliases along, and leaves their connections, plugins and
  settings behind. `libraries/` holds such trees; they are pure JSON with their own tests, and depend on no path
  into this repository, since the packages will move to repositories of their own.
- **Discoverability.** Every refusal has a code, a file, an `at` path and a hint that names the command
  or the edit that fixes it. Every document kind has a schema with descriptions. Every public function has a
  one-line doc comment that says what it answers. Who implements a thing is never a code detail: a domain
  port names its bindings, and a native port says which plugin grants it -- `wilanis describe` prints
  `granted by @http (@wilanis/plugin-http)` and the viewer links its manifest.

## How to change things

- **A new rule.** Add it to its family's module under `packages/compiler/src/check/` -- `project.ts` (C, B at
  the project, startup), `profiles.ts` (C017, C018 and, under each profile, B002, B003, B004, B011: what a
  profile chooses and whether every domain port is met and keeps its promises under it), `contracts.ts` (shapes,
  ports, connections), `resolvers.ts` (P), `inputs.ts` (a call site's inputs), `bindings.ts` (B), `required.ts` (B009, B010: what a binding of a port a plugin requires may read and may
  reach), `graph.ts` with `graph-nodes.ts`, `graph-reads.ts`, `graph-whole.ts`, `graph-routing.ts` (where a
  node sits in the routing, which G015 judges an effect by) and `narrowing.ts` (G), `triggers.ts` (T) with
  `bounds.ts` for the lists T008 finds unbounded, `scenarios.ts` (S),
  `access.ts` (A), `invariants.ts` (I: what an invariant states
  once and the whole tree is held to) with `invariant-holds.ts` beside it for the field form and `prove.ts`
  for whether a rule already holds where a value is made -- what the checker and the guard the compiler
  lowers both ask, through the one `heldAt`, so neither can prove a site the other would guard --,
  `graph-nodes.ts` again for I006, which is a rule about the word a `refuse` node may name and so belongs
  with the node it judges rather than with the invariant it reserves the word for,
  `attempts.ts` (G017, G018, G019: what a `retry` on a data graph's node or a binding's operation is written
  over, each asking `Judge.idempotentAt` whether the call is idempotent where it is made; a retry below an
  atomic graph is G020, in `atomic.ts`),
  `atomic.ts` (the L and G rules about what an
  atomic graph reaches: L009, L010, L011, G014 and G020, gathered there because each is a judgement over the one
  per-profile walk in `atomic-reach.ts` and not over a document) -- give it the next code, write the hint, and add a
  sabotage test in `packages/runtime/test/example.test.ts` that breaks the example and expects the code. What
  every family shares (typing a spec, visibility, the layer a type may name, settings that read secrets only)
  is a method of `Judge` in `check/judge.ts`; a refusal is made through `judge.refuser(file)`. The order the
  families run in is `judgeTree` in `checker.ts`.
- **A new placement rule.** Placement lives in one place: `HOME` in `packages/core/src/placement.ts`, which says
  the layer (or top-level directory) each kind lives in and refuses the rest as D008. Add the kind there, add
  its row to `packages/runtime/templates/CLAUDE.md`, and teach `into()` in `scaffolds.ts` where `wilanis new`
  should write it. A document's layer is read off its path by `layerOf` in `model.ts` -- never inferred from
  what references it.
- **A new document kind.** Schema in `packages/core/schemas/` (with `$id` under the published base and
  `$schema` accepting both forms, and the optional `label` every kind carries), a `*Doc` interface and the
  `Kind` entry in `model.ts`, a row in `packages/runtime/templates/CLAUDE.md`, the baseline in
  `packages/core/test/validate.test.ts`, a `wilanis new` scaffold in `scaffolds.ts`, and a page in the viewer's
  `client/index.html` (`renderDocPage`), since the viewer never shows raw JSON by default.
- **A new include.** A directory under `libraries/`, a workspace member, published as `@wilanis/<name>`: `project.json`
  (its own plugins and aliases; the host reads only the aliases), `features/<name>/` (what a host includes),
  a `-dev` feature and `connections/` that let it check, rehearse and run alone, a `test/` that loads it through
  `loadTree` with the plugins it needs, and a README saying what the host binds and configures. The example
  includes it with `"features": [...]` and binds its ports in a feature of its own. The loader's include walk is
  in `load.ts`; `resolveIncludes` in the runtime's `project.ts` finds the package; tests that copy the example
  hand the include in as `ResolvedInclude` since a copy has no `node_modules`.
- **A new access rule.** Policies and credentials are the `A` family in `check/access.ts` (`checkPolicy`, `checkAccess`);
  the guard's own reasons reach a trigger through `refusalsOfTrigger`. A rule about what the guard hands lives
  in the guard's `plugin.json` (`guard.credentials`, `guard.context`, `guard.refuses`), never in a trigger kind.
  What the `@auth` plugin alone can judge (a challenge method, a session write against the session shape) is its
  `check` (X101-X103).
- **What a guard lowers to.** A field invariant the checker could not prove at a site becomes a guard the author
  never writes (RFC 0007): `guardsOf` in `packages/compiler/src/guard.ts` asks `heldAt`'s `heldWhollyAt` which
  sites those are and builds the three kernel nodes, and `lowerGuards` in `guard-lowering.ts` writes them into
  the lowered spec -- the made node moved aside to `<id>:made` with whatever routed it, `<id>:check` testing the
  rule, `<id>` answering the value, `<id>:violated` refusing with the one reserved word `invariant`; a taken site
  is the same at `in:ok` through `Roots.aliases` in `lower.ts`, and a list of the shape a `map` over a nested
  spec. Those ids are a contract: the rehearsal, `describe` and the viewer all read a guard by them. The reason
  joins the walk in `refusals.ts`, so T005 holds a trigger reaching a guard to map it and T006 refuses mapping
  it where nothing is guarded -- and a proved site adds nothing, which is the whole incentive to prove one.
- **A schema change.** The pull request waits for the maintainer's approval in CI, as a change of decision
  does, because `main` serves the schemas to every tree. Until 1.0: edit in place. After 1.0: compatible,
  edit in place; breaking, the base URL in `model.ts` and every `$id` move to the tag `schemas-v2`, and the
  `schemas-v1` tag stays (RFC 0008).
- **A new plugin.** A new package under `packages/`, depending on core and engine only -- and, where it implements one, the contract plugin it answers -- exporting its
  `PluginModule` as default: `root`, `docs` (the directory of the JSON documents it ships, with
  `plugin.json`; listed in the package's `files`), `handlers`, and optionally `triggers`, `codecs`, `check`
  (its X rules; it refuses with a `Refusal` object: code, file, message, at, hint),
  `postLoad`, and -- for at most one plugin of a tree -- `guard`. Every port, kind, codec or shape a plugin grants is a file under `docs/`, never an object in
  code: what the DSL names, a reader can open. A project names the plugin in `plugins[].from`. Plugins that
  carry an external dependency are always their own package.
- **A new CLI command.** `packages/runtime/src/cli.ts` dispatches; the work goes in `tools.ts` or
  `serve.ts` so it is callable without the CLI.
- **What a tree starts.** Everything a tree starts is declared in `project.json → startup`, never decided by
  the runtime: `wilanis start` runs the plugins' `postLoad`, then those steps, and stops. The HTTP server
  opens because a step names `@http/server.port.json#listen`, so a tree that names none serves nothing.
  An operation that starts something outliving its run is marked `holds` in its port document (beside `pure`
  and `refuses`); it reads `env.hold` to hand back its teardown and `env.serving` to reach the tree, and the
  runtime stops what was held, in reverse, before the `postLoad` teardowns. Only a startup step may name one
  (L008 refuses a graph that runs one), and a native `holds` operation is the one native operation a startup
  step may name (B006 otherwise). `runStartup` lives in `serve.ts` and `Served` in `served.ts`; `checkStartup` in
  `check/project.ts` judges the steps (B006, B007, B008) and runs last, after the resolvers documents are read.
  A plugin's `postLoad` stays what it is: that plugin's own wiring, not the project's.
- **The project template.** `packages/runtime/templates/` is what `wilanis init` writes into a consumer
  tree. Its `CLAUDE.md` addresses an agent that writes documents, not one that changes this repository.
- **A decision about the code.** It is a file under `fitness/`, one per decision: `claim`, the sentence its
  name spells; `gather`, which reads the repository; `judge`, pure, from what was gathered to the violations,
  each naming the offending file and the edit that fixes it; and `sabotage`, the cases that prove the judge
  bites. `fitness/run.test.ts` registers a claim and its proof for every one; `fitness/lib/` holds readers
  only. **A fitness function that bites is a design signal**: the edit goes to the code, not to `fitness/`.
  Changing a decision is the maintainer's to make and to say -- the `Decision:` line is theirs to write, no
  tool adds it, and `.githooks/commit-msg` and the `decision` job refuse a commit that changes one silently.
  `fitness/README.md` and RFC 0027 are the whole story.

Do not add features, document kinds, or plugin hooks beyond what a task asks for. When a task seems to
need one, stop and say so.

## Commits

Messages are plain: what changed and why, in the imperative. No generated trailers, no tool or session
references. The one exception is a commit that touches `fitness/`, which carries a `Decision: (adds |
reconfigures | retires) fitness/<file> because ...` line saying what was decided and why. That line is the
maintainer's own words; no tool adds it, `.githooks/commit-msg` refuses the commit without it, and the
`decision` job in CI checks every such commit and then waits for the maintainer to approve the run. That job
waits only when there is something to approve: a change of decision, or of a schema under
`packages/core/schemas/`, which `main` serves to every tree; any other pull request skips it.