# @wilanis/plugin-blob

The `@blob` plugin for wilanis: operations over stored files. A `blob` value is a handle -- id, content
type, size, filename -- to bytes the tree's registry holds. These operations stream those bytes to read
them, and stream new bytes in to answer a new blob; the file itself is never a value in a graph.

```
npm install @wilanis/plugin-blob
```

```json
{ "use": "@blob", "from": "@wilanis/plugin-blob" }
```

- `@blob/csv.port.json#parse` reads a CSV blob as rows of a declared shape (`type`), coercing numbers and
  booleans from text and judging every row; `#write` writes rows of a shape as a CSV blob, header first.
  Both take `columns`, a static map from a header name, as the file writes it, to the field of the shape it
  is read into or written from (`{ "average-revs": "averageRevs" }`); a column the map does not name keeps
  its own name, so one map written on both calls gives a file back with the header it came with. A map that
  names no field of the shape, or gives two fields one header, or writes a key with spaces around it (a
  header cell is read trimmed), fails the node before it reads or writes.
- `@blob/text.port.json#read` reads a blob as UTF-8 text; `#write` stores text as a blob.

Every operation is an effect (it touches the registry), so it lives in a data graph and is listed in the
feature's `effects`. In a rehearsal it is stubbed like any effect. A route uploads a file through a content
type mapped to `@http/codecs/blob.codec.json`, and downloads one by answering a `blob` through it; on the
command line, `wilanis run --file path` hands a file as `context.file` and `--out path` receives a blob answer.

Depends on `@wilanis/core` and `@wilanis/engine`.

Part of [wilanis](https://github.com/wilanis/wilanis-js). Apache-2.0.
