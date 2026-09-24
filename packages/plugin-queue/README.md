# @wilanis/plugin-queue

The `@queue` plugin: a message on a queue fires a trigger the way a request does, a data graph publishes one
as an effect, and a worker is a startup step. It says what a queue is and what may be asked of one; which
broker keeps the queue is a connection, of a kind a broker plugin grants. This package carries no broker.

```
npm install @wilanis/plugin-queue
```

```json
{
  "plugins": [
    { "use": "@queue", "from": "@wilanis/plugin-queue" },
    { "use": "@queue-memory", "from": "@wilanis/plugin-queue-memory" }
  ],
  "startup": [
    { "label": "Work the queues", "run": "@queue/worker.port.json#consume" },
    { "label": "Listen",          "run": "@http/server.port.json#listen" }
  ]
}
```

`consume` is a `holds` operation: it starts something that outlives the run, so a project's `startup` list
names it and the runtime stops it when the process stops. Delete the step and no queue is consumed, exactly
as deleting `listen` closes the port. Listed before `listen`, it is stopped after the socket closes, so what a
route published last is still worked. It takes `concurrency` (messages of one queue in flight at once, default
1) and `queues` (the queue names this process works, default every one a queue trigger names).

## A queue trigger

```json
{
  "$schema": "https://raw.githubusercontent.com/wilanis/wilanis-js/main/packages/core/schemas/trigger.schema.json",
  "label": "removals queue",
  "description": "One message per customer to remove.",
  "kind": "@queue/queue.trigger-kind.json",
  "settings": {
    "connection": "@connections/jobs.connection.json",
    "queue": "removals",
    "message": "@customers/edge/IdRequest.shape.json",
    "maxAttempts": 5,
    "backoffMs": 1000,
    "outcomes": { "missing": "ack", "upstream": "retry" }
  },
  "in": "@customers/edge/IdRequest.shape.json",
  "out": "@customers/edge/CustomerView.shape.json",
  "fire": {
    "run": "@customers/domain/customer.port.json#remove",
    "in": { "id": "{{request.message.id}}" }
  }
}
```

The context hands the graph what the message carries, read like any input through `fire.in`:

| Read | What it is |
|---|---|
| `request.message` | the body, of the edge type `settings.message` names |
| `request.headers` | what the publisher put beside the body; where a credential rides |
| `request.id` | the broker's id for the message, the same on every delivery of it |
| `request.attempt` | 1 on the first delivery, one more on each redelivery |
| `request.queue` | the queue it arrived on |

A message is gated like a request: a policy attachment gives the guard a token read from the headers
(`"in": { "token": "{{request.headers.authorization}}" }`), and a queue trigger with no policies is public to
whoever can publish to the broker. The answer is judged against `out` and logged; nobody receives it. The
kind declares `correlation: headers.traceparent`, as the route kind does, so a publisher that puts its W3C
`traceparent` in the headers finds the run it caused under its own trace.

**What becomes of a message** is the trigger's `outcomes` table, reason by reason, exactly as a route's
`response.refusals` maps a reason to a status: `ack` (the work is done, or not worth doing), `retry` (deliver
it again later), `dead` (park it where an operator can find it). Every reason the run can reach must be mapped
(T005), and no other may be (T006). An answer is `ack`. A fault -- a node that broke with no reason -- is
`onFault`, `retry` by default. A retry waits `backoffMs` before the second delivery and doubles the wait before
each further one; the delivery that is the last of `maxAttempts` is `dead` instead. A message whose input does
not conform to the trigger's `in` is `dead` at once, since delivering it again cannot help.

Each delivery is one line of the log:

```
queue removals m1 attempt 1 → ack (61ms, @customers/domain/customer.port.json#remove done)
```

**At least once.** A broker whose kind declares `"delivery": "at-least-once"` delivers a message again when
the worker did not acknowledge it -- a process that died between the write and the ack -- so what the
trigger fires may run twice for one message. The acknowledgement is the worker's, after the run, outside
every graph's transaction; the operation a queue trigger fires is what must be safe to repeat.

## Publishing

```json
{
  "id": "published",
  "type": "@wilanis/node/run.schema.json",
  "run": "@queue/queue.port.json#publish",
  "in": {
    "connection": "@connections/jobs.connection.json",
    "queue": "removals",
    "type": "@customers/edge/IdRequest.shape.json",
    "message": { "id": "{{in.id}}" },
    "headers": { "authorization": "{{token}}" }
  }
}
```

`publish` is an effect: it lives in a data graph, is listed under the feature's `effects`, and a rehearsal
stubs it, so nothing leaves the process. `type` binds the message's type, and the checker holds `message` to
it; where a queue trigger of the same tree consumes that connection and queue, the type is held to what the
trigger accepts (X403). `delayMs` holds a message back. `ensure` prepares what a broker needs on a
connection -- a table -- and changes nothing that exists.

No message carries a blob (X404): a handle names bytes in one process's blob registry. Publish the handle's
id and read the bytes where the message is consumed.

**Inside an atomic graph.** `publish` is `transactional`, as `@storage`'s operations are. Where the
connection's kind is marked `storage` -- the queue is a table in the store the graph writes -- the message
joins the graph's transaction: it exists exactly when the writes commit, and a rollback leaves nothing
published. A broker of any other kind keeps its queue outside that transaction, so an atomic graph publishing
to one is refused (X405), and one that reaches such a publish through a domain call fails the node before the
broker keeps anything. Publish after the atomic graph instead, in its caller, on a node that reads its answer.

## What a broker implements

A broker is a plugin package of its own. It grants a connection kind that declares how it delivers, and
registers a `Broker` for that kind from its `postLoad`, in the table `brokers(env)` holds:

```json
{
  "$schema": "https://raw.githubusercontent.com/wilanis/wilanis-js/main/packages/core/schemas/connection-kind.schema.json",
  "label": "In-process queue",
  "description": "A broker that lives as long as the process.",
  "delivery": "at-least-once",
  "settings": { "fields": {} }
}
```

```ts
import type { Broker } from '@wilanis/plugin-queue';
import { brokers } from '@wilanis/plugin-queue';

const plugin = {
  root: '@queue-memory',
  docs: fileURLToPath(new URL('../docs', import.meta.url)),
  handlers: {},
  async postLoad({ env }) {
    brokers(env).register('@queue-memory/memory.connection-kind.json', memoryBroker());
  },
};
```

The table is created on first use by whichever side reaches it first, so the order plugins are named in
`project.json` does not matter, and a reload starts with a table of its own. `Broker` is three methods, each
about one connection -- its canonical path, whose settings the broker reads off `env.connections`:

| Method | What it does |
|---|---|
| `ensure(connection)` | create what the broker needs to keep queues there, altering nothing that exists |
| `publish(connection, queue, { body, headers, delayMs? }, atomic?)` | keep one message, answering the id every delivery of it carries; `atomic` is the graph's transaction, handed only where the kind is marked `storage` |
| `consume(connection, queue, handle, { concurrency })` | hand every message to `handle`, at most `concurrency` at once, and answer the way to stop |

`handle` answers `{ outcome, backoffMs? }`: `ack` forgets the message, `retry` delivers it again with
`attempt` one higher no sooner than `backoffMs` from now, `dead` parks it. A `handle` that throws is a retry
with no wait, so the worker's own failure loses nothing. The stop takes no further message and resolves once
every delivery in flight has been answered and what the answer says has been done.

A broker whose kind is marked `storage` keeps its queue in the store, and `publish` hands it the atomic
graph's transaction: it enqueues on the transaction's session through `atomic.join(connection, ...)`, opening
it with what the storage engine of that connection begins, since one transaction is one connection and a store
call after the publish is handed the same participant. Any other broker is never handed one and may leave the
parameter off.

"This is a broker" has one executable meaning: the suite a broker's tests import and run.

```ts
import { cases } from '@wilanis/plugin-queue/suite';

const subject = { broker, connection: '@connections/jobs.connection.json', parked: queue => readDead(queue) };
for (const one of cases) it(one.name, () => one.run(subject));
```

`parked(queue)` answers what the broker parked as dead on that queue, `{ id, body }` each. The cases publish
and consume, retry with backoff, park the dead, bound concurrency and drain on stop, each on a queue of its own.

## Rules

| Code | Refuses |
|---|---|
| X401 | an outcome that is not `ack`, `retry` or `dead`; a `maxAttempts`, `backoffMs` or consume `concurrency` that is not a whole number in range |
| X402 | a `retry` outcome, or `onFault` left at `retry`, on a trigger whose connection's kind delivers at most once |
| X403 | a `publish` of a type the queue trigger consuming that connection and queue does not accept |
| X404 | a message type, a trigger's or a `publish`'s, with a `blob` field at any depth |
| X405 | a `publish` in an atomic graph to a connection whose kind is not marked `storage` |

Each is described, with an example and its fix, under [`docs/refusals`](../../docs/refusals/README.md).
