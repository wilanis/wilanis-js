# @wilanis/plugin-otel

The `@otel` plugin: ship every run of a wilanis tree to an OpenTelemetry collector as spans, in the tree's
own words.

```
npm install @wilanis/plugin-otel
```

```json
{
  "plugins": [
    { "use": "@otel", "from": "@wilanis/plugin-otel", "settings": { "endpoint": "{{secrets.OTLP_ENDPOINT}}", "service": "monitor" } }
  ],
  "startup": [
    { "label": "Export traces", "run": "@otel/exporter.port.json#export" },
    { "label": "Listen",        "run": "@http/server.port.json#listen" }
  ]
}
```

Nothing is instrumented by an author, and nothing is added to a tree to be traced. Every fire of a trigger
already leaves a complete report -- which node ran, when it started and ended, what it answered, which branch
a `switch` chose -- and this sends it. **The graph is the instrumentation.**

`export` is a `holds` operation: it starts something that outlives the run, so a project's `startup` list
names it and the runtime stops it, flushing what is waiting, when the process stops. Delete the step and
nothing is exported. No runtime decides on its own that a tree should phone home, and a reader of
`project.json` sees at the root that traces leave this process, to where, and under which service name.

## What a trace says

One run is one trace. Its root span is the fire; under it the guard's identification, each policy's decision,
then the operation; under the operation one span per node that ran, and a binding graph's nodes under the node
that called it:

```
fire @customers/edge/get-customer.trigger.json                    143ms  refused: upstream
  @customers/domain/customer.port.json#get                      141ms  refused: upstream
    binding @customers/data/monitor.binding.json#get           141ms
      get-row (@customers/data/get-row.graph.json)             140ms  refused: upstream
        asked   @http/http.port.json#request                 131ms  ok  status=500
        route   switch → failed                                0ms  ok
        failed  @std/outcome.port.json#refuse                  0ms  refused: upstream
```

Every node span carries `wilanis.at` and its graph's `wilanis.graph`: together they are the address a refusal
prints as `file` and `at`, so a span on a collector and a refusal from `wilanis check` join on one pair of
strings.

A run that a caller correlated -- an http request carrying `traceparent` -- becomes part of the caller's
trace, so a request that crossed two services reads as one thing. A correlation that is not a `traceparent`
is kept as it came, on `wilanis.correlation`, and the run starts a trace of its own.

## Settings

| Setting | Required | What it is |
|---|---|---|
| `endpoint` | yes | the OTLP/HTTP collector to POST spans to, e.g. `http://localhost:4318/v1/traces`. A `{{secrets.<key>}}` read where the collector is not public. |
| `service` | yes | what this tree is called on a span: the `service.name` every exported span carries. |
| `headers` | no | headers sent with every batch, for a collector that authenticates. |
| `level` | no | `summary` (the default) or `full`. |

## Levels, and why `summary` is the default

At `summary` a span carries status, timing and the `wilanis.*` attributes, and **never a value**. At `full` it
also carries the report's already-redacted `in` and `out`, and a node's message.

The difference is not verbosity, it is safety. A *reason* is a word the author declared in `refuses` -- a
closed set that cannot leak. A *message* is prose that interpolates whatever the author wrote into it
(`"no entry {{in.id}}"`), and redaction blanks only the paths a document *marked* secret. The value nobody
thought to mark is exactly the one that ends up in a message, so the level that is safe to export by default
cannot carry one. Turning on `full` is the author saying they have read what their messages say.

A challenge's `detail` -- its id and how to answer it -- never enters a trace at any level.

## Rules of its own

| Code | Refuses when |
|---|---|
| `X301` | `settings.endpoint` is neither a `{{secrets.<key>}}` read nor an `http(s)://` URL, or `level` is not `summary`/`full` |

The endpoint is judged as it is *written*, before any secret is substituted, which is the only moment at
which a literal URL and a read of a secret can be told apart. The value behind a secret is taken on trust:
it is not there to judge at check time.

## What it does not do

It never changes what the tree does. Export is batched and asynchronous, so a slow collector never delays an
answer; a collector that cannot be reached is said once in the log and the batch is dropped; and an observer
that throws is stepped over by the runtime rather than failing the run whose trace it was handed. Observing a
tree must never be able to break it.

An export survives a reload. The listeners live on the server, not on the tree, so `@reload` can replace the
tree underneath a running export exactly as it does under an open socket.

## Other backends

Zipkin, Datadog, Honeycomb and the rest all accept OTLP, so a plugin per vendor is not needed. A backend that
speaks another protocol would be another `holds` operation over the same `Serving.observe`, with no change to
the runtime.
