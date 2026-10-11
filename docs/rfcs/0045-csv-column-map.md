# RFC 0045: `columns`: a CSV header name read into a field of another name

- **Status:** draft
- **Areas:** `area:plugin-blob` (`csv.port.json`, the two CSV handlers, a first `check` with two X rules). Nothing in
  core, the compiler, the runtime or the viewer.
- **Tracking issue:** #853
- **Depends on:** none

## Summary

`@blob/csv.port.json#parse` and `#write` each accept one more input, `columns`: an optional, static map from a
header name, as the file writes it, to a field of the row shape. With it, a tree reads a CSV whose header says
`average-revs` into a shape whose field is `averageRevs`, and writes the file back with the same header. A column
the map does not name is read and written by its own name, as today. The input is typed with what a contract can
already say (an object open to strings, marked `static`), so the compiler already judges that it is a literal
(P001) and that its values are strings (G004). Two new rules in `@blob`'s own `check` judge what only the plugin
understands: each value names a field of the shape (X5n1), and each field has one column (X5n2). No schema under
`packages/core/schemas/` changes. No codec changes either, because no codec decodes CSV into rows.

## Motivation

**What an author cannot write today.** `#parse` matches each header name to a field of `type` by exact name.
`rowOf` in `packages/plugin-blob/src/index.ts` looks up `type.fields[name]` for each header cell. A field name
is an identifier: `fields` in `common.schema.json` takes its `propertyNames` from `ident`,
`^[a-z][A-Za-z0-9_]*$`, and a shape with a field `"average-revs"` is refused at load (D001). So a CSV whose header
holds a name that is not an identifier cannot be read into a closed shape. `conforms` in
`packages/core/src/values.ts` refuses the extra key as `not a declared field`, and the node fails on the first
row.

**Who met it.** A consumer tree reads the output of code-maat, a tool that measures how files change together.
Its coupling analysis writes the header `entity,coupled,degree,average-revs`. The tree's row shape,
`CoupledPair.shape.json`, names the last field `averageRevs`, a number, and `change-coupling.graph.json` reads the
file with `@blob/csv.port.json#parse` (consumer `GAPS.md`, entry M4).

**What it does instead.** The plugin that runs code-maat rewrites the header before the tree sees the file:
`header` in `plugins/scan-codemaat/src/index.ts` turns every `-x` in the first line into `X`. That works only
because a plugin of the consumer's own produces the file. It also changes the evidence. The consumer's `runTool`
(`plugins/tooling/src/tool.ts`) keeps the transformed text as the run's `raw` blob, so the file the tree keeps is
not the file code-maat wrote.

A file that a person uploads has no plugin before it. The example's `POST /customers.csv` streams the body
straight into the blob registry (`import-customers.trigger.json`, `"body": "blob"`), and `parse-drafts.graph.json`
parses it. If a spreadsheet writes `E-mail address` where the shape says `email`, the tree has no place to say so.

**The partial way today, and why it does not close the need.** An open shape takes the column as an extra key,
and a graph reads it as `{{row['average-revs']}}`. But `cell` in `index.ts` coerces a cell only for a declared
field, so the value stays text. No standard operation turns text into a number: `@std/text` has `fill`, `join`,
`split` and `replace` only (`packages/runtime/docs/std/text.port.json`). A number field cannot be filled from it.

**What earlier RFCs said.** No RFC specifies `@blob`. The plugin came before the RFC process. RFC 0011 marked
`#parse` idempotent, and RFC 0012 made it stop between rows when a run is cancelled. Neither discusses header
names, and no RFC set this question aside.

**What this does not try to solve.** It does not allow a field name that is not an identifier. It does not let a
read choose its columns at run time. It does not drop or select columns: a column the shape does not declare still
fails a closed shape, as today. It does not change how cells are coerced, how quotes are read, or any other CSV
dialect question (a separator other than a comma, a file with no header). It adds no CSV codec.

## Guide-level explanation

**Words.** A *header name* is the text of one cell of a CSV file's first line. A *column* is everything under one
header name. `columns` is a map. Each key is a header name, exactly as the file writes it. Each value is the field
of the row shape that the column is read into (`#parse`) or written from (`#write`). A column the map does not
name keeps today's rule: it is read into the field of its own name.

**Reading a file whose header is not the shape's.** Say the example's upload comes from a mail tool that writes
`Full name,E-mail address,tier`. `CustomerDraft.shape.json` keeps its fields `name`, `email` and `tier`.
`parse-drafts.graph.json` says how the header maps to them:

```json
{
  "type": "@wilanis/node/run.schema.json",
  "id": "drafts",
  "label": "Read the rows",
  "run": "@blob/csv.port.json#parse",
  "in": {
    "file": "{{in}}",
    "type": "@customers/domain/CustomerDraft.shape.json",
    "columns": {
      "Full name": "name",
      "E-mail address": "email"
    }
  }
}
```

The column `tier` is not in the map, so it is read into `tier` by its own name. Each row is judged against
`CustomerDraft` as today, and the node answers `CustomerDraft[]`. Nothing downstream knows the file's header was
different. The consumer's coupling read is the same with one entry: `"columns": { "average-revs": "averageRevs" }`.
Its `degree` and `averageRevs` are declared numbers, so both are coerced from text, and the `header` rewrite in
its plugin can go.

**Writing a file with the same header.** `#write` reads the same map the other way: field `email` is written under
the header `E-mail address`. The columns keep the shape's field order, as today. So one map, written on both
calls, reads a file and writes it back with the header it came with:

```json
{
  "type": "@wilanis/node/run.schema.json",
  "id": "file",
  "label": "Write the file",
  "run": "@blob/csv.port.json#write",
  "in": {
    "rows": "{{in}}",
    "type": "@customers/domain/Customer.shape.json",
    "columns": { "E-mail address": "email" },
    "filename": "customers.csv"
  }
}
```

**What the checker says.** The map is static, so the checker reads it before anything runs. A value that is not a
field of the shape is X5n1:

```
X5n1  @features/customers/data/parse-drafts.graph.json#nodes/drafts/in/columns/E-mail address
    columns reads 'E-mail address' into 'mail', which is not a field of @customers/domain/CustomerDraft.shape.json (fields: name, email, tier)
    → map the column to one of those fields, or add the field to the shape
```

Two headers that land on one field, or a header that is already another field's own name, is X5n2:

```
X5n2  @features/customers/data/parse-drafts.graph.json#nodes/drafts/in/columns/Mail
    columns reads 'E-mail address' and 'Mail' both into 'email', and a field is one column
    → keep one of the two
```

```
X5n2  @features/customers/data/parse-drafts.graph.json#nodes/drafts/in/columns/name
    columns reads the column 'name' into 'email', and 'name' is also the column of the field 'name'
    → give 'name' a column of its own too ("Full name": "name"), or map another header to 'email'
```

The compiler already judges the rest. A read where the map belongs (`"columns": "{{in.filename}}"`) is P001, and a
value that is not a string (`"E-mail address": 3`) is G004. I checked both on the example, with the input added to
`csv.port.json` by hand: the checker refuses each with today's code, and accepts the map above with no refusal.

## Reference

### Documents and schemas

None. No schema under `packages/core/schemas/` changes, no `*Doc` interface, no `HOME` entry, no row in
`packages/runtime/templates/CLAUDE.md`, no scaffold. The `decision` job does not wait on this change.

### Ports, operations and kinds granted

`packages/plugin-blob/docs/csv.port.json`. Both `parse` and `write` gain one accepted field, after `type`:

```json
"columns": {
  "type": { "fields": {}, "open": "string" },
  "required": false,
  "static": true,
  "description": "header names that are not the field's own name: each key is a header name as the file writes it, each value the field of `type` its column is read into (parse) or written from (write). A column the map does not name is read and written by its own name. Absent: every column by its own name."
}
```

The type is the one `@http/http.port.json#request` gives `headers`: an object of string values whose keys are any
text. A key that is not an identifier is legal in a literal, as `"x-forwarded-user-agent"` is in
`create-row.graph.json`. `returns` does not change: `#parse` still answers `$T[]`, rows keyed by field names.

The two descriptions change to say it. `parse`: "The header row names the columns; `columns` maps a header name to
the field it is read into, and every other column is read into the field of its own name." `write`: "a header row
of the shape's fields in declared order, each under the header name `columns` maps to it, else under its own
name."

### Checker rules

Numbers are assigned when the implementing pull request lands. `@blob` has no X codes today. The bands are
`@http` X0xx, `@auth` X1xx, `@storage` X2xx (with `@schedule` from X251), `@otel` X3xx and `@queue` X4xx
(`docs/refusals/README.md`, *The families*). I propose X5xx for `@blob`, the next free band.

Both rules live in a new `packages/plugin-blob/src/rules.ts`, exported as the plugin's `check`. They judge every
call site of `#parse` and `#write`: each `run` or `map` node of every graph, and each operation of every binding,
whose `run` names one of the two operations. The walk is the one `graphCalls` and `bindingCalls` make in
`packages/plugin-storage/src/calls.ts`. `@blob` writes its own, about thirty lines, because a plugin imports no
other plugin that is not a contract it implements. Each rule reads the shape the call's `type` names through
`scope.types.spec`. Where it does not resolve, or `columns` is absent or not an object, the rule says nothing:
R001, P001 and G004 speak there.

| Code | Where it lives | Refuses when | Hint |
|---|---|---|---|
| X5n1 | `packages/plugin-blob/src/rules.ts` | a value of `columns` is not a field the shape of `type` declares. An open shape is no exception: the map reads into declared fields, which are the ones a cell is coerced for. `at` is `<call>/in/columns/<header name>`. | `map the column to one of those fields, or add the field to the shape` |
| X5n2 | `packages/plugin-blob/src/rules.ts` | two fields of the shape would share one column. The column of a field is the header name that `columns` maps to it, else the field's own name. So: two keys map to one field, or a key that is the name of another field maps elsewhere while no key maps to that field. `at` is `<call>/in/columns/<header name>` of the later key. | `keep one of the two`, or `give '<field>' a column of its own too, or map another header to '<field>'` |

**A header named twice in the map.** The checker cannot see it. The loader reads a document with `JSON.parse`
(`packages/core/src/documents.ts`), which keeps the last of two equal keys and says nothing. So X5n2 judges what
the parsed map can show: one field named twice, and one header standing for two fields.

**Why X5n2 is a rule and not a run-time failure.** The second form is a sure bug. Under `{"name": "email"}`,
`#parse` reads the column `name` into `email`, and no column is ever read into `name`, so every row fails if `name`
is required. `#write` writes two columns both headed `name`. The checker sees all of this from the map and the
shape alone.

### Runtime behaviour

Only the two handlers in `packages/plugin-blob/src/index.ts` change.

- **`#parse`.** `RowReader` is given the map. When it reads the header line, it replaces each trimmed header cell
  that is a key of `columns` with the key's value. `rowOf` then reads each cell into the field of that name, exactly
  as it does today. Coercion, absent optional cells, the blank-line rule, the row's line number in a failure and the
  stop between rows when the signal aborts do not change.
- **A header that names one field twice.** If two cells of the header line land on one name after the map, the node
  fails at the header: `csv header: columns 'average-revs' and 'averageRevs' are both read into 'averageRevs'`.
  Today, a header that repeats a name keeps the last cell of the two and drops the other without a word. This RFC
  proposes that a repeated header fails whether or not `columns` is given (*Open questions*, 2).
- **`#write`.** `lines` writes the header row through the inverse map: field `f` under the key whose value is `f`,
  else under `f`. The order is the shape's field order, as `columnsOf` gives it today. The values of each row are
  read by field name, as today. X5n1 and X5n2 make the inverse map one to one.
- **`rehearse`, `fuzz`, `regress`.** Nothing changes. `#parse` and `#write` are effects and are stubbed. A stub of
  `#parse` is a value of `$T[]`, keyed by field names, which the map does not change.

### Discoverability

- `wilanis describe @blob/csv.port.json` prints the new input under both operations from the port document, as it
  prints every accepted field. For `headers` it prints `headers?: {, ...}`, and it will print `columns` the same
  way. That rendering of an object open to strings is `show` in `packages/core/src/types.ts`, and this RFC does
  not change it.
- The viewer's port page reads the same document. Nothing changes in `client/index.html`.
- `docs/refusals/X5n1.md` and `X5n2.md`, from the page template. Their rows go in the index of
  `docs/refusals/README.md`, and `@blob` X5xx joins the band list under *The families*.
- The plugin's `README.md` says what `columns` does, on the line for `#parse` and `#write`.

### Plugin contract

None. `@blob` starts to use `check`, which `PluginModule` in `packages/core/src/plugin.ts` already offers.

## Compatibility

No schema changes, and IR v1 is untouched. A document written before this RFC gives no `columns`, so it validates
and keeps its meaning: every column is read and written by its own name. The one change in meaning is the repeated
header line under *Runtime behaviour*. A CSV whose header repeats a name was read before, keeping the last of the
two cells. It now fails the node, if the maintainer accepts that point. After 1.0, adding an optional input to a
port a plugin grants is a compatible change.

## Tests

**The rules.** A new `packages/plugin-blob/test/rules.test.ts` over a small tree of its own, built as
`packages/plugin-queue/test/tree.ts` builds one. The tree is one feature, a row shape with a number field, and a
data graph that parses a CSV and writes one, both with a `columns` map. The test package adds
`@wilanis/compiler` to its `devDependencies`, beside `@wilanis/runtime`, as `@wilanis/plugin-queue` does. A plugin's
X rules are proved in its own tests, as `@queue`'s are in `packages/plugin-queue/test/rules.test.ts`.

| Case | Edit | Expects |
|---|---|---|
| the tree stands | none | no refusal |
| X5n1 | `"columns": { "average-revs": "averageRevz" }` on the parse | X5n1 at `nodes/<id>/in/columns/average-revs`, naming the shape's fields |
| X5n1 on write | the same map on the write node | X5n1 at the write node |
| X5n1 in a binding | the parse run from a binding operation instead of a graph node | X5n1 at `operations/<name>/in/columns/average-revs` |
| X5n2, two headers | `{ "average-revs": "averageRevs", "avg": "averageRevs" }` | X5n2 at `.../columns/avg` |
| X5n2, a field's own name | `{ "degree": "averageRevs" }` | X5n2 at `.../columns/degree` |
| not X5n2, a swap | `{ "degree": "averageRevs", "averageRevs": "degree" }` | no refusal |
| not X5n2, identity | `{ "degree": "degree" }` | no refusal |
| left to the compiler | `"columns": "{{in.name}}"`; `{ "average-revs": 3 }` | P001; G004; no X5n1 or X5n2 |

**The handlers.** `packages/plugin-blob/test/blob.test.ts`, beside today's parse and write cases:

- a file headed `url,method,hit-count` with `columns: { "hit-count": "hits" }` reads `hits` as a number;
- an unmapped column is read by its own name, mapped and unmapped mixed in one header;
- a key no header writes changes nothing, and a required field it was meant for fails the first row as today;
- `#write` with the map writes `url,method,hit-count,ok`, and a parse of that blob with the same map gives the rows
  back unchanged;
- a header whose cells land on one field after the map fails at the header line; so does `a,a` with no map, if
  *Open questions* 2 is accepted.

## Implementation plan

1. **The input and the handlers** (`area:plugin-blob`, `good first issue`). `columns` on `#parse` and `#write` in
   `csv.port.json`, with the new descriptions; `RowReader`, `lines` and `columnsOf` in `src/index.ts`; the handler
   tests above; the line in the plugin's `README.md`.
2. **X5n1 and X5n2** (`area:plugin-blob`). `src/rules.ts` and `check` on the plugin; `test/rules.test.ts` and its
   small tree; `docs/refusals/X5n1.md` and `X5n2.md`; their rows and the `@blob` band in
   `docs/refusals/README.md`. Needs step 1, since the rules judge an input the port must accept first.

The consumer then drops `header` from `plugins/scan-codemaat/src/index.ts` and writes
`"columns": { "average-revs": "averageRevs" }` on its parse. That edit is in the consumer's repository, not here.

## Drawbacks and alternatives

**Cost.** One more input on two operations, two rules and their pages, and a first `check` in `@blob`. A reader of
a parse now looks in two places to know which field a column fills: the shape and the map.

**Do nothing; teach the workaround.** Rewrite the header before the tree reads the file. This works only where a
plugin produces the file, and there it changes the file the tree keeps (the consumer's `raw`). A file a person
uploads goes straight into the registry, with no code before `#parse` that could rewrite it. A tree would need a
plugin of its own for every such file.

**An open shape and a bracket read.** `{{row['average-revs']}}` reads the column today, but as text. Nothing in the
standard library turns text into a number, so a declared number field cannot be filled from it.

**Field names that are not identifiers.** Loosen `ident` for shape fields. This changes a core schema and every
reader of a field name: `{{row.average-revs}}` in a template, a switch rule where `-` is subtraction, a column name
in a storage engine's table. It is far wider than one file's header.

**The header on the shape.** A per-field `column` name in the shape document. This is a core schema change too, and
it puts one file format's spelling into a shape that other ports also read. A shape is the domain's. A header is one
file's, so it belongs where the file is read.

**A map that a read gives at run time.** A dynamic `columns` would let one graph read files of several headers. The
checker could no longer judge it, and no consumer has asked for it. Static matches `type`, which is static too.

**A rename after the parse.** An `@std/object` operation that renames keys, run on the rows. It comes too late: the
parse fails a closed shape on the unknown column before the rename runs, and only the parse coerces cells.

**A CSV codec.** The question was whether a codec needs the same map. No codec decodes CSV into rows. A route maps
`text/csv` to `@http/codecs/blob.codec.json` (`example/project.json`), the body is a handle, and a data graph reads
it with `#parse`. A codec document has only `yields` (`codec.schema.json`), so a codec has no per-call input where a
map could go. If a rows codec is proposed one day, it should take its row shape and its map from the trigger, and
that is its own RFC.

## Open questions

To decide before `accepted`:

1. **The band.** X5xx for `@blob`, as the next free hundred. Recommended.
2. **A repeated header line fails, map or no map.** Today `a,a` keeps the last cell and drops the other without a
   word. With a map, two cells can land on one field in a new way (`average-revs,averageRevs` under
   `{"average-revs": "averageRevs"}`). I recommend failing at the header in both cases: one rule, and the silent
   loss stops. The alternative is to fail only where the map caused the collision and keep today's behaviour for a
   plain repeat. That changes nothing for an existing tree, at the cost of two behaviours for one shape of fault.
3. **`#write` takes the map too.** Recommended: one map, the same on both calls, gives a file back with the header
   it came with, and the cost is the inverse in `lines`. The consumer only reads. If the maintainer prefers the
   smallest change, `#write` can wait for a tree that writes such a header.

May be decided during implementation:

- Whether a key with spaces around it is trimmed before it is compared. Header cells are trimmed today, so such a
  key never matches. Trimming the key too, or refusing it in X5n1, are both small.
