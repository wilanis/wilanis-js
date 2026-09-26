# The model

Every rule `wilanis check` enforces, stated once. The [README](../README.md) shows what a service looks
like; this page is the reference. [`CLAUDE.md`](../CLAUDE.md) is for changing the toolchain itself, and the
schemas under [`packages/core/schemas/`](../packages/core/schemas/) are what every rule here mirrors.

## Documents

- **One JSON file each.** The `$schema` names the kind:
  `https://raw.githubusercontent.com/wilanis/wilanis-js/main/packages/core/schemas/graph.schema.json`, or the
  alias `@wilanis/graph.schema.json`. Every kind carries an optional `label` and `description`.
- **References are paths.** `@features/tasks/tasks.port.json`; `project.json` declares aliases
  (`@tasks` → `@features/tasks`); plugins are alias roots (`@std`, `@http`); an operation is `path#operation`.
- **A document's place is a rule.** `HOME` in `packages/core/src/placement.ts` says which layer each kind
  lives in, and D008 refuses the rest.

## Features and layers

A feature is three directories, and the directory *is* the layer:

| Directory | What lives there |
|---|---|
| `edge/` | triggers, policies, the shapes the world speaks, resolvers |
| `domain/` | the port, the core shapes, the graphs that hold business rules |
| `data/` | the binding, and the graphs that translate and reach effects |

The checker reads the layer off the path and never infers it from who references a document.
`feature.json` lists the effects the feature may use.

## Shapes

A type: named fields with types, required unless said otherwise. A shape has a layer -- `edge` (what the
world imposes) or `core` (ours). An edge shape lives in `edge/`, a core shape in `domain/`. `unknown` exists
only in edge shapes and native contracts. The misspelled field a partner API returns lives in an edge shape
and never reaches the domain.

A list field may say `maxItems`, the most items a value may hold, judged wherever the type is judged at run
time. It bounds a list and nothing else: written on a field of a shape or a contract that is not a list, it is
C016.

## Ports and bindings

A **port** is a contract: operations with `accepts` and `returns`. `accepts` is fields by name, or the path of
a shape whose fields the operation takes, so a record taken whole is stated once; a call site gives the fields
one by one either way. Granted by a plugin it is *native* -- the
plugin implements it. Declared in a feature it is a *domain* port, and a **binding** meets it, per operation:
a data graph, or a delegation (`run` + `in`). Swap the binding and the same domain runs against a different
store, a fake, or a queue. A profile in `project.json` chooses the bindings.

## Graphs

Dataflow. Nodes have explicit types: `@wilanis/node/run.schema.json`, `switch`, `map`. A node runs when its
sources have settled, and independent nodes run concurrently. `switch` routes to exactly one node and cancels
the rest; `has(x)` in a rule proves `x` present for the routed node. Reconvergence happens only at `out.from`.

A switch may say `catch` (optional): node id to node id. When a named node breaks (its handler threw something
that is not a refusal, the graph it ran broke, its timeout struck), the run goes on and the switch routes to the
node named for it, as if a rule had held; the rules and `else` are not tried. The caught node is one the switch
reads (G021), read elsewhere only behind the switch (G022), and never read behind where its fault goes (G023);
only an effect is caught (G024), and only in a data graph (L013). A node an invariant is guarded at is not
caught (G025): the guard the compiler lowers moves it aside, so catch a node the invariant is not checked at,
or prove the rule where the value is made.

## One way in

A node's `in` gives every value an operation takes, in one grammar: a literal as written, or `{{fetched.status}}`
to read another node, the graph's `in`, a constant (`{{const.initial}}`) or a resolver. Embedded in text it
interpolates (`"/tasks/{{in.id}}"`). A key that is not an identifier is quoted in brackets:
`{{request.headers['user-agent']}}`. A contract marks the fields that must be literals `static` (a connection,
a content type); a `type` field always is.

## Types are declared, never inferred

`object#make`, `object#merge`, `list#first`, `list#concat`, `http#request` take a `type` or `returns` field
naming the result type, and the checker verifies the values given fit it.

## The standard library is four ports

`@std/object` (`make`, `merge`), `@std/text` (`fill`, `join`, `split`, `replace`), `@std/list` (`count`,
`first`, `concat`, `slice`), `@std/outcome` (`refuse`). All pure, legal in any layer.

## No absence

Required unless `required: false`; an optional value cannot feed a required one; a missing key stays missing.

## Files are blobs

A `blob` is a type: the value is a handle (id, contentType, size, filename) and the bytes live once, in the
runtime's blob registry -- files under `project.json → blobs.dir`, or the store a plugin opens for the
connection `blobs.connection` names, so a tree may keep them where every instance of it can reach them. An
upload streams into the registry through a content type mapped to `@http/codecs/blob.codec.json` and the graph
gets the handle; a download is a trigger whose `out` is `blob`, streamed back out. `@blob/csv.port.json` reads
a blob as rows of a declared shape and writes rows as one; every such operation is an effect, so it lives in a
data graph. Nothing of a file passes through the engine, and a run's blobs are released once the trigger has
answered.

## Triggers are generic

A trigger names its kind (an http route, a cli command, whatever a plugin grants), the settings that kind
judges, edge `in`/`out` types, and `fire`: the domain port operation it runs, with its inputs read from the
kind's context (`{{request.body.title}}`). **A trigger never names a graph**; the port's binding decides how
the operation is met.

A trigger with no `policies` is called by anyone, so every list its edge shapes take -- its `in`, and each
setting of its kind typed `type` -- says `maxItems`, at any depth; an unbounded one is T008, answered by
bounding the list or gating the trigger.

## Access is a trigger's declaration and a policy's decision

A trigger attaches the policies that gate it, in order, and where it attaches one it gives the guard the
credentials it verifies, read from the kind's context like any input:

```json
{ "policy": "@access/edge/employees-only.policy.json",
  "in": { "token": ["{{request.headers.authorization}}", "{{request.cookies.session}}"] } }
```

A list is the places a credential may sit, the first present wins; a later policy written bare reuses what an
earlier one gave. A **policy** lives in `edge/` and fires a domain operation the way a trigger does, reading
what the guard hands: `request.principal`, `request.session`, `request.challenge`. Its graph allows by
answering and refuses with a reason; `outcomes` says whether a reason is a `deny` or a `challenge`, and the
trigger maps every reason it can reach, its policies' included (T005).

Validating a credential happens in the guarding plugin, before any policy, never in a graph, and the guard's
`plugin.json` says which credentials it verifies and what each yields. A trigger with no policies is public.
`has(principal) && 'registrar' in principal.roles` is a rule: `in` looks into a list, and what `has()` proves
on the left of `&&` may be read on the right.

A session is opened when a token is issued and carries attributes of a shape the project names; a graph reads
and writes them through `@auth/session.port.json`, keyed by `request.session.id`, and `wilanis describe` on the
shape lists who writes what.

## Invariants are stated once

An `invariant` lives in a feature's `domain/` and states a rule the whole tree is held to, so that no document
has to remember it. An **access** invariant names domain port operations and the gate every way in that reaches
them must attach; reaching is transitive, so a graph cannot route around it by calling the operation itself, and
a trigger that reaches one of those operations without the gate is I001. A **field** invariant names a core shape
and a rule over its fields in the `switch` grammar
(`len(name) > 0 && len(email) > 0 && (tier != 'gold' || has(note))`).

A field invariant is judged where a value of the shape comes into being: a node that makes one, and a graph that
takes one as `in`. Where the rule is established there -- every root a literal, or a `switch` that routes to the
node having already said it, or the value read whole from another site of the same shape -- the site is proved
and costs nothing. Where it is not, the compiler lowers a guard the author never writes: a `switch` on the rule
routing to the value when it holds and to a refusal with the reserved reason `invariant` when it does not. The
trigger maps that reason like any other (T005), and `wilanis rehearse` reports each site as proved or guarded.

**A field invariant is held before the write.** The guard stands at the site, and a site is where a value is made,
so a rule over a record holds for the records a tree writes only where each is made before its write. Three rules
keep every write there. A `#patch` whose `changes` name a field such a rule reads is I007: a patch sets part of a
record, and a rule over several fields cannot be judged on a part, so a patch moving a customer to `gold` without a
note would commit before any guard saw the customer it left. A `#put` of a shape a field invariant is on whose
`record` is anything but one whole read of `in` or of a node is I008: a record written out at the write is made
nowhere the compiler guards. And a data graph that makes a value of such a shape, which one of its effects reads,
is L016: making the record is business, and a data graph translates. What remains is one form (RFC 0035). A domain
graph loads the record, lays the change over it with `@std/object.port.json#merge` into the shape, which is the
site the guard stands at, and hands the result to an operation whose data graph takes it whole as `in` and writes
it with `"record": "{{in}}"`, a taken site, guarded again whoever calls it. `wilanis new graph --port` scaffolds
the first half and `--store` the second. A field no rule reads may still be patched, and a read site stays guarded:
a row the tree did not write is refused where it is read rather than trusted.

## A tree includes trees

`project.json → includes` names npm packages whose `features/` load as if they sat here -- the same paths, the
same rules, visible through `exports` and `dependsOn`, bound by bindings and profiles -- and whose aliases come
along. Connections, plugins, settings, startup and profiles stay the host's; a port the include leaves unbound
is the host's to bind. An alias collision is D007, a feature present in both trees is D009, and a package that
is not a tree (or one using a plugin this project does not name) is D010. `@wilanis/access` is such a tree.

## Resolvers are reads

A `resolvers` document in a feature's `edge/` names what the data layer takes from the request
(`request.headers['user-agent']`); a data graph or a binding names the document and reads `{{agent}}`.
`request.*` is legal in a trigger's `fire.in`, a policy's `decide.in` and a resolver's `read`; nowhere else.
A resolver declared `required` is read as present, and every trigger reaching it must guarantee that: its kind
hands the path always, or a policy of the trigger lists it under `proves` (A006). A resolver is a read, never
an operation -- the compiler lowers it to a source reference and nothing runs.

## Effects are explicit

`http.request` answers status, headers and body. Whether a 404 is a failure is a `switch`'s decision: the body
is judged against `returns` only on a 2xx, so an error body reaches the switch. A node fails only on the
unexpected.

A port operation says whether calling it again changes anything further: `idempotent` (true, or an expression
over its accepted fields, as `request` says `method == 'GET' || ...`), or the `key` field a repeat is
recognised by. The words must fit the operation (C015), and a domain operation may promise only
`idempotent: true`, a promise every profile is held to: each effect the binding that meets it there reaches
must be idempotent where it is made, or the port is refused naming the profile, the binding and the node
(B011). Where the data layer names an effect -- a data graph's `run` or `map` node, or a binding's
operation -- it may say `timeoutMs` and `retry`; a domain graph says neither (L012). The checker refuses a
retry over what cannot fail transiently, a pure operation or a graph that reaches no effect (G017); over a
call that is not idempotent where it is made, judged over the literal inputs of the site or, for a binding's
graph, over every effect it reaches under each profile (G018); and a `retry.when` that is not boolean over the
fields of the answer (G019). Nothing below an atomic graph retries (G020): a failed statement has aborted the
transaction, so the retry belongs on the binding operation that runs the atomic graph, whose every try is a
transaction of its own and whose transactional effects G018 does not hold to idempotency. A retry repeats a
fault or a timeout, and an answer `when` accepts; never a refusal.

## The engine

Stateless and clockless. It runs all ready nodes concurrently, answers `blocked` with `needs` when input is
missing, accepts any node's value pre-supplied (that is replay), nests reports for binding graphs, and redacts
secrets.

## Scenarios

A `scenario` is a recorded run: `wilanis fuzz` writes one per trigger and seed, under stubs, to
`scenarios/fuzz/<trigger>.<seed>.scenario.json`, marked `"generated": "fuzz"`, and `wilanis regress` replays every
scenario under `scenarios/` node by node. `fuzz` records the reason a node refused with beside its status
(`expect.nodes.<id>.reason`), and the reason the run's declared refusal gave as `expect.reason`, and `regress` diffs
both, so a refusal that became a fault reads `reason missing → none`. The run's reason is compared where the scenario
records one or a command wrote it, so a hand-written scenario that leaves it out, and a flat file an older `fuzz`
wrote under `scenarios/`, replay as they did. A reason pinned on a node whose status is not `failed` is S002. A scenario's `cancelAt` names the stubbed effect at which
`regress` cancels the replay, so it is a key of the scenario's own `stubs` (S003). `fuzz` writes no scenario of a run that
faults under stubs: it prints `FAULT at '<node>'` and exits 1.

## Refusal codes

Every refusal carries a code, the file, an `at` path inside it, and a hint naming the command or the edit that
fixes it. The families, each judged in its own module under `packages/compiler/src/check/`:

| Family | What it judges |
|---|---|
| `D` | documents: the loader, schema validation, placement, includes |
| `R` | references: a path or an operation that does not resolve |
| `L` | layers, effects and visibility |
| `G` | graphs: nodes, reads, narrowing, the graph as a whole |
| `P` | static fields and resolvers |
| `B` | bindings, profiles and the startup steps |
| `T` | triggers |
| `S` | scenarios |
| `A` | access: policies, credentials, what a policy proves |
| `C` | connections, settings and stores |
| `X` | a plugin's own rules, from its `check` hook |

## project.json

```json
"plugins": [
  { "use": "@std" },
  { "use": "@cli" },
  { "use": "@http", "from": "@wilanis/plugin-http", "settings": { "port": 8099, "codecs": { "application/json": "@http/codecs/json.codec.json" } } }
]
```

`use` is the alias root. `from` is the npm package that ships the plugin, imported by the runtime from the
project's own `node_modules`. It is a package name and nothing else: a JSON document can never point at a file
on disk. `@std` and `@cli` are built into the runtime and take no `from`.

```json
"includes": [{ "from": "@wilanis/access", "features": ["access"] }]
```

`wilanis describe` and the viewer say `included from @wilanis/access` and name the file under `node_modules`.

A plugin package exports its `PluginModule` as the default export. Three hooks on it:

- `check(ctx)` adds the plugin's own rules (the `X` codes) to `wilanis check`.
- `guard` -- on the one plugin that identifies callers, declared in its `plugin.json` -- is called by the
  runtime around every fire of a trigger that attaches a policy, for every trigger kind alike: `identify`
  reads and verifies the credential and hands `request.principal`, `request.session`, `request.challenge`;
  `challenge` opens a challenge a policy asked for; `settle` spends what was single-use. The stubbed gates
  never call it.
- `postLoad(ctx)` runs once after the tree is loaded and judged, before any trigger starts, with the plugin's
  settings (secrets substituted), the registry, the scope and the environment. Open connections, warm caches,
  register parsers here. It may hand back a teardown, run when the runtime stops. `start` and a real `run`
  call it; the stubbed gates (`rehearse`, `fuzz`, `regress`, `run --seed`) do not.

## What a tree starts

`postLoad` is a plugin's own wiring, written in TypeScript, and a reader of the tree cannot see it. What *this*
project starts is declared instead, in `project.json → startup`:

```json
"startup": [
  { "label": "Open the pool", "run": "@board/domain/store.port.json#open" },
  { "label": "Watch for changes", "run": "@reload/watch.port.json#watch" },
  { "label": "Listen", "run": "@http/server.port.json#listen" }
]
```

`wilanis start` runs every plugin's `postLoad`, then these steps in order -- and nothing else. **The HTTP
server opens because the last step says so.** Delete it and nothing listens: no runtime decides on its own
that a tree with http triggers should open a port.

Each step names one port operation. Most name a **domain port**, so the active profile's binding decides how it
is met -- a fake in development, the real connection in production, without touching the step. Its `in` is
written as literals and `{{secrets.*}}`; nothing has been received yet, so a step that reads `request.*` -- or
whose bound graph does -- is refused before it ever runs (B007, B008).

A step may also name a `holds` operation: one that starts something outliving the run -- a listener, a watcher,
a subscription. A plugin grants it, `wilanis describe` marks it `(holds until stopped)`, and the runtime stops
what it started, in reverse, when the process ends. A graph may never run one (L008): what answers a request
cannot start a server.

A step that refuses stops the start and exits nonzero: a tree whose database is unreachable never opens its
port, rather than answering every route with a fault. Say `"required": false` for a step the tree can serve
without, and its refusal is logged while the rest go on.

```
$ npx wilanis start example
startup 1/3 Reach the customer store: ok
reload: watching /path/to/example -- an edit is served once it passes wilanis check
startup 2/3 Watch for changes: ok
http: listening on :8099 -- GET /customers → @customers/domain/customer.port.json#list, ...
startup 3/3 Listen: ok
```

With `@reload` among the steps, editing a document serves the new tree without closing the port; a change that
does not pass `wilanis check` is reported and the last good tree keeps answering.

## Schemas and versioning

The schemas live in [`packages/core/schemas/`](../packages/core/schemas/) and are served from `main`, so every
document can name its schema by URL and an editor can fetch it:

```
https://raw.githubusercontent.com/wilanis/wilanis-js/main/packages/core/schemas/<kind>.schema.json
```

Until 1.0 is published they are a working draft and `main` is their address. A schema changes in place, and
the documents this repository holds (`example/`, `libraries/`, every plugin's `docs/`) change in the same
commit, so `npm test` is the compatibility check. At 1.0 the tag `schemas-v1` marks the first supported version
and becomes the address, and from then on every change to a schema is compatible or breaking.
[RFC 0008](rfcs/0008-ir-versioning.md) states the rules. Node types are documents of their own under `node/`,
listed in `graph.schema.json`.

A change is *compatible* when every document that validated before still validates and means the same thing:
a new optional field whose absence means what the document meant before, a new document kind, a new node type,
a new port a plugin grants, a new refusal for something that was already wrong. A graph's `atomic` is such a
field, since a graph that leaves it out is not atomic and each of its effects commits on its own, as it did
before the field existed. A fourth node type beside `run`, `switch` and `map` in `graph.schema.json` is such a
type, since no document names it yet. A compatible change is made in place, and the tag `schemas-v1` moves to
the commit that makes it, because a change that keeps every document's meaning lets the address follow it.

A change is *breaking* when a document that validated stops validating or changes meaning: a field added to a
kind's `required`, a field removed or renamed, a default changed, a rule that now refuses a document it
accepted. Requiring `label` on a graph refuses every graph that leaves it out, and renaming a trigger's `fire`
refuses every trigger. A default can change a tree's meaning while it still validates: a field's `required`
defaults to `true` in `common.schema.json`, and turning it to `false` would make optional every field written
without it. A breaking change is never made in place. The base URL (`SCHEMA_BASE` in
`packages/core/src/published.ts`), every schema's `$id` and every kind's `$schema` enum move to the next tag,
`schemas-v2` for the first, and `schemas-v1` stays where it was, so a document written against v1 keeps
validating against the schemas it names.
