# Roadmap

A milestone is a demo: something a person runs and sees that the example could not do before. The
GitHub milestones of `wilanis/wilanis-js` mirror this page, one per milestone heading -- *Unscheduled* and
*Process RFCs* are the two headings that are not milestones -- and the issues under each are
the RFCs it draws on and the tasks that build it. A milestone closes when its demo runs, by hand and in
the test suite. The RFCs themselves live in [`rfcs/`](rfcs/README.md); this page is the only place that
says which milestone shows which RFC.

The number is the order. A milestone appears after every milestone whose RFCs its own RFCs name under
*Depends on*, and among those free to start at the same time the smaller comes first, so that a milestone
is never begun on work that is not there yet. One milestone is worked at a time, and its GitHub milestone
carries the day it is due. Reordering the page means renumbering it and the GitHub milestones together.

Nothing on this roadmap needs a paid service. Every piece of infrastructure a demo needs runs on a local
Kubernetes cluster from an open-source chart the repository ships (see RFC 0024).

## M01 Customers kept in a store

Start the example and the customers keeps its customers in the storage plugin's memory engine instead of the
upstream API. Draws on RFC 0002 and the call-site rules of RFC 0003.

```
npx wilanis start example
curl -X POST :8099/customers -d '{...}'   # then GET /customers/{id} answers what you posted
npx wilanis describe @customers/data/customers.store.json
```

First because RFC 0002 depends on nothing and RFC 0004, RFC 0005, RFC 0015, RFC 0017, RFC 0021 and
RFC 0022 all depend on it.

## M02 Same tree, real database

Start the example under a production profile against PostgreSQL; the startup log shows the store prepared
before the port opens. Not one route, policy, shape, port or business graph changes between profiles: what a
profile swaps is which binding meets `customer.port.json`, and through it which connection the records live
behind. Draws on the PostgreSQL engine of RFC 0002 and `ensure` of RFC 0003.

```
export CUSTOMERS_DATABASE_URL=postgres://user:password@localhost:5432/customers
npx wilanis start example --profile production
startup 1/4 Prepare the customer store: ok
```

The step is the one `local` runs; what differs is the connection behind the store it prepares, so the first
start creates the table and the next creates nothing.

## M03 All or nothing

The CSV import records every row in one atomic graph, and a customer and the latest call of its method move
together in another. A bad row in the middle leaves nothing written; rehearsal prints the rolled-back
branch. Draws on RFC 0004.

Here because RFC 0004 depends on RFC 0002 alone, which M02 finished, so this is free to start; the
milestone that follows depends on nothing and is free to start at any time, so the smaller comes first.

## M04 See a request run

Start with `--trace` and every request prints its tree: gate, policies, graphs, effects, timings. The same
trace reaches a local Jaeger through the OpenTelemetry plugin. Draws on RFC 0006.

Here because RFC 0006 depends on nothing, and RFC 0024 under M11 depends on it.

## M05 Change the schema, get the plan

Add a field to the customer shape and `wilanis migrate` prints the migration, refusing the destructive
step until told. Draws on RFC 0017, which depends on RFC 0003 and nothing after it.

## M06 The checker knows the rule

An access invariant over every customers write and a field invariant on the customer shape. Removing a policy
from a route is a refusal; rehearsal reports each invariant as proved or guarded. Draws on RFC 0007.

## M07 Sign in on one instance, stay signed in on another

Two instances of the example share sessions and challenges through storage. Sign in on the first port,
call a gated route on the second. Draws on the auth half of RFC 0005.

## M08 Files in an object store

CSV upload and download run against MinIO, an object store speaking the S3 API, on the local cluster,
with nothing written to the instance's disk. Draws on the blob half of RFC 0005, after the port it
requires is in place under M07.

## M09 Fails well

Against a flaky fake upstream the trace shows retries honouring declared idempotency and timeouts; a long
run is cancelled and still answers a report. Draws on RFC 0011, RFC 0012 and RFC 0014.

## M10 Work off the request

A removal is done off the request by a worker fed from a queue, and a scheduled trigger fires on the clock.
`POST /customers/{id}/removal` answers 202 with the message's id, and `remove-queued.trigger.json` fires
`customer.port.json#remove` for each message, under the same policies as `DELETE /customers/{id}`. On the
laptop the process that listens works the queue, kept in the process; under production the queue is a table
beside the customers, the instances under `production` only listen, and processes of their own started under
`production-worker` consume it and open no port. `wilanis start` logs one line per delivery and what became
of the message, and the next tick of each scheduled trigger and one line per tick it fires. Draws on RFC 0009
and RFC 0010. Which job the example schedules is not yet chosen. This row named the digest, and the digest
reads the customers of every tenant: a tick has no caller for its tenant or its policy to be about, so the
example's nightly run of it was taken out, and its `Keep the schedule` step schedules nothing.

```
npx wilanis start example --profile local
curl -X POST :8099/customers/{id}/removal -H "authorization: Bearer $TOKEN"   # 202, the message's id
queue removals dc05cb59-… attempt 1 → ack (1ms, @customers/domain/customer.port.json#remove done)
```

After M09, not before it: RFC 0009 accepts after RFC 0011 and its step 1 lands before RFC 0009's step 2,
and RFC 0010's `deadlineMs` setting waits on RFC 0012's `FireArgs.signal`. Both are M09's RFCs. A worker in a
process apart from the listener is a startup step naming its profiles, which is RFC 0013's; that RFC is M11's
but is already implemented, so this milestone does not wait on M11.

## M11 Ship it

One command reads the manifest and writes the image recipe, the Compose file and the chart values: `docker
compose up` runs the example on a laptop, and the Helm chart stands the same tree up on a local `kind`
cluster. A tree that requires an effect the environment does not permit is refused before it listens.
Draws on RFC 0013, RFC 0016, RFC 0024 and RFC 0026.

```
npx wilanis-deploy example --profile production
scripts/cluster.sh up     # → http://localhost:8099/customers
```

RFC 0013 depends on RFC 0005, so this follows M07 and M08; RFC 0024 depends on RFC 0006, so it follows M04.

## M12 Tenants by construction

A second tenant in the example. Feeding the tenant field from the request body is a refusal with a hint.
Draws on RFC 0029, the `reads` header the store binds its scope with, and RFC 0015.

## M13 The agent fixes it

Break the example, run `wilanis check --json`, and a small model repairs it in a loop from the
diagnostics. Solved branches become committed scenarios. Draws on RFC 0018 and RFC 0019.

Neither RFC depends on another, so this could be worked at any point; it is here because the repair loop
is worth more the more refusals there are to repair.

## M14 1.0

Last on purpose: 1.0 is cut only when every accepted RFC that changes a schema has landed or been withdrawn,
so the schemas are final before they are frozen, and nothing is published to npm before that. Then: every
package on npm; in an empty directory, install, init, and an agent session produce a tree that passes check
and rehearse; the security model is published and the `schemas-v1` tag is cut. Draws on RFC 0008 and
RFC 0020, and on RFC 0034, the one word for what a kind hands, which must land before the schemas freeze, as must
RFC 0035, the whole record before the write, whose one schema change lets a port operation's `accepts` name a shape;
its rules correct the write graphs M06 demonstrated.

## Unscheduled

RFC 0021 (higher-level constructs), RFC 0022 (more storage engines), RFC 0023 (adapters), RFC 0025 (AI
model calls), RFC 0030 (the cache), RFC 0031 (intent triggers) and RFC 0032 (the site as a declared
input) each get a milestone with its own demo when someone picks them up. RFC 0032 waits on a consumer
rather than on work: the operation it was written for, RFC 0002's `raw`, is left out of that RFC on
purpose, and the next consumer is the fault message RFC 0019 asks for, under M13.

## Process RFCs

RFC 0001 (the RFC process), RFC 0027 (fitness functions) and RFC 0028 (the principles hold) change how
this repository works, not what a tree can say. They show in no demo, so they carry no milestone; their
tracking issues sit on the board with none, and RFC 0027 and RFC 0028 are implemented.
