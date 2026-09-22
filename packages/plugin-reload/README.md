# @wilanis/plugin-reload

The `@reload` plugin: watch a wilanis tree and serve it again when a document changes, without closing
what is listening.

```
npm install @wilanis/plugin-reload
```

```json
{
  "plugins": [
    { "use": "@reload", "from": "@wilanis/plugin-reload" }
  ],
  "startup": [
    { "label": "Watch for changes", "run": "@reload/watch.port.json#watch" },
    { "label": "Listen",            "run": "@http/server.port.json#listen" }
  ]
}
```

`watch` is a `holds` operation: it starts something that outlives the run, so a project's `startup` list
names it and the runtime closes it when the process stops. Put it before whatever listens.

## What it does

On a change under the project directory it re-loads the tree and judges it exactly as `wilanis check`
does, then serves it. The listener's socket never closes -- only the tree behind it is replaced -- so an
edit takes effect on the next request and in-flight ones finish against the tree they started on.

A change that does not pass the check is reported and refused, and the last good tree keeps answering:

```
reload: 68 documents, serving the new tree

reload refused, still serving the last good tree:
G003  @features/customers/data/get-row.graph.json#nodes/asked/in/path
    no field 'nosuchfield' in @features/customers/domain/CustomerRef.shape.json
```

Edits are debounced (120ms by default, `settings.debounceMs` or the operation's `debounceMs` to change
it), and only `.json` files count as a change. A write under `.wilanis/`, `scenarios/`, `node_modules/`,
`dist/` or `.git/` never does: `.wilanis/` is the tree's own working state (the `@auth` files store keeps
its sessions there, and a sign-in must not reload the tree and empty every memory engine), `scenarios/` is
what `wilanis fuzz` records, and the rest nobody edits by hand. The list lives in one place, `IGNORED_DIRS`
in `src/index.ts`.

## Where the work happens

The plugin decides only *when* to reload. Loading the tree and judging it belong to the runtime and reach
the handler as `serving.reload()` -- a plugin never imports the compiler or the runtime.

## Meant for development

It re-reads the whole tree on every change. That is cheap for an ordinary project and keeps the reload
honest: what ends up serving is exactly what `wilanis check` would pass. Production trees name the
listener alone.

Apache-2.0.
