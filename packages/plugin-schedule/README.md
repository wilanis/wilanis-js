# @wilanis/plugin-schedule

The `@schedule` plugin: a trigger fired by the clock. A cron expression or an interval in its settings, and
the same `fire` into a domain port operation every other trigger has.

```
npm install @wilanis/plugin-schedule
```

```json
{
  "plugins": [
    { "use": "@schedule", "from": "@wilanis/plugin-schedule" }
  ],
  "startup": [
    { "label": "Keep the schedule", "run": "@schedule/scheduler.port.json#run" },
    { "label": "Listen",            "run": "@http/server.port.json#listen" }
  ]
}
```

`run` is a `holds` operation: it starts something that outlives the run, so a project's `startup` list names
it and the runtime stops it when the process stops. Delete the step and no tick fires, exactly as deleting
`listen` closes the port.

## A scheduled trigger

```json
{
  "$schema": "https://raw.githubusercontent.com/wilanis/wilanis-js/main/packages/core/schemas/trigger.schema.json",
  "label": "nightly digest",
  "description": "At three in the morning, UTC, the digest.",
  "kind": "@schedule/schedule.trigger-kind.json",
  "settings": { "cron": "0 3 * * *", "timezone": "UTC" },
  "out": "@customers/edge/DigestView.shape.json",
  "fire": { "run": "@customers/domain/customer.port.json#digest" }
}
```

`cron` is five fields -- minute, hour, day-of-month, month, day-of-week -- with `*`, lists, ranges, steps,
and month and weekday names. The standard macros (`@daily` and its kin) are not accepted: write the five
fields. `everyMs` is the other way to say when, and its ticks are the multiples of the interval since the
Unix epoch, so every process names the same instants whatever time it started.

The context hands the graph three things, read like any input through `fire.in`:

| Read | What it is |
|---|---|
| `request.scheduled` | the tick's instant, ISO 8601 in UTC |
| `request.fired` | when this run began, later than `scheduled` when the process was busy |
| `request.missed` | ticks since the last run that were not fired |

Nothing in the tree calls a clock: time enters as a string, so `wilanis rehearse` and `wilanis run --seed`
replay a tick like any request.

**Nobody is calling.** A scheduled trigger gives the guard nothing, so it is public and a policy that reads
the caller is refused (A005). The answer is judged against `out` and logged; there is nobody to deliver it
to, and a refusal is logged with its reason rather than mapped to a status.

## A run that outlasts its interval

`overlap` says what a tick does when the previous tick's run is still going: `skip` (the default) drops it
and counts it in `missed`; `wait` fires it once that run ends, with one tick waiting at most; `concurrent`
fires it beside the running one. A tick that fell while no process ran is not fired unless `catchUp` says
so, and `catchUp` needs a lease, since without one nothing remembers what the last tick was.

`deadlineMs` is the most a tick's run may take, counted from the fire. When it passes, the run is cancelled
(RFC 0012): nothing more starts, what was in flight is told to stop, and the tick is logged
`→ cancelled (deadline)` once it has settled. An effect that already ran is not undone. Without a deadline a
run is never cut, so under `overlap: skip` a run that hangs makes every later tick a skip; a deadline is what
frees the schedule.

```json
{ "settings": { "cron": "0 3 * * *", "overlap": "skip", "deadlineMs": 600000 } }
```

A tick with much to do should publish rather than sweep: fire an operation whose graph publishes one message
per row and answers, and let a worker do the work at its pace.

## Several instances

Without a lease, every process that names the `run` step fires every tick. With one, the tick is held:

```json
{ "label": "Keep the schedule", "run": "@schedule/scheduler.port.json#run",
  "in": { "lease": "@connections/store.connection.json" } }
```

The connection's kind must declare `"leases": true`, and the plugin that grants that kind must have
registered a keeper (X254 refuses the rest). The hold is for *this tick of this trigger*: it is granted only
when no other process holds the trigger unexpired and no tick at or after this one has been recorded as
fired -- so a tick is taken once, by whichever process's clock reaches it first, and clocks a little apart do
not double it. A process killed mid-run neither marks nor releases, so its hold expires after `leaseTtlMs`
and the tick is run again by the next process to ask. That is the one case a tick runs twice, it is a crash,
and it is why the operation a schedule fires must be safe to repeat.

## What a lease keeper implements

A lease keeper is the plugin that granted a connection kind declaring `leases`. It implements one contract
for the connections of that kind and registers itself from its `postLoad`, exactly as a storage engine
registers with `@storage`:

```ts
import { leases, type Leases } from '@wilanis/plugin-schedule';

const keeper: Leases = {
  /** true when this process holds `name` for the tick `scheduled` until now + ttlMs, freshly or renewed. */
  async acquire(connection, name, scheduled, ttlMs) { /* ... */ },
  async release(connection, name) { /* ... */ },
  /** The tick last recorded as fired for `name`, ISO 8601, or nothing. */
  async lastFired(connection, name) { /* ... */ },
  async markFired(connection, name, scheduled) { /* ... */ },
};

export default {
  root: '@my-store',
  // ...
  async postLoad(ctx) {
    leases(ctx.env).register('@my-store/my.connection-kind.json', keeper);
  },
};
```

`acquire` answers **false** when another holder's hold has not expired, and also when a tick at or after
`scheduled` has already been marked fired -- that second rule is what makes a tick taken once however late a
clock asks for it. `markFired` records the tick whatever the run's status: a refusal is the tree's answer to
that tick, and a tick is not refired for one. The table is per environment, created on first use by
whichever side reaches it first, so plugin order in `project.json` cannot bite and a reload starts clean.

The plugin depends on `@wilanis/core` and `@wilanis/engine` only, and carries no external dependency: the
cron parser is its own, since the same parser judges an expression at check time and computes the next tick
at run time.

## What it refuses

| Code | When |
|---|---|
| X251 | a schedule that is not one: both `cron` and `everyMs` or neither, an expression that does not parse, an `everyMs` below 1000, a `timezone` beside an interval or one no runtime knows, a `deadlineMs` that is not a whole number of 1 or more; and the same for the plugin's own settings |
| X252 | an `in` with no `fire.in`: nothing arrives on a tick, so nothing would fill it |
| X253 | `catchUp` while no `run` step names a `lease`: nothing can remember the last tick |
| X254 | a `run` step's `lease` naming no connection, or one whose kind does not declare `leases` |

Apache-2.0.
