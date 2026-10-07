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
- Every document a load reads, the tree's, its includes' and its plugins' alike, names the one IR version this runtime
  reads. [[D013](refusals/D013.md), [D014](refusals/D014.md)] (RFC 0008)
- Every reference resolves, and to another feature's document only where that feature is named in `dependsOn`
  and exports it. [[R001](refusals/R001.md), [L005](refusals/L005.md)] (before the RFCs)
- A document's layer is its directory, and a type crosses a layer only where the layer allows.
  [[D008](refusals/D008.md), [L001](refusals/L001.md)] (before the RFCs)
- A plugin or an include is an npm package the project names, an include uses only plugins the project names,
  and a feature lives in one tree. [[D006](refusals/D006.md), [D009](refusals/D009.md), [D010](refusals/D010.md)]
  (before the RFCs)
- A port a plugin ships resolves a type variable only from static inputs of the same operation, before anything runs.
  [[D011](refusals/D011.md)] (RFC 0002)
- A port a plugin requires is one it ships and does not grant; its binding reads nothing of the context, and nothing
  it reaches refuses on purpose or starts something that outlives the run. [[D012](refusals/D012.md),
  [B009](refusals/B009.md), [B010](refusals/B010.md)] (RFC 0005)
- An alias names one thing: not a plugin root, not a reserved root, not a folder, and not two things across an
  include. [[D007](refusals/D007.md)] (before the RFCs)
- A domain graph reaches no effect and reads no context, and a data graph runs no domain operation.
  [[L002](refusals/L002.md)] (before the RFCs)
- A data graph or a binding reaches only the effects its feature allows. [[L003](refusals/L003.md)] (before the
  RFCs)
- A domain graph does more than forward, and a binding lives inside a feature. [[L007](refusals/L007.md)] (before
  the RFCs)
- A trigger and a policy fire a domain operation and never a native one, and a graph never runs a `holds`
  operation. [[L006](refusals/L006.md), [L008](refusals/L008.md)] (before the RFCs)
- A startup step names a domain operation or a native `holds` operation, with inputs it has and no read of the
  context. [[B006](refusals/B006.md), [B007](refusals/B007.md), [B008](refusals/B008.md)] (before the RFCs)
- An operation that listens is one that holds, and each part of the address it binds is read from an input it accepts
  or a setting its plugin declares, of the part's type; a port the tree writes as a literal where a `listens` reads it
  is a whole number from 0 to 65535; a connection kind's `endpoint` is a string setting it declares.
  [[L014](refusals/L014.md), [L015](refusals/L015.md), [L017](refusals/L017.md), [L018](refusals/L018.md),
  [C020](refusals/C020.md)] (RFC 0024)
- Every value fits the type declared for it, every input is given, once, from something that exists, and a field
  the checker must see is written as a literal. [[G003](refusals/G003.md), [G004](refusals/G004.md),
  [G005](refusals/G005.md), [G006](refusals/G006.md), [G013](refusals/G013.md), [B005](refusals/B005.md),
  [T001](refusals/T001.md), [T002](refusals/T002.md), [T003](refusals/T003.md), [C002](refusals/C002.md),
  [P001](refusals/P001.md)] (before the RFCs)
- A graph is acyclic, its node ids are its own, its routes, maps and `out` name what exists and fits, and every
  node, constant and input is read. [[G001](refusals/G001.md), [G007](refusals/G007.md), [G008](refusals/G008.md),
  [G009](refusals/G009.md), [G010](refusals/G010.md), [G012](refusals/G012.md)] (before the RFCs)
- A switch rule is a boolean expression over the node's inputs. [[G011](refusals/G011.md)] (before the RFCs)
- A domain graph catches nothing. A data graph's switch catches only an effect it reads and no other switch catches,
  routes its fault to another node, and never catches a guarded site; nothing that runs on the fault reads what broke,
  and every other reader of the caught node runs behind the switch. [[L013](refusals/L013.md),
  [G021](refusals/G021.md), [G022](refusals/G022.md), [G023](refusals/G023.md), [G024](refusals/G024.md),
  [G025](refusals/G025.md)] (RFC 0014)
- A refusal's message never reads a field marked secret. [[G016](refusals/G016.md)] (RFC 0014)
- An effect whose answer is read only behind a switch runs behind that switch, never beside it on every branch,
  unless it is the graph's answer (`out.from`). [[G015](refusals/G015.md)] (RFC 0035)
- The context a trigger kind hands is read as `context.*` in a trigger's `fire.in`, a policy's `decide.in` and a
  resolvers document only, and a resolver reads only a path the trigger's kind or the guard hands. [[G003](refusals/G003.md),
  [L002](refusals/L002.md), [P002](refusals/P002.md), [P003](refusals/P003.md), [T004](refusals/T004.md),
  [A001](refusals/A001.md)] (before the RFCs)
- Every refusal a trigger can reach, its policies' and the guard's included, is mapped to an answer, every mapped
  reason is reached, and a challenge names its method. [[T005](refusals/T005.md), [T006](refusals/T006.md),
  [A002](refusals/A002.md), [A003](refusals/A003.md)] (before the RFCs)
- A credential a policy needs is one the guard verifies, and a trigger that attaches a policy gives the guard the
  credentials it reads. [[A004](refusals/A004.md), [A005](refusals/A005.md)] (before the RFCs)
- A `required` resolver is handed by the trigger's kind or proved by one of its policies, on every trigger that
  reads it. [[A006](refusals/A006.md)] (before the RFCs)
- A trigger anyone may call takes no list without a `maxItems`, a `maxItems` bounds only a list, and every deadline
  and body bound the http plugin, its triggers and its connections declare can be met. [[T008](refusals/T008.md),
  [C016](refusals/C016.md), [X004](refusals/X004.md)] (RFC 0012)
- A trigger kind correlates a run only by a path its context hands, and the trace exporter's endpoint is an http URL
  or a secret and its level one the runtime has. [[T007](refusals/T007.md), [X301](refusals/X301.md)] (RFC 0006)
- A trigger fed by a connection receives from one that delivers messages, named as a literal. A queue trigger asks
  only what its broker can do; a publish whose connection and queue are written as literals, and that a trigger of
  the same tree receives from, fits the message that trigger takes; no publish and no queue trigger's message
  carries a blob; a publish written in an atomic graph goes to a broker kept in the store; and one queue fires one
  trigger.
  [[T010](refusals/T010.md), [X401](refusals/X401.md), [X402](refusals/X402.md), [X403](refusals/X403.md),
  [X404](refusals/X404.md), [X405](refusals/X405.md), [X406](refusals/X406.md)] (RFC 0009)
- A scheduled trigger says one schedule that parses, declares no input nobody hands, and catches up only where a
  connection that can hold a lease keeps the last tick. [[X251](refusals/X251.md), [X252](refusals/X252.md),
  [X253](refusals/X253.md), [X254](refusals/X254.md)] (RFC 0010)
- Plugin and connection settings read `{{secrets.*}}` and nothing else, and fit the type their kind or manifest
  declares. [[C001](refusals/C001.md), [C002](refusals/C002.md)] (before the RFCs)
- Every declared profile is judged, and under each every domain port has one binding that meets every operation
  of that port; a native port is bound by its plugin alone. [[B001](refusals/B001.md), [B002](refusals/B002.md),
  [B003](refusals/B003.md), [B004](refusals/B004.md)] (before the RFCs)
- A scenario names a trigger of the tree. [[S001](refusals/S001.md)] (before the RFCs)
- A scenario expects only what a run can produce: a reason on a node that failed, a cancel where it stubs, a branch
  the tree has, and a policy its trigger attaches. [[S002](refusals/S002.md), [S003](refusals/S003.md),
  [S004](refusals/S004.md), [S005](refusals/S005.md)] (RFC 0012, RFC 0014, RFC 0018)
- The http plugin's codec table names codecs, every content type in use has one, and a throttle lets something
  through. [[X001](refusals/X001.md), [X002](refusals/X002.md), [X003](refusals/X003.md)] (before the RFCs)
- The guard's session is a shape, a session is read and written within it, and a challenge names a method the
  settings declare. [[X101](refusals/X101.md), [X102](refusals/X102.md), [X103](refusals/X103.md)] (before the
  RFCs)
- A relative `dir` never puts the guard's files at the tree's root, above it, or where the loader reads documents;
  an absolute one is taken as written. [[X106](refusals/X106.md)] (RFC 0005)
- A trigger that reaches an operation an access invariant covers attaches the policy it requires, and an
  invariant names only domain operations, paths a trigger's kind or the guard hands and core shapes, and is
  reached.
  [[I001](refusals/I001.md), [I002](refusals/I002.md), [I003](refusals/I003.md)] (RFC 0007)
- A field invariant's rule parses and types against its shape, a value written in literals that breaks it is refused
  where it is made, and no graph refuses with the word its guards reserve; a write of its shape takes the whole record
  from where it is made upstream, never patches a field the rule reads, and is never composed in a data graph.
  [[I004](refusals/I004.md), [I005](refusals/I005.md), [I006](refusals/I006.md), [I007](refusals/I007.md),
  [I008](refusals/I008.md), [L016](refusals/L016.md)] (RFC 0007, RFC 0035)
- A store's scope is fed from what the guard hands and never from what the caller could send, and a view that
  sees every row is reached only behind its policy. [[A007](refusals/A007.md), [A008](refusals/A008.md),
  [C012](refusals/C012.md), [C013](refusals/C013.md), [X105](refusals/X105.md), [X214](refusals/X214.md)]
  (RFC 0015)
- A store keeps no edge shape, over a connection that reaches a storage engine, keyed by a field every record has; its
  constraints and defaults name fields of its shape; a default is a literal its field accepts, never on the key; a
  `unique` or `refs` entry names neither the key nor a field of a type an engine cannot index; a `unique` names only
  fields of a class the kind of the store's connection lists under `capabilities.unique`, and a `refs` is
  declared only over a kind whose `capabilities.refs` is true; a reference holds the key of a collection of the same
  store; and two stores share a collection only with one shape.
  [[X201](refusals/X201.md), [X202](refusals/X202.md), [X203](refusals/X203.md), [X207](refusals/X207.md),
  [C003](refusals/C003.md), [C004](refusals/C004.md), [C005](refusals/C005.md), [C006](refusals/C006.md),
  [C007](refusals/C007.md), [C008](refusals/C008.md)] (RFC 0003)
- A call to a store names a store of its own feature and a collection it declares, filters, sorts and patches only
  fields its shape has and never its key, with literals and reads of the graph's `in` that those fields accept (a
  read of an earlier node's answer is not judged), and the engine is prepared by a startup step alone. [[X204](refusals/X204.md), [X208](refusals/X208.md), [X209](refusals/X209.md), [X210](refusals/X210.md),
  [X211](refusals/X211.md), [X212](refusals/X212.md), [X213](refusals/X213.md)] (RFC 0003)
- A collection's `renamed` and `was` describe a rename, never one field into two or one table onto another.
  [[C010](refusals/C010.md), [C011](refusals/C011.md)] (RFC 0017)
- A collection kept in PostgreSQL holds no blob, is keyed by a field the engine can make a key for, and has a name
  PostgreSQL keeps as a table of its own. [[X221](refusals/X221.md), [X222](refusals/X222.md),
  [X223](refusals/X223.md)] (RFC 0022)
- A collection kept in SQLite holds no blob, is keyed by a field the engine can make a key for under its `keyType`,
  and has a name SQLite will create as a table and keep apart from every other collection of its file once case is
  ignored. [[X231](refusals/X231.md), [X232](refusals/X232.md), [X233](refusals/X233.md)] (RFC 0022)
- A collection kept in MySQL holds no blob, is keyed by a field the engine can make a key for under its `keyType`,
  has a name MySQL keeps as a table apart from every other collection of its database once case is ignored, and
  has fields MySQL keeps as columns apart from each other once case is ignored. [[X241](refusals/X241.md),
  [X242](refusals/X242.md), [X243](refusals/X243.md)] (RFC 0022)
- The blob registry is kept over a connection a plugin of the project offers a blob store for.
  [[C014](refusals/C014.md)] (RFC 0005)
- A graph, a binding or a store names under `reads` each read it takes from the context, and no other.
  [[G003](refusals/G003.md), [P004](refusals/P004.md), [P005](refusals/P005.md), [P006](refusals/P006.md)]
  (RFC 0029)
- At most one profile is the default, a stand-in is a connection of the same kind or, for a broker alone, one that
  delivers as it does, every declared secret is read, and a startup step names only declared profiles.
  [[C017](refusals/C017.md), [C018](refusals/C018.md), [C019](refusals/C019.md), [B012](refusals/B012.md)]
  (RFC 0013)
- A profile that writes `permits` reaches nothing they do not permit, and they permit nothing it does not reach and
  nothing that is never an effect. [[C021](refusals/C021.md), [C022](refusals/C022.md), [C023](refusals/C023.md)]
  (RFC 0016)
- A `retry` is written only over a call that reaches an effect and is idempotent where it is made, an atomic graph's
  transactional effects excepted, since a failed try rolls them back; its `when` is a boolean over what one try
  answers, and a domain graph writes no `retry` or `timeoutMs`. [[G017](refusals/G017.md), [G018](refusals/G018.md),
  [G019](refusals/G019.md), [L012](refusals/L012.md)] (RFC 0011)
- An operation that promises `idempotent` keeps the promise under every profile, at every effect it reaches; what a
  port says about repeating an operation is one sound fact; and a trigger fed by a broker that delivers at least once
  fires only an operation that promises it. [[B011](refusals/B011.md), [C015](refusals/C015.md),
  [T009](refusals/T009.md)] (RFC 0011)
- An atomic graph reaches, under every profile that runs it, only effects that take part in its transaction, on one
  connection, and at least one; it collects no failed element and nothing below it retries; and a transactional
  operation takes its connection or store as a static input. [[L009](refusals/L009.md), [L010](refusals/L010.md),
  [L011](refusals/L011.md), [G014](refusals/G014.md), [G020](refusals/G020.md), [C009](refusals/C009.md)] (RFC 0004)

## Enforced by the runtime

- The guard verifies a credential before any graph runs, on every fire of a trigger that attaches a policy, and
  its refusal ends the run as `identify` with no policy and no graph run. (`gate` in
  `packages/runtime/src/gate.ts`, run by `Embedder` in `packages/runtime/src/embed.ts`; `Guard` in
  `packages/core/src/plugin.ts`; before the RFCs)
- The stubbed gates never call the guard: `rehearse`, `fuzz`, `regress` and `run --seed` prove nothing about
  identity. (`gate` in `packages/runtime/src/gate.ts`; `Embedder.stubbed` in `packages/runtime/src/embed.ts`, set
  by `embedderFor` in `packages/runtime/src/stubbing.ts` for every run given a seed; before the RFCs)
- What the guard learned reaches a graph as `context.principal`, `context.session` and `context.challenge` and by
  no other path, and it is what the credential established, never the token or the code itself. (`identifies` in
  `packages/runtime/src/gate.ts`; `guard` in `packages/plugin-auth/src/guard.ts`; before the RFCs)
- A field marked `secret` is `«secret»` in every report's `in` and `out`, to a depth of six levels inside a type,
  a list counting as one, whichever node reads it (a call, a switch, a map and each of its elements, an
  invariant's guard, a graph that takes its input whole, a nested run, a node seeded in a replay), in a trigger's
  context where its kind marks it (an http request's headers and cookies, a queue message's headers)
  and in every input filled from such a field, in a policy's decision, and in what the schedule log and
  `wilanis fuzz` record of a run's answer; a value made from a marked read carries the mark whatever type it is
  read into, so text that interpolates one (`Bearer {{in.token}}`) is `«secret»` whole, and a node's answer is
  `«secret»` wherever it holds a value the node read as `«secret»` (a `@std/object.port.json#make` typed
  `string` of `{{in.password}}`), in its own report and in every read of it; a node whose operation is `pure`
  answers a function of its inputs alone, so where it read a value as `«secret»` and its answer holds nothing it
  read so (a `@std/text.port.json#join` or `#fill` of it, a `@std/list.port.json#count` of a list with a marked
  field), its answer is `«secret»` whole, and where the answer holds one, that part is `«secret»` and the rest is
  shown (a `make` of `{ name, password }` shows `name`); nothing a handler later does to a value puts anything at a
  marked position of a report; its bounds are that an operation that is not `pure` and turns a secret into another
  value (the response to an http call made with a secret header) answers something its node never read, so its
  answer is shown by the operation's own marks alone, that where a pure node's answer holds a value it read as
  `«secret»` the rest of that answer is shown as it is, and that a node seeded through the engine API, as a
  replay seeds one, carries the marks of what it reads only where that was seeded too, and as a call of a graph
  runs no nested run to carry a mark only the graph's own nodes make. (`packages/engine/src/redact.ts`, applied in
  `packages/engine/src/run.ts`, `packages/engine/src/map.ts` and `packages/engine/src/seeds.ts`; a node's `pure`
  lowered by `lowerNode` and `delegateCall` in `packages/compiler/src/compiler.ts`; `redactOf` in
  `packages/compiler/src/guard-lowering.ts`; `shownRoots` in `packages/runtime/src/shown.ts`;
  `packages/plugin-schedule/src/fire.ts`, `packages/runtime/src/fuzz.ts`; `secretPaths` and `SECRET_DEPTH` in
  `packages/core/src/secret.ts`; before the RFCs)
- A `{{secrets.*}}` read is substituted into plugin settings, connection settings and a startup step's `in`, and
  nowhere else; settings reach no report, and a step's `in` is `«secret»` in its reports wherever it reads a
  secret, whole or inside text, or its operation marks the field `secret`. (`Secrets` in
  `packages/compiler/src/env.ts`; `Embedder.startup` in `packages/runtime/src/embed.ts`, `shownStep` in
  `packages/runtime/src/shown.ts`; before the RFCs)
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
- A run's trace carries status, timing and what ran, and never a value but the caller's correlation id, copied
  opaquely, at level `summary`; `full` adds the report's `in` and `out`, already redacted, and each node's message
  as written; a refusal's `detail` enters neither. (`packages/runtime/src/trace.ts`, `valued` in
  `packages/runtime/src/trace-span.ts`, `correlationOf` in `packages/runtime/src/fired.ts`; RFC 0006)
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
