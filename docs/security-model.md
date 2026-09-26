# The security model

What a tree can and cannot do, in four kinds of sentence. A line under *Guaranteed by the checker* is proved of
every tree `wilanis check` accepts, by the refusal codes it names, each linked to the page that says what it
refuses; a line under *Enforced by the runtime* is true of every run, whether or not the tree was checked, and
names the source that keeps it; a line under *The application's* is nobody's but yours; *Outside the model* is
what this page does not address. Each line under the first two says the RFC that added it. When a line is
false, read [`SECURITY.md`](../SECURITY.md): the code is fixed, and the page is not softened to match the bug.
[`CONTRIBUTING.md`](../CONTRIBUTING.md) says who may add, change or remove a line.

## A document never runs code

A tree is JSON. No node evaluates a string, no template calls a function, and no document names code on disk.
A switch rule is `has`, `len`, comparison, `in` and boolean operators over paths
(`packages/core/src/expr/ast.ts`); a template `{{path}}` is a read; `plugins[].from` and `includes[].from` are
npm package names, never paths. Adding any of these is an RFC that edits this page first.

## Guaranteed by the checker

- Every document is JSON of a kind the schemas know and a tree may author, in the place its kind lives in,
  under one `project.json` at the root. [[D000](refusals/D000.md), [D001](refusals/D001.md),
  [D003](refusals/D003.md), [D004](refusals/D004.md), [D005](refusals/D005.md), [D008](refusals/D008.md)]
  (before the RFCs)
- Every reference resolves, and to another feature's document only where that feature is named in `dependsOn`
  and exports it. [[R001](refusals/R001.md), [L005](refusals/L005.md)] (before the RFCs)
- A document's layer is its directory, and a type crosses a layer only where the layer allows.
  [[D008](refusals/D008.md), [L001](refusals/L001.md)] (before the RFCs)
- A plugin or an include is an npm package the project names, an include uses only plugins the project names,
  and a feature lives in one tree. [[D006](refusals/D006.md), [D009](refusals/D009.md), [D010](refusals/D010.md)]
  (before the RFCs)
- An alias names one thing: not a plugin root, not a reserved root, not a folder, and not two things across an
  include. [[D007](refusals/D007.md)] (before the RFCs)
- A domain graph reaches no effect and reads no request, and a data graph runs no domain operation.
  [[L002](refusals/L002.md)] (before the RFCs)
- A data graph or a binding reaches only the effects its feature allows. [[L003](refusals/L003.md)] (before the
  RFCs)
- A domain graph does more than forward, and a binding lives inside a feature. [[L007](refusals/L007.md)] (before
  the RFCs)
- A trigger and a policy fire a domain operation and never a native one, and a graph never runs a `holds`
  operation. [[L006](refusals/L006.md), [L008](refusals/L008.md)] (before the RFCs)
- A startup step names a domain operation or a native `holds` operation, with inputs it has and no read of the
  request. [[B006](refusals/B006.md), [B007](refusals/B007.md), [B008](refusals/B008.md)] (before the RFCs)
- Every value fits the type declared for it, every input is given, once, from something that exists, and a field
  the checker must see is written as a literal. [[G003](refusals/G003.md), [G004](refusals/G004.md),
  [G005](refusals/G005.md), [G006](refusals/G006.md), [G013](refusals/G013.md), [B005](refusals/B005.md),
  [T001](refusals/T001.md), [T002](refusals/T002.md), [T003](refusals/T003.md), [C002](refusals/C002.md),
  [P001](refusals/P001.md)] (before the RFCs)
- A graph is acyclic, its node ids are its own, its routes, maps and `out` name what exists and fits, and every
  node, constant and input is read. [[G001](refusals/G001.md), [G007](refusals/G007.md), [G008](refusals/G008.md),
  [G009](refusals/G009.md), [G010](refusals/G010.md), [G012](refusals/G012.md)] (before the RFCs)
- A switch rule is a boolean expression over the node's inputs. [[G011](refusals/G011.md)] (before the RFCs)
- The request is read in a trigger's `fire.in`, a policy's `decide.in` and a resolvers document only, and a
  resolver reads only a path the trigger's kind or the guard hands. [[G003](refusals/G003.md),
  [L002](refusals/L002.md), [P002](refusals/P002.md), [P003](refusals/P003.md), [T004](refusals/T004.md),
  [A001](refusals/A001.md)] (before the RFCs)
- Every refusal a trigger can reach, its policies' and the guard's included, is mapped to an answer, every mapped
  reason is reached, and a challenge names its method. [[T005](refusals/T005.md), [T006](refusals/T006.md),
  [A002](refusals/A002.md), [A003](refusals/A003.md)] (before the RFCs)
- A credential a policy needs is one the guard verifies, and a trigger that attaches a policy gives the guard the
  credentials it reads. [[A004](refusals/A004.md), [A005](refusals/A005.md)] (before the RFCs)
- A `required` resolver is handed by the trigger's kind or proved by one of its policies, on every trigger that
  reads it. [[A006](refusals/A006.md)] (before the RFCs)
- Plugin and connection settings read `{{secrets.*}}` and nothing else, and fit the type their kind or manifest
  declares. [[C001](refusals/C001.md), [C002](refusals/C002.md)] (before the RFCs)
- Every declared profile is judged, and under each every domain port has one binding that meets every operation
  of that port; a native port is bound by its plugin alone. [[B001](refusals/B001.md), [B002](refusals/B002.md),
  [B003](refusals/B003.md), [B004](refusals/B004.md)] (before the RFCs)
- A scenario names a trigger of the tree. [[S001](refusals/S001.md)] (before the RFCs)
- The http plugin's codec table names codecs, every content type in use has one, and a throttle lets something
  through. [[X001](refusals/X001.md), [X002](refusals/X002.md), [X003](refusals/X003.md)] (before the RFCs)
- The guard's session is a shape, a session is read and written within it, and a challenge names a method the
  settings declare. [[X101](refusals/X101.md), [X102](refusals/X102.md), [X103](refusals/X103.md)] (before the
  RFCs)
- A trigger that reaches an operation an access invariant covers attaches the policy it requires, and an
  invariant names only domain operations, paths the guard hands and core shapes, and is reached.
  [[I001](refusals/I001.md), [I002](refusals/I002.md), [I003](refusals/I003.md)] (RFC 0007)
- A field invariant's rule parses and types against its shape, a value written in literals that breaks it is
  refused where it is made, and no graph refuses with the word its guards reserve. [[I004](refusals/I004.md),
  [I005](refusals/I005.md), [I006](refusals/I006.md)] (RFC 0007)
- A store's scope is fed from what the guard hands and never from what the caller could send, and a view that
  sees every row is reached only behind its policy. [[A007](refusals/A007.md), [A008](refusals/A008.md),
  [C012](refusals/C012.md), [C013](refusals/C013.md), [X105](refusals/X105.md), [X214](refusals/X214.md)]
  (RFC 0015)
- A graph, a binding or a store names under `reads` each read it takes from the request, and no other.
  [[G003](refusals/G003.md), [P004](refusals/P004.md), [P005](refusals/P005.md), [P006](refusals/P006.md)]
  (RFC 0029)
- At most one profile is the default, a stand-in is a connection of the same kind, every declared secret is read,
  and a startup step names only declared profiles. [[C017](refusals/C017.md), [C018](refusals/C018.md),
  [C019](refusals/C019.md), [B012](refusals/B012.md)] (RFC 0013)

## Enforced by the runtime

- The guard verifies a credential before any graph runs, on every fire of a trigger that attaches a policy, and
  its refusal ends the run as `identify` with no policy and no graph run. (`gate` in
  `packages/runtime/src/gate.ts`, run by `Embedder` in `packages/runtime/src/embed.ts`; `Guard` in
  `packages/core/src/plugin.ts`; before the RFCs)
- The stubbed gates never call the guard: `rehearse`, `fuzz` and `regress` prove nothing about identity.
  (`gate` in `packages/runtime/src/gate.ts`, `Embedder.stubbed` in `packages/runtime/src/embed.ts`; before the
  RFCs)
- What the guard learned reaches a graph as `request.principal`, `request.session` and `request.challenge` and by
  no other path, and it is what the credential established, never the token or the code itself. (`identifies` in
  `packages/runtime/src/gate.ts`; `guard` in `packages/plugin-auth/src/guard.ts`; before the RFCs)
- A field marked `secret` is `«secret»` in every report's `in` and `out`, to a depth of six fields inside a type.
  (`packages/engine/src/redact.ts`, applied in `packages/engine/src/run.ts` and `packages/engine/src/map.ts`;
  `secretPaths` and `SECRET_DEPTH` in `packages/compiler/src/lower.ts`; before the RFCs)
- A `{{secrets.*}}` read is substituted into plugin settings, connection settings and a startup step's `in`, and
  nowhere else; settings reach no report, and a step's `in` is redacted where its operation marks the field
  `secret`. (`Secrets` in `packages/compiler/src/env.ts`; `Embedder.startup` in `packages/runtime/src/embed.ts`;
  before the RFCs)
- A blob's bytes live once, in the store; a graph carries a handle, a handle opens a blob of the store and never
  a path a caller wrote, and nothing reads a blob whole. (`packages/runtime/src/blobs.ts`,
  `packages/plugin-s3/src/store.ts`; `fitness/a-blob-is-never-read-whole.fitness.ts`; before the RFCs)
- Nothing listens unless a startup step says so, and a required step that refuses stops the start with nothing
  serving. (`runStartup` and `start` in `packages/runtime/src/serve.ts`; before the RFCs)
- `wilanis start` runs `wilanis check` first and refuses a tree that does not pass. (`check` in
  `packages/runtime/src/cli.ts`; before the RFCs)
- A plugin is imported from the project's own `node_modules` by package name, an include is found there the same
  way, and a `from` that is not a package name is refused. (`pluginFrom` and `includeFrom` in
  `packages/runtime/src/project.ts`; before the RFCs)
- A deadline an http route or a schedule declares cancels the run when it passes, a `maxBodyBytes` an http route
  or connection declares cuts a body off at its bound, and a map's `limit` fails a longer list before any element
  starts; a cancelled run answers no output, and cancelling undoes no effect that ran, except that an atomic
  graph's transaction rolls back. (`withDeadline` and `bounded` in `packages/plugin-http/src/limit.ts`,
  `deadlineOf` in `packages/plugin-schedule/src/clock.ts`, `packages/engine/src/map.ts`, `reportOf` in
  `packages/engine/src/report.ts`, `inScope` in `packages/compiler/src/atomic.ts`; RFC 0012)
- A `retry` on a node or a binding's operation repeats a fault, a timeout or an answer its `when` accepts, and
  never a refusal. (`againBecause` in `packages/compiler/src/attempts.ts`; RFC 0011)
- An http caller is told a refusal's reason and message, a fault as the word `fault` and the run's id, and never
  what broke; `wilanis run` prints what broke to the operator who ran it. (`fault` and `encode` in
  `packages/plugin-http/src/answer.ts`; RFC 0014)
- `wilanis start` stops before any plugin's `postLoad` when a variable behind a secret the profile's reach reads
  is unset. (`chosen` in `packages/runtime/src/serve.ts`, `secretsRefusal` in `packages/runtime/src/profile.ts`;
  RFC 0013)
- A run's trace carries status, timing and what ran, and never a value, at level `summary`; `full` adds the
  report's `in` and `out`, already redacted, and each node's message as written; a refusal's `detail` enters
  neither. (`packages/runtime/src/trace.ts`, `valued` in `packages/runtime/src/trace-span.ts`; RFC 0006)
- The guard's sessions and challenges are kept where the project binds `@auth/state.port.json`, and a refresh
  token is kept and compared only as its hash. (`packages/plugin-auth/src/state.ts`; `issueTokens` and `refresh`
  in `packages/plugin-auth/src/tokens.ts`; RFC 0005)

## The application's

- A business rule the checker cannot express. An invariant of RFC 0007 is a guarantee once written; until it is
  written, the rule is yours.
- The behaviour of the system a connection reaches, and which hosts, tables or buckets its settings name.
- The truth of a directory the guard trusts, and of the issuer an OIDC connection names.
- The logic of your policies: who may do what is what their graphs decide.
- The values of your secrets, and the environment that holds them.
- Whether a credential belongs in a queue message's body. It does not: a worker's trigger gives the guard its
  credentials like any other trigger, and a body is data.

## Outside the model

The packages `plugins[].from` names run in the process with everything the process has, and the packages
`includes[].from` names are installed like any other: a compromised plugin is not a tree problem, and the model
says only what a plugin may be *asked* to do. The Node process, the host, the network between the listener and
its clients (TLS is the load balancer's, or the listener's settings, not the tree's), and the operator's shell and
what it exports are the deployment's. How this repository's own packages are reviewed is
[`CONTRIBUTING.md`](../CONTRIBUTING.md)'s to say.
