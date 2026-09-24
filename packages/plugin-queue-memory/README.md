# @wilanis/plugin-queue-memory

The `@queue-memory` broker for wilanis: [`@queue`](https://github.com/wilanis/wilanis-js/tree/main/packages/plugin-queue)'s
queues kept in arrays, for exactly as long as the process runs. Nothing is written to disk and nothing outlives
the process -- **stop the tree and every message still queued is gone** -- which is what makes it the broker to
reach for in development, in tests, and for the trees under `libraries/` that must check, rehearse and run on
their own.

```
npm install @wilanis/plugin-queue-memory
```

```json
{ "use": "@queue-memory", "from": "@wilanis/plugin-queue-memory" }
```

Name it beside `@queue` in `project.json`, in either order, and a queue trigger or a `publish` whose connection
is of the kind it grants is kept by it.

## The connection kind

`@queue-memory/memory.connection-kind.json`, which declares `"delivery": "at-least-once"`: that is how a queue
trigger knows it may receive from a connection of this kind, and why the operation it fires must promise
`idempotent`. **It has no settings at all**, so there is nothing to misconfigure:

```json
{
  "$schema": "@wilanis/connection.schema.json",
  "description": "the queued work, kept for as long as this process runs",
  "kind": "@queue-memory/memory.connection-kind.json",
  "settings": {}
}
```

It delivers at least once on purpose. A table in the tree's database, the production broker, hands a message
again when the worker that took it died before acknowledging it; a development broker that never did would let
a tree check and run against a promise production does not keep.

## What it keeps, and when it hands it out

A queue is the pair of its **connection** and its **name**, so the same name on another connection is another
queue. A body is kept as the JSON it encodes to and decoded afresh for every delivery, so what a graph does with
a message it was given never reaches what is kept, and what JSON cannot carry does not arrive here either.

A consumer hands out a message the moment it may be: when it is published, when a delivery in flight is
answered, and when the soonest message waiting falls due -- a `delayMs`, or the backoff of a retry. A retry is
put back one attempt higher, no sooner than its backoff from the answer; a `dead` message is parked and never
handed out again; a handle that throws is a retry with no wait. While a queue is consumed one timer stays armed,
so a process whose only work is its queues stays up while nothing is queued.

The queues hang off the broker instance and never off the module, and `postLoad` registers an instance per
environment, so loading a tree a second time starts with nothing queued. `ensure` has nothing to create.

## What a test reads, and the acknowledgement it can lose

The broker a tree reaches is `brokers(env).for('@queue-memory/memory.connection-kind.json')`, a `MemoryBroker`:

| Member | What it answers |
|---|---|
| `waiting(connection, queue)` | what waits to be handed out, due or not, as a delivery of it would carry it |
| `parked(connection, queue)` | what was parked as dead, `{ id, body }` each, in the order it was parked |
| `dropAcks(count = 1)` | loses the next `count` acknowledgements, as a worker that died after its run and before its ack loses one: the message is handed out again at once, one attempt higher |

`dropAcks` is what makes at-least-once something a test can watch happen: the operation a queue trigger fires
sees the message twice, and an idempotent one leaves one effect.

Depends on `@wilanis/core`, `@wilanis/engine` and `@wilanis/plugin-queue` -- the one contract it answers. What
"being a broker" means is executable: this package runs `@wilanis/plugin-queue/suite`, the cases every broker
must answer alike.

Part of [wilanis](https://github.com/wilanis/wilanis-js). Apache-2.0.
