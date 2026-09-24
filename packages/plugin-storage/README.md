# @wilanis/plugin-storage

The `@storage` plugin for wilanis: records of a shape, kept behind a connection, read and written through one
generic port. A feature declares a **store** -- which shapes it persists, under which collection names, keyed
by which field, over which connection -- and its data graphs name the store and the collection and nothing
else. The collection is where the record type is written down, so no call site repeats it.

```
npm install @wilanis/plugin-storage
```

```json
{ "use": "@storage", "from": "@wilanis/plugin-storage" }
```

This package says what a store is and what may be asked of one. **How records are kept is an engine plugin's
business**: `@storage` speaks no engine's language, carries no driver, and depends on `@wilanis/core` and
`@wilanis/engine` alone. Name an engine's package beside this one in `project.json` -- in either order -- and a
store whose connection is of the kind it grants is kept by it.

## What may be asked

`@storage/store.port.json`, every operation taking `store` and `collection` and nothing else that names a type:

- `#get` one record by its key; `#find` the records a filter matches, ordered and paged; `#count` how many.
- `#put` one whole record: the upsert the name suggests, or, with `"replace": false`, a write that answers
  `conflict` instead of overwriting. `#patch` some fields of one; `#remove` one, answering what it removed.
- `#newKey` a key no record has, so what identifies a record is written by a node a reader can see.

An absent record is answered as `record` absent rather than as a failure, so a graph routes on `has(record)`.
A constraint the store declares is answered the same way: `#put` answers `violated` where a `unique` is
repeated or a `refs` points at nothing, `#remove` answers `removed` and `referencedBy` where another
collection still holds the key, and the node stays `done` either way -- failure is for the unforeseen, and a
constraint the store itself declares is the opposite of that. `@storage/storage.port.json#ensure` prepares
what a store declares, from a startup step.

`$T`, the record's type, and `$K`, its key's, are read from the store document by the port's `resolves` --
`collections[collection].of` and `collections[collection].of{key}.type` -- so the checker types every call site
from the collection the call names.

## The `where` grammar

A filter is an object whose keys are fields of the collection's shape. A value is a literal (equality) or a
predicate of `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `in`, `notIn`, `has`, `contains`, `startsWith`; `all`, `any`
and `not` sit beside the field names. A field that is a shape or a list may only be tested with `has`. The
grammar is parsed here, once, so every engine judges one filter the same way -- and a misspelled field or
operator is named rather than quietly compared.

## The record

`renamed` and `was` on a collection say what a field or the collection was called before, so a rename is a
rename and not a drop and a create. Knowing which of them has already happened needs a memory of the database
as it was last left, and that memory is **the record**: every collection as it was last applied to that
database, one entry per collection per applied plan.

The record is the engine's, kept **in the database it describes** -- a database carries its own history, and a
fresh one carries none -- and it is not a document: nothing under `features/` names it, no graph reads it, and
`wilanis check` never sees it. `wilanis migrate` writes it and `wilanis migrate --history` prints it. The
table it lives in is the engine's too: `@wilanis/plugin-storage-postgres` keeps it as `wilanis_migrations` in
the connection's schema and creates it on first contact, and `@wilanis/plugin-storage-memory` keeps nothing
between processes, so it records nothing and has nothing to migrate.

`wilanis describe <store>` and the viewer read the tree and open no connection, so they say what the store
declares -- `renamed` and `was` among it -- and never what the database holds. What the database holds is
`wilanis migrate --history`'s alone to say.

## Writing an engine

An engine is a plugin of its own. It grants a connection kind marked `"storage": true`, implements `Engine`
from this package, and registers itself from `postLoad`:

```
engines(ctx.env).register('@your-engine/your.connection-kind.json', makeEngine(ctx));
```

Eight methods, each taking the collection as an `At` -- where its records live, what it is called there, the
shape they have, the field that identifies one, and what the store declared about them:

| Method | Answers |
|---|---|
| `get(at, key)` | `{ record? }` -- absent where the collection holds none under that key |
| `find(at, query)` | the records the filter matches, in the order asked for, cut to the page |
| `count(at, where)` | how many match, carrying none of them back |
| `put(at, record, replace)` | `{ record?, conflict, violated? }` -- the whole record written, or what stopped it |
| `patch(at, key, changes)` | `{ record? }` -- the record after the change, never touching the key |
| `remove(at, key)` | `{ record?, removed, referencedBy? }` -- what was removed, or what still references it |
| `newKey(at)` | a key no record of the collection has, of the key field's type |
| `ensure(collections)` | every collection prepared; what that means is the engine's, and may be nothing |

**A condition the author could expect is answered, never thrown.** An absent record, a taken key, a violated
`unique`, a record another still references: each comes back as a field a graph routes on with a `switch`.
Failure is for the unforeseen.

The table is created by whichever side reaches it first, so nothing has to be said about plugin order. The
`At` an operation is given carries the constraints the store declared -- `unique`, the `refs` this collection
makes and the ones made to it -- so an engine answers `violated` and `referencedBy` from the declaration
rather than from a driver's error text. What "being an engine" means is executable:
`@wilanis/plugin-storage/suite` exports the cases every engine must answer alike, as plain `{ name, run }`
pairs your own `it` can run -- the constraint cases among them.

An engine whose connection kind also declares `"leases": true` keeps the hold `@schedule` takes for a tick on
several instances. It implements `Leases` from this package -- `acquire`, `release`, `lastFired`, `markFired` --
and registers it from the same `postLoad`, beside the engine, through `leases(env)`:

```
leases(ctx.env).register('@your-engine/your.connection-kind.json', makeKeeper(ctx));
```

`@wilanis/plugin-storage-postgres` does this with `TableLeases`, one row per trigger in `wilanis_schedule`.
Whether a hold has expired is judged by the database's clock, never the process's: `TableLeases` asks `now()` of
the server every instance shares, so two instances whose clocks drift still agree on who holds a tick. That is
what the postgres engine promises, and what a keeper of another store should promise too.

Every operation is an effect, so each lives in a data graph and is listed in the feature's `effects`. A
rehearsal stubs them and reaches no engine at all.

Part of [wilanis](https://github.com/wilanis/wilanis-js). Apache-2.0.
