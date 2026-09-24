# wilanis

**A language for programs made of effects, written as JSON documents, with a compiler that judges the whole
tree before anything runs.** You describe the shapes, the contracts between the parts, how data flows through
them, what may enter and what gates it. The compiler reads every file and proves they fit together. A small
engine runs what it approved, and everything that touches the world (a route, a command, a clock, a file, a
database) is a plugin behind a port the tree declares. The language never learns what HTTP is.

The example in this repository is a customer registry: routes and commands over one port, customers kept per
tenant, CSV import and export, sign-in against two directories, sessions, and role-based policies over every write.
**Every one of its documents is JSON, and there is no JavaScript at all.** It is drawn, document by document,
at [wilanis.dev](https://wilanis.dev).

*Pre-1.0 and moving. Nothing is on npm yet, so clone and build to try it. See [Status](#status).*

## One port, two ways in

The domain of the example is a port, `customer.port.json`, and the operations it declares. How each is met is
a binding's business, chosen per profile, so the same documents run against memory, PostgreSQL or a fake. What
reaches an operation is a trigger, and a trigger is one file. Two of them, from the example:

```json
{
  "label": "GET /customers/{id}",
  "settings": {
    "route": "/customers/{id}",
    "method": "GET",
    "produces": "application/json",
    "deadlineMs": 2000,
    "response": {
      "refusals": {
        "missing": 404,
        "upstream": 502,
        "invariant": 500,
        "anonymous": 401,
        "invalid_credential": 401
      }
    }
  },
  "in": "@customers/edge/IdRequest.shape.json",
  "out": "@customers/edge/CustomerView.shape.json",
  "kind": "@http/http.trigger-kind.json",
  "policies": [
    {
      "policy": "@access/edge/signed-in.policy.json",
      "in": {
        "token": [
          "{{request.headers.authorization}}",
          "{{request.cookies.session}}"
        ]
      }
    }
  ],
  "fire": {
    "run": "@customers/domain/customer.port.json#get",
    "in": {
      "id": "{{request.params.id}}"
    }
  }
}
```

A GET on `/customers/{id}`, for a signed-in caller: `signed-in` is a policy of the included access tree, given
the token from the header or the session cookie. It takes an `IdRequest` and answers a `CustomerView`, both
declared in files of their own, and runs `get` with the id from the URL. When the operation refuses, the reason
becomes the status this file maps it to, and the checker refuses a mapping for a reason nothing behind the route
can produce. It answers only a customer of the caller's own tenant, and nothing in this file says so: the store
keeps its customers per tenant, and the compiler carries the tenant the sign-in wrote into the session to every
read of them.

```json
{
  "label": "digest",
  "kind": "@cli/cli.trigger-kind.json",
  "settings": {
    "command": "digest"
  },
  "out": "@customers/edge/DigestView.shape.json",
  "policies": [
    {
      "policy": "@access/edge/employees-only.policy.json",
      "in": {
        "token": "{{request.flags.token}}"
      }
    }
  ],
  "fire": {
    "run": "@customers/domain/customer.port.json#digest"
  }
}
```

`wilanis run @customers/edge/digest.trigger.json example --token=<an employee's access token>` prints the
digest: the count, and one line per customer of every tenant. It reads across tenants through a view the store
declares, and the view names the policy every trigger reaching it must attach.

Neither names a graph, and neither knows how `get` or `digest` is met. A trigger's kind is granted by a plugin
(`@http`, `@cli`, `@schedule`), the compiler judges the trigger's settings by what that kind declares, and the
engine sees a fired operation and nothing else. A queue or a file drop would be another kind from another
plugin, with no change to the port or to the language. `wilanis ls example trigger` lists every way into the
example, and `wilanis map example` draws what each one reaches.

## The compiler reads it first

Point the route at an operation the port does not have:

```
R001  @features/customers/edge/get-customer.trigger.json#fire/run
    port '@customers/domain/customer.port.json' has no operation 'fetch' (operations: listAll, listByTier, get, ...)
    → wilanis ls port
```

The file, the path inside it, what is wrong, and the command that shows the fix. Every reference, input,
output and effect is judged across the whole tree at once, not one file at a time. Every rule the checker
holds a tree to, and every code it refuses with, is in [`docs/model.md`](docs/model.md).

A rule an author states once is held the same way. The example gates every write with the registrar policy,
trigger by trigger, and nothing in those files says it is a rule rather than six coincidences: a new route
firing `update` and forgetting the policy would check clean, and the write would be public. An invariant says
the rule out loud, in a file of its own:

```json
{
  "label": "Writes are for registrars",
  "access": {
    "over": [
      "@customers/domain/customer.port.json#register",
      "@customers/domain/customer.port.json#update",
      "@customers/domain/customer.port.json#keep",
      "@customers/domain/customer.port.json#remove",
      "@customers/domain/customer.port.json#removeMany",
      "@customers/domain/customer.port.json#submit",
      "@customers/domain/customer.port.json#import"
    ],
    "requires": {
      "policy": "@access/edge/can-register.policy.json"
    }
  }
}
```

It names operations, never a role: what the gate decides is the policy's business. Drop the registrar policy
from `POST /customers.csv` and the tree no longer checks:

```
I001  @features/customers/edge/import-customers.trigger.json#policies
    trigger reaches @features/customers/domain/customer.port.json#import, which 'Writes are for registrars'
    (@features/customers/domain/writes-are-for-registrars.invariant.json) gates with
    @access/edge/can-register.policy.json, but attaches no such policy
    → attach "@access/edge/can-register.policy.json" under policies, or take
      @features/customers/domain/customer.port.json#import out of the invariant's over
```

Reaching is transitive, so the route that forgets the gate is caught whether it fires a covered operation
itself or a domain graph calls one two ports down. The route someone adds next year is held to the rule
nobody remembered to repeat.

## Every branch, before you ship

`wilanis rehearse` runs every trigger with the network stubbed and, for each switch, works out which inputs
reach each rule and runs that branch too. A rule no input can satisfy is reported as never run: dead logic,
or a hole in the routing, found without writing a test. `wilanis fuzz` writes runs out as scenarios and
`wilanis regress` replays them node by node, so an edit that changes what the tree does says so before it
ships. Every run leaves a complete record, and `--trace` says it out loud in the tree's own words: the paths in
a span are the paths in the documents. [`docs/demo.md`](docs/demo.md) is each of those commands with the
output it answered, and [wilanis.dev/demo/](https://wilanis.dev/demo/) is one such run, kept.

What happens when an effect fails for real is declared too, and checked. A port operation says whether calling
it again changes anything: `@http/http.port.json#request` is idempotent when its method is GET, HEAD, PUT or
DELETE. The data layer may then write `"retry": { "times": 2, "backoffMs": 200 }` and `"timeoutMs": 5000` on the
node that makes the call, and the compiler refuses the same retry on a POST (`G018`: a call that failed may have
been applied) and on any node of a domain graph (`L012`), which says what is done and never how often. A retry
repeats a fault or a timeout, never a refusal the graph decided, and the run's record shows one node with the
tries it took. And a data graph's switch may `catch` a node that broke: when the customer API answers nothing at
all, `get-row.graph.json` routes the fault to the `upstream` refusal its route already answers 502, instead
of a 500 that says only `fault`.

What happens when something hangs is written down as well. The route above gives up after two seconds
(`"deadlineMs": 2000`); every other route takes the minute and the megabyte `project.json` gives the http
plugin (`"deadlineMs": 60000`, `"maxBodyBytes": 1048576`). Past its deadline a run is cancelled: nothing more
starts, what is in flight is told to stop, and the caller gets a 504 rather than a half answer. A body past its
size is a 413 before it is parsed or stored. `DELETE /customers` takes at most a hundred ids
(`"maxItems": 100` on its body's shape, a 400 past that) and its domain graph removes them eight at a time
(`"limit": 100, "concurrency": 8` on the map), and the checker refuses a route anyone may call whose lists have
no most. Cancelling undoes nothing that already ran, and the run's record says how far it got; only a graph
marked atomic rolls back.

The clock is a way in as well. A trigger of kind `@schedule/schedule.trigger-kind.json` fires at every instant a
five-field `cron` expression names in its `timezone`, or at every multiple of an `everyMs` interval, into a domain
port operation like any route. The tick's instant reaches the graph as `request.scheduled`, a string read through
`fire.in`, so nothing in the tree calls a clock and a rehearsal runs a scheduled trigger's branches as it runs a
route's. It takes a `deadlineMs` as a route does, and a tick whose run passes it is cancelled and logged as such.
Nobody is calling on a tick, so the trigger gives the guard nothing: a policy that reads the caller is refused on
it (`A005`), and what a store keeps per tenant is out of its reach. The schedule runs only while
`project.json → startup` names `@schedule/scheduler.port.json#run`, as the port opens only while a step names
`listen`, and every process that names the step fires every tick, unless the step names a `lease` that lets one
instance of several take each tick. A step names the profiles it runs under, so the example schedules on the
laptop and, in production, in the one process started under `production-scheduler`, which opens no port, while the
instances under `production` only listen. The example names the step and writes no scheduled
trigger yet, so its schedule is empty; [`packages/plugin-schedule`](packages/plugin-schedule/README.md) says
what a trigger's settings may be and what the plugin refuses.

## Why this suits code a model writes

Every file has a schema, so a key is either allowed or refused and there is no free-form syntax to invent
into. `check` judges the whole tree and answers with a code, a file, a path inside it and a hint. A wrong
document is inert: it cannot open a socket or read the disk, and it can only reach the effects its feature
declares. Checking takes a second and needs no network.

The bet is that a model does not have to be large to work in a language like that. Proving it is a milestone
on the roadmap, not a claim we have measured: break the example, and repair it from `wilanis check --json`.

## Try it

The example talks to a public test API and needs no key. To read it without installing anything, open
[wilanis.dev](https://wilanis.dev) instead.

```
git clone https://github.com/wilanis/wilanis-js && cd wilanis-js
npm install && npm run build
npx wilanis check example          # is the tree consistent? (every profile at once)
npx wilanis rehearse example --profile local   # run every branch of every route and policy, network stubbed
npx wilanis map example            # how does a request flow, and what gates it?
npx wilanis-view example           # draw it, on http://127.0.0.1:4400/
export CUSTOMERS_JWT_SECRET=$(openssl rand -base64 32)
npx wilanis start example --profile local      # serve it on :8099, customers kept in memory
```

A profile is one place the tree runs. `npx wilanis start example` with no `--profile` runs `live`, the one
`project.json` marks `"default": true`: the customers through the test API, a reload on every saved document.
`--profile local` keeps them in memory and reaches no network; `WILANIS_PROFILE` names one too, and the flag
wins. `--profile production` is the deployment: the customers in PostgreSQL, one operator account standing in
for the laptop's employee directory, and no watcher, since the watch step names `live` and `local` and a step
without `profiles` runs everywhere. Nor does it schedule: `--profile production-scheduler` is the one process that
does, with production's bindings and no listener. Started without its variables, it prints `profile production` and then
every variable that profile reads and nobody set, with the document that reads it, before anything opens.

[`example/README.md`](example/README.md) walks through what it serves and who may do what.

## The rest

[`docs/model.md`](docs/model.md) is the reference: every document kind and what it means, every rule and its
refusal code, `project.json`, and what a tree starts. [`docs/compared.md`](docs/compared.md) says what wilanis
is not, against the frameworks, workflow engines and configuration languages it is taken for.
[`docs/roadmap.md`](docs/roadmap.md) is the plan, one demo per milestone, and each draws on RFCs under
[`docs/rfcs/`](docs/rfcs/README.md), written and accepted before anything is built.

The code is under [`packages/`](packages), one package per directory and a README in each, and
[`libraries/`](libraries) holds trees to include, pure JSON with tests of their own. Dependencies point one
way, engine to core to compiler to runtime, and a plugin depends on core and engine only; [`CLAUDE.md`](CLAUDE.md)
is the map. A project installs the runtime, the plugins it uses, and the trees it includes.

## Status

Pre-1.0. Everything above runs today. Nothing is published to npm yet, on purpose: 1.0 is cut once every
accepted RFC that changes a schema has landed or been withdrawn, so the schemas are final before they are
frozen.

## Contributing

[`CONTRIBUTING.md`](CONTRIBUTING.md) says how work flows, from an RFC to an issue to a pull request. Issues
labelled `good first issue` need no prior knowledge of the code. A plugin is the place to start if you want
to add something the language cannot say: an npm package that ships its ports and kinds as JSON documents and
implements one handler each. The checker holds it to what it declares.

## License

Apache-2.0. See [`LICENSE`](LICENSE).
