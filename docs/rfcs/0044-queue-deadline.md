# RFC 0044: A deadline on a queue trigger

- **Status:** draft
- **Areas:** `area:plugin-queue` (the kind's document, `deliver.ts`, X401, the README); `area:runtime` (one sabotage
  test, the example); a sentence in the Postgres table broker's README (`area:plugin-storage`). Nothing in the
  engine, the compiler, core or its schemas.
- **Tracking issue:** #910
- **Depends on:** RFC 0009 (the queue kind and its worker, implemented) and RFC 0012 (a kind hands its run a signal,
  implemented). Related: #907 (merged as #914), which makes the Postgres table broker extend a delivery's lock while
  its run goes on; and #924 (fixed by #936), which bounds `deadlineMs` in X004 and X251 by `TIMER_MAX_MS`, as this
  RFC bounds it in X401.

## Summary

A queue trigger may say `deadlineMs`: the most one delivery's run may take, in milliseconds, from the fire. When it
passes, the worker cancels the run as RFC 0012 cancels a route's: nothing more starts, the nodes in flight are told
through their signal, and the run answers a `cancelled` report. A cancelled run is a fault to its message: it becomes
`onFault`, so it is retried with the trigger's backoff by default, and dead on the last attempt `maxAttempts` allows.
X401 refuses a `deadlineMs` that is not a whole number of 1 or more, or that is above `TIMER_MAX_MS`. `wilanis describe` prints the deadline
of every queue trigger, `none` included, with no change to its code. Today a queue run that hangs holds its slot
forever, and with the default `concurrency` of 1 it stops its whole queue in that process.

## Motivation

**What goes wrong today.** The queue kind (`packages/plugin-queue/docs/queue.trigger-kind.json`) declares no
deadline, and `fired` in `packages/plugin-queue/src/deliver.ts` calls `serving.fire` with no `signal`. So a run whose
handler never answers -- an upstream that holds the socket with no `timeoutMs`, a plugin that waits on a child
process -- never ends. Four things follow, each read off the code:

- **The slot stays taken.** Each broker hands a queue's messages to the worker at most `concurrency` at once
  (`Broker.consume` in `packages/plugin-queue/src/brokers.ts`). A delivery whose `handle` never answers holds its slot
  for as long as the process lives. The consume step's `concurrency` is 1 by default (`concurrencyOf` in
  `worker.ts`), so one hung run stops the queue in that process.
- **The message is held forever.** The memory broker (`packages/plugin-queue-memory/src/consumer.ts`) holds a
  delivery until it is answered, so the message is never delivered again and never parked. The Postgres table broker
  now does the same in effect. Since #914, `TableConsumer.deliver` (`packages/plugin-storage-postgres/src/consumer.ts`)
  starts a `Renewal` (`renewal.ts`) for each delivery. It extends the row's `locked_until` every half
  `queueVisibility` (`extend` in `queue-table.ts`) and stops only once `handle` has answered. That is right for a
  healthy long run, which is no longer handed to a second worker. But a run that never answers is now renewed
  forever: its message is never delivered again, never dead, and never seen by another process.
- **The process does not stop.** `wilanis start` answers SIGTERM by calling `stop` (`packages/runtime/src/cli.ts`),
  and the worker's stop waits for every delivery in flight (`consumeOn` in `worker.ts`; `stop` in both consumers). A
  worker with a hung run never exits on SIGTERM, so a rolling deploy waits for a SIGKILL.
- **Nothing says so.** `wilanis describe` prints a trigger's deadline only where its kind declares `deadlineMs`
  (`limitsOf` in `packages/runtime/src/limits-said.ts`). The queue kind declares none, so a reader of a queue trigger
  is not told that its run is unbounded.

**What the schedule kind already does.** `packages/plugin-schedule/docs/schedule.trigger-kind.json` declares
`deadlineMs`. The scheduler arms it when a tick fires (`deadlineOf` in `packages/plugin-schedule/src/clock.ts`), hands
the signal to `fireTick` (`fire.ts`), logs the tick `→ cancelled (deadline)`, and X251 judges the number
(`packages/plugin-schedule/src/rules.ts`). The http kind does the same through `withDeadline` in
`packages/plugin-http/src/limit.ts`, judged by X004. The queue kind, the third kind that fires a run while the tree is
served, has none.

**What earlier RFCs said.** RFC 0009, under *Motivation*: "It does not give a run a deadline or cancel one (RFC 0012);
a message's run is bounded the way any run is." RFC 0012 then made a deadline a setting of each kind, in the kind's
own vocabulary: "A kind that wants a deadline holds the timer and hands the signal; a kind that wants none hands
nothing." It gave the http kind one and set the command-line kind aside; it names no queue. So after both RFCs, "the
way any run is" bounded is "not at all" for a queue run. The new evidence is a consumer: review-harness plans one
service that reviews 18 hosts from a queue kept in Postgres, two or three at a time (`GAPS.md`, "Item 31: a queue
delivery cannot outlast queueVisibility, and a queue trigger has no deadline"). Its scheduled review trigger already
says `"deadlineMs": 3600000` (`libraries/review/features/review/edge/scheduled.trigger.json`). The same review fired
from a queue cannot say it.

**What an author must do today.** Bound every call the run makes with RFC 0011's `timeoutMs`, at each node and each
binding operation, and hope the sum is small. That bounds a call, not a run. A `map` of nested graphs, a retry that
multiplies a call, or a native handler with no `timeoutMs` setting is still unbounded, and no document says what the
whole run may take.

**What this does not try to solve.** It does not change how the Postgres broker keeps its lock: #914 did that. It
does not give the visibility window a value per queue: since #914 the window only says how long a dead worker keeps
its message, and one value per connection is enough. It does not cancel the runs in flight when the worker stops: a stop
still drains, now bounded by the deadline. It does not add a deadline to the `@queue` plugin's settings, to the
consume step, or to `wilanis run` of a queue trigger.

## Guide-level explanation

**A deadline** on a queue trigger is the most one delivery's run may take, in milliseconds. The clock starts when the
worker fires the trigger, after the message's input has been built and judged, as it starts for a route
(RFC 0012). When the deadline passes, the run is **cancelled**: no node that has not started will start, the nodes in
flight are told through their signal and finish as they finish, and the run answers a report whose status is
`cancelled`. A cancellation is a request to stop, not a kill: a handler that ignores its signal delays the report by
as long as it runs.

**What becomes of the message.** A cancelled run did not answer and did not refuse with a reason, so `outcomes` cannot
map it and T005 does not ask it to. It is a fault, and it becomes `onFault`: `retry` by default, with the trigger's
backoff, and `dead` on the delivery that is the last `maxAttempts` allows. A trigger that says `"onFault": "dead"`
parks a message whose run passed its deadline. An effect the run already made stays made; an atomic graph rolls back,
as it rolls back on any run that is not `done` (RFC 0004, RFC 0012).

The example's removals trigger gives each removal 30 seconds:

```json
{
  "$schema": "https://raw.githubusercontent.com/wilanis/wilanis-js/main/packages/core/schemas/trigger.schema.json",
  "label": "removals queue",
  "kind": "@queue/queue.trigger-kind.json",
  "settings": {
    "connection": "@connections/jobs.connection.json",
    "queue": "removals",
    "message": "@customers/edge/IdRequest.shape.json",
    "maxAttempts": 5,
    "backoffMs": 1000,
    "deadlineMs": 30000,
    "outcomes": { "missing": "ack", "upstream": "retry", "...": "..." }
  },
  "in": "@customers/edge/IdRequest.shape.json",
  "out": "@customers/edge/CustomerView.shape.json",
  "fire": { "run": "@customers/domain/customer.port.json#remove", "in": { "id": "{{context.message.id}}" } }
}
```

(`...` stands for the rest of `example/features/customers/edge/remove-queued.trigger.json`, which this RFC does not
change beyond `deadlineMs`.)

A delivery whose run passes it is logged like this, and delivered again a second later:

```
queue removals m1 attempt 1 → retry (30004ms, @customers/domain/customer.port.json#remove cancelled (deadline))
```

On the fifth attempt the same line says `→ dead`. `wilanis describe` says the bound under the trigger's settings:

```
Anything that breaks and no switch catches is a fault: answered the kind's one way, never mapped.
deadline 30000ms
receives from  @connections/jobs.connection.json, which delivers at-least-once
```

A trigger that writes no `deadlineMs` reads `deadline none` on that line. An author who writes a number the worker cannot keep
meets X401, from its first branch:

```
X401  @features/customers/edge/remove-queued.trigger.json#settings/deadlineMs
    deadlineMs is 0; it is the most one delivery's run may take, so it is a whole number of milliseconds, 1 or more
    → set it to 1 or more, or drop it for no deadline
```

A deadline longer than a Node timer can wait reads, from the second branch:

```
X401  @features/customers/edge/remove-queued.trigger.json#settings/deadlineMs
    deadlineMs is 3000000000; it is the most one delivery's run may take, and a Node timer waits at most 2147483647 ms (about 24.8 days): a longer one fires after 1 ms, so every run would be cancelled at once
    → set it to 2147483647 or less, or drop it for no deadline
```

**How long a message can be held.** With a deadline, a live worker answers each delivery within `deadlineMs` plus the
time its handlers in flight take to stop. So a message is worked for at most about `maxAttempts × deadlineMs`, plus the
backoffs, before it is dead. Without a deadline there is no such bound.

## Reference

### Documents and schemas

None under `packages/core/schemas/`. `trigger-kind.schema.json` and `trigger.schema.json` do not change: a deadline is
a setting of the queue kind's own vocabulary, written in the kind's document, as RFC 0012 put the http kind's. No
`*Doc` interface, no `HOME` row, no `wilanis new` scaffold changes. `packages/runtime/templates/CLAUDE.md` does not
change: it describes no queue trigger setting today, and its X list names no `@queue` rule.

### Ports, operations and kinds granted

One document of `@wilanis/plugin-queue` changes. `packages/plugin-queue/docs/queue.trigger-kind.json`:

- `settings.fields` gains, after `onFault`:

  ```json
  "deadlineMs": {
    "type": "number",
    "required": false,
    "description": "the most one delivery's run may take, in milliseconds from the fire, before it is cancelled (RFC 0012); a cancelled run is a fault, so it becomes onFault. A whole number from 1 to 2147483647, the longest a Node timer waits. Absent: no deadline, and a run that never answers holds its message and its slot until the process is killed"
  }
  ```

  The description writes the number, because a JSON document cannot name `TIMER_MAX_MS`. The schedule kind's
  `deadlineMs` writes it the same way. The rule that judges the setting reads the constant.

- `description` gains one sentence after "A fault becomes settings.onFault, retry by default.": "A run past
  settings.deadlineMs is cancelled, and is a fault too."

No port, operation, codec, shape or connection kind changes. `worker.port.json` does not change.

### Checker rules

X401 widens; no new code (decided). X401 is "a setting a worker cannot act on" (`packages/plugin-queue/src/rules.ts`),
and it already judges `maxAttempts` and `backoffMs` in `checkCounts`. The schedule kind put its own `deadlineMs` under
its existing range rule, X251, in the same way. The new check is a sibling of X251's `checkDeadline` in
`packages/plugin-schedule/src/rules.ts`, and copies its two branches, with "a tick's run" said as "one delivery's
run". The message starts `deadlineMs is <value>; it is the most one delivery's run may take`, then:

| Code | Where it lives | Refuses when | Message goes on | Hint |
|---|---|---|---|---|
| X401 | `packages/plugin-queue/src/rules.ts`, beside `checkCounts`, at `settings/deadlineMs` | `deadlineMs` is not a whole number of 1 or more | `, so it is a whole number of milliseconds, 1 or more` | `set it to 1 or more, or drop it for no deadline` |
| X401 | same | `deadlineMs` is above `TIMER_MAX_MS` | `, and a Node timer waits at most ${TIMER_MAX_MS} ms (about 24.8 days): a longer one fires after 1 ms, so every run would be cancelled at once` | `set it to ${TIMER_MAX_MS} or less, or drop it for no deadline` |

T001 already refuses a `deadlineMs` that is not a number, since the kind types it. X401 judges the range.

**Why the upper bound (decided).** Node's `setTimeout` takes a 32-bit signed delay. A larger one is set to 1 ms, with
only a `TimeoutOverflowWarning` on stderr, so a `deadlineMs` of 35 days would cancel every run at once. The bound is
`TIMER_MAX_MS` from `@wilanis/core` (`packages/core/src/timer.ts`), 2^31 - 1 ms, about 24.8 days. The rule imports it
and writes no number of its own. X004 (`@http`) and X251 (`@schedule`) hold their own `deadlineMs` to the same
constant since #936, so the three kinds refuse the same numbers.

No rule relates `deadlineMs` to a broker's visibility window. `@queue` cannot see a broker's settings: the `Broker`
contract says nothing about a window, and the memory broker has none. Since #914 no such rule is needed
(*Runtime behaviour*, the broker table).

### Runtime behaviour

**The worker** (`packages/plugin-queue/src/deliver.ts`, `fired`). It reads `settings.deadlineMs` off the trigger
(found afresh on every delivery, so a reload changes the next delivery's deadline). Where there is one, it makes an
`AbortController`, arms `setTimeout(() => control.abort(), deadlineMs)` just before `serving.fire`, passes
`signal: control.signal`, and clears the timer in a `finally`. This is the shape of `withDeadline` in
`packages/plugin-http/src/limit.ts`; a plugin does not import another plugin, so the ten lines are the queue's own
(see *Open questions*). Where there is none, `fire` is handed no signal, exactly as today. The worker waits for the
report; it does not race the timer and answer the broker early. So the broker is answered, the line is logged and
the blob scope is released on one path, after the last handler in flight has settled. RFC 0012 chose the same for the
http kind, under *Drawbacks*, "Waiting for the report at the deadline".

The clock covers all of `serving.fire`: the gate, then the run. Only the run is cancelled, since the gate's policies
and the guard's `identify` are handed no signal (`gate` in `packages/runtime/src/gate.ts`; RFC 0012 left `GuardArgs`
as it is). The http kind's deadline covers the same span.

**The outcome** (`packages/plugin-queue/src/outcome.ts`). No change. `decidedOf` already turns a `cancelled` report
into `onFault` (its `default` branch, `ended: 'cancelled'`), and `attempted` already turns a `retry` on the last attempt
into `dead` and doubles the backoff. A cancelled run counts as an attempt, as any fault does. A run that finished as
the deadline struck answers a `done` report and is acknowledged: the report decides, not the timer.

**The log line** (`deliver.ts`, `lineOf`). Where the report is `cancelled` and the deadline's signal has aborted,
`ended` reads `cancelled (deadline)` in place of `cancelled`, as the schedule's line does (`outcome` in
`packages/plugin-schedule/src/fire.ts`).

**The stop.** `consume`'s stop is unchanged: it takes no further message and waits for every delivery in flight. With
a deadline, that wait is bounded by `deadlineMs` plus the time the handlers in flight take to settle, so SIGTERM ends
the process in bounded time. A delivery cancelled while the stop waits is answered like any other: it becomes
`onFault`.

**Each broker's visibility window.** The deadline is the worker's. A broker sees only that `handle` answers sooner.
No broker code changes in this RFC.

| Broker | How long it holds a delivery today | With `deadlineMs` |
|---|---|---|
| memory (`plugin-queue-memory`) | until `handle` answers; it has no window | until `handle` answers, which is now within the deadline plus the time the handlers in flight take to settle. The deadline is the only thing that frees a hung run's slot and message |
| Postgres table (`plugin-storage-postgres`) | until `handle` answers: `TableConsumer.deliver` makes a `Renewal` before it calls `handle`, which extends `locked_until` by one window every half window, and it calls `renewal.stop()` after `handle` answers and before the answer is kept. `queueVisibility` only says how long a worker that died keeps its message | until `handle` answers, which is now within the deadline plus settle time. Then `renewal.stop()` runs, and the retry or dead is kept under the same attempt |

The deadline and the renewal do not interact. The deadline ends the run; the run's answer ends the renewal. No
number has to be smaller than another: a `deadlineMs` of an hour beside a `queueVisibility` of 30 seconds is right,
since the lock is extended about 240 times while a healthy run goes on. Two edge cases stay as #914 left them, and
neither is this RFC's:

- An extension that fails is logged and tried again at the next beat (`Renewal.once`). If the lock lapses meanwhile,
  another worker takes the message, one attempt higher. That is the redelivery at-least-once allows. The first run's
  answer then matches no row, since `forget`, `release` and `park` filter on `attempts`.
- A worker that dies stops extending. The message comes back one window later, as before.

So #914 and this RFC close two halves of one problem. #914 keeps a healthy long run from being handed out twice. This
RFC keeps a hung run from holding its message, its slot and the process's stop forever. #914 made the second half
more urgent: before it, a lapsed lock at least let another slot take a hung run's message.

No tree runs an older `@storage-postgres` that does not renew: no package has been published to npm yet
(`docs/roadmap.md`, M14). So this RFC says nothing about the broker before #914.

**`rehearse`, `fuzz`, `regress`, `wilanis run`.** No change. A rehearsed or fuzzed run is handed no signal and is
never cancelled. A `cancelAt` scenario on a queue trigger already replays a `cancelled` run (RFC 0012), and the kind's
`encode` already says what the message would become, through `outcomeOf`. `wilanis run` of a queue trigger builds a
command line's context and hands no signal (`packages/runtime/src/serve.ts`); a command-line run is never cancelled
(RFC 0012).

### Discoverability

- `wilanis describe <queue trigger>` prints `deadline 30000ms`, or `deadline none` where the trigger writes none, after
  the fault line. `limitLines` in `packages/runtime/src/limits-said.ts` does this for any kind that declares
  `deadlineMs`, so no runtime code changes. `@queue` has no plugin settings, so no line reads `(from @queue settings)`.
- `wilanis describe @queue/queue.trigger-kind.json` lists the new setting with its description, as it lists every
  setting (`kindLines`).
- The viewer shows the deadline on a queue trigger's page with no change: `viewOf` reads the same `limitsOf`
  (`packages/view/src/model.ts`), and the page shows a trigger's limits for every kind.
- `wilanis map` and `wilanis ls`: no change. A deadline is not a document.
- `packages/plugin-queue/README.md` gains a paragraph on `deadlineMs` beside the one on outcomes, and its rules table's
  X401 row names `deadlineMs`. `docs/refusals/X401.md` gains the range and an example.
- `packages/plugin-storage-postgres/README.md` gains one sentence after the paragraph #914 wrote on the lock: a run
  that never answers keeps its lock for as long as its worker lives, so a queue trigger's `deadlineMs` is what ends
  it. The `queueVisibility` description in `docs/plugin.json` does not change.

### Plugin contract

None. `PluginModule`, `Handler`, `FireArgs` and the `Broker` contract do not change. `FireArgs.signal` exists since
RFC 0012.

## Compatibility

No schema under `packages/core/schemas/` changes, so the maintainer's `decision` job has nothing to approve for a
schema. One plugin document, `packages/plugin-queue/docs/queue.trigger-kind.json`, gains an optional setting. Every
queue trigger written before this RFC validates and means what it meant: no deadline, and its run is never cancelled.
Its `describe` output gains one line, `deadline none`. X401 refuses no document it accepted before, since no document
could write `deadlineMs` without T001 refusing an unknown setting. The log line of a run that is not cancelled is
unchanged.

## Tests

**Sabotage**, in `packages/runtime/test/sabotage-queue.test.ts`, beside the X401 cases:

| Code | The edit to the example |
|---|---|
| X401 | `"deadlineMs": 0` on `remove-queued.trigger.json`; `"deadlineMs": 1.5`; `TIMER_MAX_MS + 1` |
| none | `"deadlineMs": 30000` on `remove-queued.trigger.json`, as the example then writes it |

**Rules**, in `packages/plugin-queue/test/rules.test.ts`, block `X401: a setting a worker cannot act on`: the three
values above each refused at `settings/deadlineMs` with its branch's message and hint; 1 and `TIMER_MAX_MS`
accepted.

**The worker**, in `packages/plugin-queue/test/worker.test.ts`, against the fake broker and the `Serving` of
`harness.ts`. The harness gains one way to answer: a run that waits until its signal aborts and then answers a
`cancelled` report, as the schedule's `untilCancelled` does (`packages/plugin-schedule/test/deadline.test.ts`). The
tests use Vitest's fake timers, so no test sleeps.

| What | Asserts |
|---|---|
| a run past its deadline is retried | `deadlineMs: 50`, a run that waits on its signal: the fire is handed a signal, it aborts at 50 ms, the broker is answered `retry` with `backoffMs`, and the line ends `cancelled (deadline))` |
| on the last attempt it is dead | the same on `attempt` equal to `maxAttempts`: `dead` |
| `onFault: dead` parks it at once | the same with `onFault: "dead"` on attempt 1: `dead` |
| a run in time is untouched | `deadlineMs: 50`, a run that answers at 10 ms: `ack`, and the timer is cleared (no abort after the answer) |
| no deadline, no signal | a trigger without `deadlineMs`: the fire is handed no `signal`, as today |
| a stop is bounded | a stop called while a run waits on its signal resolves once the deadline has cancelled it and the broker has been answered |

**Postgres**, in `packages/plugin-storage-postgres/test/broker.test.ts`, behind `WILANIS_TEST_POSTGRES_URL`: none of
its own. The worker test covers the deadline for every broker, and #914's tests cover the lock.

## Implementation plan

1. **The deadline** (`area:plugin-queue`, `area:runtime`). `deadlineMs` and the sentence in
   `queue.trigger-kind.json`; the timer and the signal in `deliver.ts`, and `cancelled (deadline)` in its line; the
   range in X401's `checkCounts`; the worker and rule tests above; the sabotage cases; `deadlineMs: 30000` on
   `example/features/customers/edge/remove-queued.trigger.json`; the README paragraph and rules row;
   `docs/refusals/X401.md`; the one sentence in `packages/plugin-storage-postgres/README.md`. One pull request. A
   `good first issue`: every piece has a sibling in `@schedule` or `@http` to copy.

## Drawbacks and alternatives

**Do nothing; teach the workaround.** The consumer's own plan is to bound each review by the timeouts its data graphs
set, and to raise `queueVisibility` to two hours. That bounds a call, not a run: a map of nested graphs, a retried call
or a native handler with no `timeoutMs` is still unbounded. It cannot free a slot on the memory broker, and since #914
it cannot free a message on Postgres either: a hung run's lock is extended for as long as the worker lives. And no document says what the whole run may take, which is the thing a
reader of the trigger wants to know. Rejected.

**A new word for a deadline's outcome (`onDeadline: retry | dead`).** A run that passes its deadline once may well pass
it again, so an author might want it parked while other faults are retried. Not taken now. A cancelled run is a fault
today (`decidedOf`), the issue asks for exactly that, and one word is enough until a tree needs two. `onDeadline`,
defaulting to `onFault`, can be added later with no document changing meaning. Always `dead` was also considered and
rejected: a deadline also strikes on an upstream that is slow for a minute, and a retry is the right answer there.
Decided: a cancelled run goes to `onFault`.

**A new code (`X407`) instead of widening X401.** X401 already means "a setting a worker cannot act on", and it
already judges the other two numbers of the same trigger. The http kind took a new code, X004, because no rule of its
own judged a range of a trigger setting; the schedule kind widened X251. One rule per kind of mistake is easier to
find. Decided: X401 widens.

**A deadline in the `@queue` plugin's settings, as the http kind has.** `limitsOf` would print it as
`(from @queue settings)` with no change. Not taken: each queue has one trigger (X406), so the trigger is already the
one place to say it, and the schedule kind has no plugin default either. It can be added later, compatibly.

**A deadline on the consume step.** One number per process, in `project.json`. Rejected: two queues of one process
need different bounds, and RFC 0012 put a run's bound on the document a reader opens first, the trigger.

**The embedder holds the timer.** RFC 0012 considered a kind naming a path into its settings and the embedder arming
the timer, and rejected it: "the embedder would then own a clock for a promise only the kind makes to its caller, and
the kind alone knows what to answer." Nothing here changes that: the queue kind alone knows that a cancelled run
becomes `onFault`.

**The broker locks for the deadline instead of renewing.** The worker could tell the broker the deadline, and the
Postgres broker could lock for that long. Rejected: a cancellation is cooperative, so a run can outlast its deadline by
as long as a handler ignores its signal; a trigger may have no deadline at all; and the `Broker` contract would grow a
parameter only one broker reads. Renewal (#914) fits every case, and it has landed.

**A rule that the deadline is below the window.** `@storage-postgres`'s `check` could refuse a queue trigger on one of
its connections whose `deadlineMs` is not below `queueVisibility`. Rejected: since #914 a live run keeps its lock, so
the relation means nothing.

**Cost.** One timer per delivery of a trigger with a deadline, cleared when the run answers. One more line in
`describe` for every queue trigger. The worker's ten timer lines repeat the http kind's `withDeadline` and the
schedule's `deadlineOf` in spirit (see *Open questions*).

## Open questions

Decided in review:

1. **What a cancelled run does to its message:** `onFault`, as `decidedOf` already does for a cancelled report.
   It is retried with backoff by default, dead on the last attempt, and dead at once under `"onFault": "dead"`. A
   separate `onDeadline` is not added (*Drawbacks*).
2. **Which rule:** X401 widens. There is no new code.
3. **The upper bound:** `TIMER_MAX_MS` (2147483647 ms), refused by X401's second branch. The worker does not cap the
   timer without a word.

To decide during implementation:

4. **Where the timer lives.** Three plugins now arm a deadline: `withDeadline` in `@http`, `deadlineOf` on the
   schedule's own clock, and this one. A plugin does not import another, so a shared helper would be a function in
   `@wilanis/core`. I lean to ten lines in `deliver.ts` now, and a shared helper only if a fourth kind needs one, since
   the schedule's version runs on a fake clock and the others do not.
5. **The example's number.** Under the `live` profile a removal calls `customers-api`, whose `timeoutMs` is 10 s
   (`example/connections/customers-api.connection.json`). `30000` lets a call or two time out on their own and still
   stops a run that hangs. The step may pick another number and say why in the trigger's description.
