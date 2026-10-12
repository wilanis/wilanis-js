# RFC 0045: `columns`: a CSV header name read into a field of another name

- **Status:** accepted
- **Areas:** `area:plugin-blob` (`csv.port.json` and the two CSV handlers). Nothing in core, the compiler, the
  runtime or the viewer, and no new checker rule.
- **Tracking issue:** #853
- **Depends on:** none

## Summary

`@blob/csv.port.json#parse` and `#write` each accept one more input, `columns`: an optional, static map from a
header name, as the file writes it, to a field of the row shape. With it, a tree reads a CSV whose header says
`average-revs` into a shape whose field is `averageRevs`, and writes the file back with the same header. A column
the map does not name is read and written by its own name, as today. The input is typed with what a contract can
already say (an object open to strings, marked `static`), so the compiler already judges that it is a literal
(P001) and that its values are strings (G004). The RFC adds no new rule. A map that names a field the shape does
not have, or that gives two fields one header, fails the node as a fault the first time it runs, with a message
that names the map entry. No schema under `packages/core/schemas/` changes. No codec changes either, because no
codec decodes CSV into rows.

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

**What a bad map does.** The compiler judges the map's form, because `columns` is typed and static. A read where
the map belongs (`"columns": "{{in.filename}}"`) is P001, and a value that is not a string (`"E-mail address": 3`)
is G004. I checked both on the example, with the input added to `csv.port.json` by hand: the checker refuses each
with today's code, and accepts the map above with no refusal.

What the map *means* against the shape is not a checker rule. The handler judges it when the node runs, before it
reads or writes a byte, and fails the node as a fault. A map value that is not a field of the shape:

```
csv columns: 'E-mail address' maps to 'mail', which is not a field of @customers/domain/CustomerDraft.shape.json (fields: name, email, tier)
```

Two fields that would share one header, because two keys name one field, or because a key is another field's own
name and no key maps to that field:

```
csv columns: 'E-mail address' and 'Mail' both map to 'email'
csv columns: 'name' maps to 'email', and 'name' is also the header of the field 'name'
```

`rehearse` and `fuzz` stub `#parse` and `#write`, so they do not find a bad map. A test or a `wilanis run` against
a real file finds it on the first call, whatever the file holds, because the handler judges the map before it
reads.

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

None. The compiler's P001 and G004 already judge the map's form (*What a bad map does*, above). What the map means
against the shape is judged by the handler when it runs (*Runtime behaviour*).

### Runtime behaviour

Only the two handlers in `packages/plugin-blob/src/index.ts` change.

- **The map, before anything is read or written.** Both handlers first compute the header of each field of the
  shape: the key that maps to it, else the field's own name. One function in `index.ts` does it for both
  operations. It throws, and so fails the node as a fault, where a value of `columns` is not a field the shape
  declares, or where two fields get one header. The messages are the ones under *What a bad map does*. The shape
  is named by the path `type` gives, and its fields are listed. An open shape is no exception: the map reads into
  declared fields, which are the ones a cell is coerced for. The fault is the same on every call, so a `retry` on
  the node only repeats it.
- **`#parse`.** `RowReader` is given the map. When it reads the header line, it replaces each trimmed header cell
  that is a key of `columns` with the key's value. `rowOf` then reads each cell into the field of that name, exactly
  as it does today. Coercion, absent optional cells, the blank-line rule, the row's line number in a failure and the
  stop between rows when the signal aborts do not change.
- **Two cells of the file's header that land on one field.** This RFC does not change it. Today, `a,a` keeps the
  last cell and drops the other without a word, and a header `average-revs,averageRevs` under
  `{"average-revs": "averageRevs"}` behaves the same way. Whether today's behaviour is a bug is a separate issue.
- **A key no header cell writes.** Nothing happens at the header. The field it maps to gets no column, so where that
  field is required each row fails as today: `csv does not fit <shape>: row 2.averageRevs: required`.
- **`#write`.** `lines` writes the header row from the headers computed above: field `f` under the key whose value is
  `f`, else under `f`. The order is the shape's field order, as `columnsOf` gives it today. The values of each row
  are read by field name, as today.
- **`rehearse`, `fuzz`, `regress`.** Nothing changes. `#parse` and `#write` are effects and are stubbed. A stub of
  `#parse` is a value of `$T[]`, keyed by field names, which the map does not change.

### Discoverability

- `wilanis describe @blob/csv.port.json` prints the new input under both operations from the port document, as it
  prints every accepted field. For `headers` it prints `headers?: {, ...}`, and it will print `columns` the same
  way. That rendering of an object open to strings is `show` in `packages/core/src/types.ts`, and this RFC does
  not change it.
- The viewer's port page reads the same document. Nothing changes in `client/index.html`.
- The plugin's `README.md` says what `columns` does, on the line for `#parse` and `#write`.

### Plugin contract

None. `@blob` still has no `check`.

## Compatibility

No schema changes, and IR v1 is untouched. A document written before this RFC gives no `columns`, so it validates
and keeps its meaning: every column is read and written by its own name. Nothing changes for a file whose header
repeats a name. After 1.0, adding an optional input to a port a plugin grants is a compatible change.

## Tests

No sabotage test: the RFC adds no checker rule. The handler tests go in `packages/plugin-blob/test/blob.test.ts`,
beside today's parse and write cases:

- a file headed `url,method,hit-count` with `columns: { "hit-count": "hits" }` reads `hits` as a number;
- an unmapped column is read by its own name, mapped and unmapped mixed in one header;
- a key no header writes changes nothing, and a required field it was meant for fails the first row as today;
- `#write` with the map writes `url,method,hit-count,ok`, and a parse of that blob with the same map gives the rows
  back unchanged;
- a map value that is not a field fails `#parse` and `#write` with the message under *What a bad map does*, on an
  empty file too, so the handler judged the map before it read;
- two keys that map to one field, and a key that is another field's own name, each fail both operations the same
  way; a swap (`{ "degree": "averageRevs", "averageRevs": "degree" }`) and an identity (`{ "degree": "degree" }`)
  do not.

## Implementation plan

1. **The input and the handlers** (`area:plugin-blob`, `good first issue`). `columns` on `#parse` and `#write` in
   `csv.port.json`, with the new descriptions; the map's headers, `RowReader`, `lines` and `columnsOf` in
   `src/index.ts`; the handler tests above; the line in the plugin's `README.md`. One pull request.

The consumer then drops `header` from `plugins/scan-codemaat/src/index.ts` and writes
`"columns": { "average-revs": "averageRevs" }` on its parse. That edit is in the consumer's repository, not here.

## Drawbacks and alternatives

**Cost.** One more input on two operations, and one function that judges the map in the handlers. A reader of a
parse now looks in two places to know which field a column fills: the shape and the map. A bad map is found when
the node first runs for real, not by `wilanis check`.

**Rules in `@blob`'s own `check`.** The first draft of this RFC proposed two X rules that judged the map against the
shape before anything ran. The maintainer decided against new plugin rules in this RFC. The handler's fault
names the same entries, but only when the node runs.

**No judgement of the map at all.** The handlers could apply the map as written and judge nothing. Then a value
that is not a field fails a closed shape on each row as `not a declared field`, but is silently kept as text in an
open shape. On `#write` the entry is silently ignored, and a key that is another field's name writes two columns
with one header. The handler's judgement costs a few lines and stops all three.

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
compiler could no longer type it, and no consumer has asked for it.
Static matches `type`, which is static too.

**A rename after the parse.** An `@std/object` operation that renames keys, run on the rows. It comes too late: the
parse fails a closed shape on the unknown column before the rename runs, and only the parse coerces cells.

**A CSV codec.** The question was whether a codec needs the same map. No codec decodes CSV into rows. A route maps
`text/csv` to `@http/codecs/blob.codec.json` (`example/project.json`), the body is a handle, and a data graph reads
it with `#parse`. A codec document has only `yields` (`codec.schema.json`), so a codec has no per-call input where a
map could go. If a rows codec is proposed one day, it should take its row shape and its map from the trigger, and
that is its own RFC.

## Open questions

Settled in review:

- **No new rules.** Neither `columns` nor a repeated header in the file becomes a refusal. A bad map is a fault of
  the handler (*Runtime behaviour*).
- **`#write` takes the map.** One map, the same on both calls, gives a file back with the header it came with.

May be decided during implementation:

- Whether a key with spaces around it is trimmed before it is compared. Header cells are trimmed today, so such a
  key never matches. Trimming the key too, or failing on it with the other faults of the map, are both small.
