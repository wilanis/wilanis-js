# Refusals

When the checker will not accept a tree it answers with refusals: a `Refusal` with a `code`, the `file` it is about,
where in that file (`at`), what is wrong (`message`) and the direction of the fix (`hint`). A code is a family letter
and three digits, and each code has a page here, `<CODE>.md`, that says in full what its rule refuses, shows one
refusal as `wilanis check` prints it, and says how to repair it. A diagnostic's `url` points at the page
(`pageUrl` in `packages/core/src/published.ts`). This is a checker refusal; a run's refusal, a graph deciding
`missing` on purpose, is RFC 0014's and has no page.

The pages are written by hand, from the code that makes the refusal, its message and hint, and the sabotage test
that proves it (RFC 0019). This file is the one inventory of codes.

## The promise

From 1.0, when the `schemas-v1` tag is cut (RFC 0008), a reader of a refusal, or of the envelope `wilanis check
--json` prints, may rely on the following.

- A code names one rule. A rule that changes what it is about gets a new code; the old one is retired, its page
  stays with the status `retired`, and its number is never used again. A skipped number that nothing ever shipped
  under has no page and is no promise.
- `at` has one grammar: a path from the document's root, segments joined by `/`, an object member by its name, an
  array element by its index, and a graph's node by its `id` (`nodes/fetched/in`, `nodes/outcome/rules/0/when`), so
  that reordering nodes moves no `at`. An absent `at` means the refusal is about the file as a whole.
- A fix, where a refusal carries `fixes`, has one of four verbs, `set`, `add` and `remove` a value at a path of a
  document, or `move` a file, and no verb is ever reinterpreted. `fixes` lists alternatives, each sufficient alone,
  the first preferred; a fix is offered only where the test suite proves that applying it to the sabotaged example
  removes the refusal and adds none.
- A field of the envelope is added, never removed or retyped, and its `format` says which envelope it is.

A reader may not rely on the wording of `message` or `hint`, on the envelope's `documents` count, or on an order of
refusals finer than the envelope's sort (by `file`, then `at`, then `code`, then `message`).

Before 1.0 nothing is promised. The pages record what changes until then under *History*, so that 1.0 ships with a
history rather than a clean slate.

## The families

| Family | What it judges |
|---|---|
| D | documents: parsing, schemas, placement, includes, what a plugin ships |
| R | references: a name that resolves to nothing |
| L | layers, effects and visibility |
| G | graphs: edges, types, routing, cycles, what is unused, retries and catches |
| P | static fields and resolvers |
| B | bindings, profiles and startup |
| T | triggers |
| A | access: policies, credentials and scopes |
| I | invariants |
| C | connections, settings and stores |
| S | scenarios |
| X | what a plugin of this workspace judges in its own `check`, numbered by plugin: `@http` X0xx, `@auth` X1xx, `@storage` X2xx (`@storage-postgres` X22x, `@schedule` from X251), `@otel` X3xx |

Numbers with no page: no rule makes D002, G002 or L004, and nothing shipped under them. L004 refused a graph both
fired by a trigger and bound by a binding until the directory became the layer, before the first release. X104 is a
hole: the session-write rule shipped as X103, and a rule briefly numbered X104 before release took X106 so the
miscitations of X104 could not gain a meaning. X205 and X206 were never used.

## Index

| Code | Family | Status | Refuses |
|---|---|---|---|
| [D000](D000.md) | D | live | a file the loader reads, the tree's or a plugin's, does not parse as JSON |
| [D001](D001.md) | D | live | a document is not an object, names no wilanis kind in `$schema`, or breaks its kind's schema |
| [D003](D003.md) | D | live | a project or feature document outside its one place, or a root `project.json` of another kind |
| [D004](D004.md) | D | live | a plugin, trigger-kind, connection-kind or codec document authored in a tree |
| [D005](D005.md) | D | live | no `project.json` at the root of the tree being loaded |
| [D006](D006.md) | D | live | a plugin the project names that is unknown, not a package, not installed, or not the plugin it claims |
| [D007](D007.md) | D | live | an alias colliding with a plugin root, a reserved root, a folder, or an include's alias |
| [D008](D008.md) | D | live | a document outside the layer or directory its kind lives in, or a shape whose `layer` disagrees |
| [D009](D009.md) | D | live | a feature both in this tree and in an include |
| [D010](D010.md) | D | live | an include that is not found or not a tree, lacks a feature asked for, or uses a plugin the host lacks |
| [D011](D011.md) | D | live | a plugin port's `resolves` on a non-static input, or keyed by an input that is missing or not static |
| [D012](D012.md) | D | live | a plugin that both grants and requires a port, or requires one it does not ship |
| [R001](R001.md) | R | live | a reference to a port, operation, shape, policy or other document the tree does not have |
| [L001](L001.md) | L | live | a type naming a type variable, or `unknown` in core, or a shape of the other layer |
| [L002](L002.md) | L | live | a domain graph reaching an effect or the request, or a data graph running a domain operation |
| [L003](L003.md) | L | live | a data graph or binding reaching an effect its feature's `effects` does not list |
| [L005](L005.md) | L | live | a document naming another feature's document without `dependsOn`, or one that feature does not export |
| [L006](L006.md) | L | live | a trigger or policy firing a native operation, or a domain operation marking a field `static` |
| [L007](L007.md) | L | live | a domain graph that only forwards its input to one operation, or a binding outside a feature |
| [L008](L008.md) | L | live | a graph running an operation marked `holds`, which only a startup step may name |
| [L009](L009.md) | L | live | an atomic graph reaching an effect that cannot take part in a transaction |
| [L010](L010.md) | L | live | an atomic graph reaching transactional effects on more than one connection |
| [L011](L011.md) | L | live | an atomic graph reaching nothing that could roll back |
| [L012](L012.md) | L | live | a domain graph's node declaring `retry` or `timeoutMs` |
| [L013](L013.md) | L | live | a domain graph's switch declaring `catch` |
| [G001](G001.md) | G | live | a node id another node of the graph has, or one of the reserved roots in, const, request, secrets |
| [G003](G003.md) | G | live | a read that cannot be typed: no such field, constant, earlier node, or name under reads |
| [G004](G004.md) | G | live | a value that does not fit its input: optional where the contract requires it, or of the wrong type |
| [G005](G005.md) | G | live | a required input of the operation left out of a node's or a delegation's in |
| [G006](G006.md) | G | live | a value given under in that is no input of the operation, or a map's item or bound name given again |
| [G007](G007.md) | G | live | a cycle through what nodes read and how switches route |
| [G008](G008.md) | G | live | a field of in, a constant or a node that nothing reads |
| [G009](G009.md) | G | live | a switch routing to an unknown node, to itself, or to a node another switch routes |
| [G010](G010.md) | G | live | out.from naming no node, an unknown node or a switch, a candidate of the wrong type, or one never routed |
| [G011](G011.md) | G | live | a switch rule whose when does not parse, does not type, or is not boolean |
| [G012](G012.md) | G | live | a map over something that is not a list, or a bind path the element does not hold |
| [G013](G013.md) | G | live | a constant whose value does not conform to its declared type |
| [G014](G014.md) | G | live | a collecting map inside an atomic graph, or a graph one reaches, whose transaction a failed element ends |
| [G015](G015.md) | G | live | an effect no switch routes whose answer only some branches read, so it runs on the rest for nothing |
| [G016](G016.md) | G | live | a refusal's message that reads a field marked secret |
| [G017](G017.md) | G | live | a retry over a pure operation, or over a binding whose graph reaches no effect |
| [G018](G018.md) | G | live | a retry over a call that is not idempotent where it is made, since a failed call may have been applied |
| [G019](G019.md) | G | live | a retry.when that is not boolean over the answer's fields, or over an answer that is not an object |
| [G020](G020.md) | G | live | a retry on a node or binding operation below an atomic graph, inside its transaction |
| [G021](G021.md) | G | live | a catch naming a node the switch does not read or another switch catches, or routing to no other node |
| [G022](G022.md) | G | live | a reader of a caught node that does not run behind the catching switch |
| [G023](G023.md) | G | live | a read of the node that broke, where its fault is routed or behind it |
| [G024](G024.md) | G | live | a catch of a switch, a pure operation or one that refuses on purpose, which break only by a bug |
| [G025](G025.md) | G | live | a catch of a node where an invariant is guarded, which the guard moves aside |
| [P001](P001.md) | P | live | a static field, or a type reference, given a read where the checker must see a literal |
| [P002](P002.md) | P | live | a resolver reading a request.* path no trigger kind hands and the guard does not add |
| [P003](P003.md) | P | live | a resolver named in, const, request or secrets |
| [P004](P004.md) | P | live | a `reads` entry naming no resolver of the document it names, or not a resolver reference at all |
| [P005](P005.md) | P | live | a `reads` entry no value of the document reads, and on a store one no `scoped` column reads |
| [P006](P006.md) | P | live | a `reads` name that is a root, or the id of a node of the graph |
| [B001](B001.md) | B | live | a binding leaves an operation of its port unbound, or binds one the port does not declare |
| [B002](B002.md) | B | live | a domain port has no binding, several unchosen, or a missing one under a profile |
| [B003](B003.md) | B | live | a binding or a profile binds a native port, which its plugin binds |
| [B004](B004.md) | B | live | a profile chooses a binding that implements another port |
| [B005](B005.md) | B | live | what a bound operation accepts or returns does not fit the graph or delegation meeting it |
| [B006](B006.md) | B | live | a startup step names no operation, or a native one that does not hold |
| [B007](B007.md) | B | live | a startup step's input reads more than literals and declared secrets, or misfits the operation |
| [B008](B008.md) | B | live | a startup step reaches, under a profile, a document that reads the request |
| [B009](B009.md) | B | live | a binding of a port a plugin requires declares reads or reaches a read of the request |
| [B010](B010.md) | B | live | a binding of a port a plugin requires reaches a refuse or something that holds past the run |
| [B011](B011.md) | B | live | a domain operation promising idempotent reaches, under a profile, an effect that is not |
| [T001](T001.md) | T | live | a trigger's settings that do not fit its kind's, or a type setting not written as a shape path |
| [T002](T002.md) | T | live | a trigger's in or out that does not meet the contract of the domain operation it fires |
| [T003](T003.md) | T | live | a trigger's fire.in that reads outside what its kind hands, or does not fit the trigger's in |
| [T004](T004.md) | T | live | a resolver read, under a trigger, of a request.* path the trigger's kind does not hand |
| [T005](T005.md) | T | live | a refusal reason the trigger can reach, its policies' and the guard's included, that it does not map |
| [T006](T006.md) | T | live | a refusal reason the trigger maps that nothing it fires, gates on or identifies with refuses with |
| [T007](T007.md) | T | live | a trigger kind whose correlation names no field of its own context |
| [T008](T008.md) | T | live | a trigger with no policies whose edge shapes take a list with no maxItems |
| [A001](A001.md) | A | live | a policy's input that reads outside the request or does not fit its decision under the trigger's kind |
| [A002](A002.md) | A | live | a reason the decision reaches that outcomes does not map, a challenge without a method, a deny with one |
| [A003](A003.md) | A | live | a policy outcome that nothing its decision reaches refuses with |
| [A004](A004.md) | A | live | a credential the guard does not verify, read where the kind hands nothing, or yielding what no policy reads |
| [A005](A005.md) | A | live | a policy reading what the guard hands on a trigger that gives the guard no credential yielding it |
| [A006](A006.md) | A | live | a resolver read as required that the kind hands only sometimes and no policy of the trigger proves |
| [A007](A007.md) | A | live | a store scoped by a read the guard does not hand, or scoped at all where no plugin identifies callers |
| [A008](A008.md) | A | live | a trigger reaching a store's view that does not attach the policy the view is behind |
| [I001](I001.md) | I | live | a trigger reaching an operation an access invariant covers without the policy or proof it requires |
| [I002](I002.md) | I | live | an invariant naming a native operation, a path no guard hands, or a shape that is not core |
| [I003](I003.md) | I | live | an invariant nothing reaches: no trigger reaches its `over`, or no graph makes or takes its shape |
| [I004](I004.md) | I | live | a `holds.when` that does not parse, does not type against the shape's fields, or is not boolean |
| [I005](I005.md) | I | live | a value written in literals that contradicts a field invariant where it is made |
| [I006](I006.md) | I | live | a refusal whose reason is `invariant`, the word the compiler's guards refuse with |
| [C001](C001.md) | C | live | settings that read anything but one declared `{{secrets.<key>}}` |
| [C002](C002.md) | C | live | a connection's or a plugin's settings that do not fit the type its kind or manifest declares |
| [C003](C003.md) | C | live | a store constraint (`unique`, `refs`, `defaults`) naming a field the collection's shape does not have |
| [C004](C004.md) | C | live | a default the field's type would not accept, or a default on the key |
| [C005](C005.md) | C | live | a reference to a collection this store does not keep: absent, or a view |
| [C006](C006.md) | C | live | a reference whose field's type is not the type of the key it refers to |
| [C007](C007.md) | C | live | a `unique` or `refs` entry naming the collection's key, which is unique and identifies already |
| [C008](C008.md) | C | live | a constraint over a blob, shape or list field, which no engine holds one value of |
| [C009](C009.md) | C | live | a transactional operation that accepts no static `connection` or `store` to resolve one from |
| [C010](C010.md) | C | live | a `renamed` entry that describes no rename: unknown field, old name still a field, or one name twice |
| [C011](C011.md) | C | live | a `was` naming the collection itself or a name another collection on the connection holds now |
| [C012](C012.md) | C | live | a `scoped` column not filled by exactly one required string-or-number read the store binds |
| [C013](C013.md) | C | live | a view that names no scoped collection of the same store |
| [C014](C014.md) | C | live | a `blobs.connection` that is no connection, or of a kind no named plugin offers a blob store for |
| [C015](C015.md) | C | live | an operation's `key`, `idempotent` and `pure` that do not make one sound fact about repeating it |
| [C016](C016.md) | C | live | a `maxItems` on a field that is not a list |
| [S001](S001.md) | S | live | a scenario naming a trigger the tree does not have |
| [S002](S002.md) | S | live | a scenario pinning a reason on a node whose status is not failed |
| [S003](S003.md) | S | live | a `cancelAt` that is not a key of the scenario's `stubs` |
| [X001](X001.md) | X | live | the @http codec table names something that is not a codec |
| [X002](X002.md) | X | live | a content type a route, graph or binding uses has no codec in the @http codec table |
| [X003](X003.md) | X | live | an http connection's throttle could never let a request through |
| [X004](X004.md) | X | live | a deadlineMs or maxBodyBytes that is not a whole number of 1 or more |
| [X101](X101.md) | X | live | the @auth settings.session names something that is not a shape |
| [X102](X102.md) | X | live | a challenge by a method the settings do not declare, or one no attachment of the trigger could answer |
| [X103](X103.md) | X | live | a session read or write whose type or keys fall outside the session shape |
| [X105](X105.md) | X | live | a session write of an attribute a store scopes a collection by, which only the sign-in writes |
| [X106](X106.md) | X | live | files.port.json keeps records in the tree's root, above it, or where the loader reads documents |
| [X201](X201.md) | X | live | a store's collection keeps an edge shape, not a core one |
| [X202](X202.md) | X | live | a collection's key is not a field of its shape, or is an optional one |
| [X203](X203.md) | X | live | a store's connection is of a kind that reaches no storage engine, or that no loaded plugin grants |
| [X204](X204.md) | X | live | a storage call names a store the tree does not hold, or a collection the store does not declare |
| [X207](X207.md) | X | live | two stores on one connection declare the same collection name with different shapes |
| [X208](X208.md) | X | live | a call's `where` or `order` names a field the collection's shape does not have |
| [X209](X209.md) | X | live | a value a `where` tests with is one the field would not accept |
| [X210](X210.md) | X | live | a `where` uses an operator the grammar does not name, or one the field's type does not admit |
| [X211](X211.md) | X | live | a patch changes the key, a field the shape lacks, or gives a value the field would not accept |
| [X212](X212.md) | X | live | `ensure` is run by a graph, or delegated to by a binding no startup step reaches |
| [X213](X213.md) | X | live | a graph or binding of one feature names another feature's store |
| [X214](X214.md) | X | live | a call site writes a `scope`, which only the store says and the compiler fills |
| [X221](X221.md) | X | live | a field of a collection kept in postgres that is a blob, which this engine has no column for |
| [X222](X222.md) | X | live | a postgres collection's key that is neither string nor number, or that the plugin's keyType cannot generate |
| [X223](X223.md) | X | live | a postgres collection name that is no legal table name, or folds to the same table as another's |
| [X251](X251.md) | X | live | a schedule that is not one: cron and everyMs both or neither, a bad cron, interval or zone, or a bad setting |
| [X252](X252.md) | X | live | a scheduled trigger declares `in` with no `fire.in`, and nothing arrives on a tick |
| [X253](X253.md) | X | live | `catchUp` is set while no scheduler run step names a lease |
| [X254](X254.md) | X | live | the scheduler run step's lease names no connection, or one whose kind keeps no leases |
| [X301](X301.md) | X | live | an @otel endpoint that is neither an http(s) URL nor a secret read, or a level that is not summary or full |

## The page template

Every page has this form, and `packages/runtime/test/refusal-pages.test.ts` holds it: the first heading is the
file's code, then the four header lines, then the four sections in this order.

````markdown
# L003

- **Family:** L -- layers, effects and visibility
- **Status:** live, since 0.1.0
- **Made in:** `packages/compiler/src/check/graph.ts`, `packages/compiler/src/check/bindings.ts`
- **Proved by:** `packages/runtime/test/sabotage.test.ts` (`L003 an effect the feature does not allow`);
  `packages/runtime/test/sabotage-fixes.test.ts` (`L003 offers the effect added to the feature, on every refusal, graph
  node and binding alike`, `L003 applying the first refusal’s fix leaves nothing refused`, `L003 applying all nine adds
  the effect once`)

## Refuses when

What the rule refuses, in sentences: what the holes of the message mean, and why the rule holds.

## Example

One refusal as `wilanis check` prints it, from the sabotage that proves the rule:

```
L003  @features/customers/data/get-row.graph.json#nodes/fetched
    node 'fetched' runs effectful '@http/http.port.json#request' which the feature does not allow
    → add "@http/http.port.json#request" to @features/customers/feature.json → effects
```

## Fix

The edit that repairs it, the fix the refusal offers where it offers one, and when the hint's edit is the wrong one.

## History

- 0.1.0: introduced.
````

*Status* is `live` or `retired`, with the version it took that status in. *Made in* names every source file that
makes the code; *Proved by* the test that breaks a tree and expects it, with the test's title. A retired page keeps
its sections and says under *History* when and why it was retired and which code took its place, if one did.
