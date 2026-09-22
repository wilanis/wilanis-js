# The route written a year later

This is the demo as a script: one story, five beats, twenty minutes. The rule is
`features/customers/domain/writes-are-for-registrars.invariant.json`, stated once. The protagonist is an agent
given a one-line task, *add a way to archive an entry*, that never read the rule. The compiler is the
character who talks back, and the room wants the agent to get it wrong.

[`docs/demo/index.html`](demo/index.html) is the record of one real run of this story, and
`node docs/demo/build.mjs` regenerates it: it copies the example, runs every step, asserts the payoff of each
and writes the page only when all of them hold. A failed assertion is the demo telling you it no longer plays.

Every beat has four parts. **Say** is what the presenter says. **Do** is one command, or one paste of a file
under [`docs/demo/`](demo/). **Point at** is the one line of output that pays the beat off. **If asked** is the
objection a developer in the room raises, and the answer. Every line of output below was pasted from a run
on 2026-09-21. It runs on a copy of the example under the `local` profile, so nothing reaches the network and
nothing is installed beyond this repository built. Before the room fills, from the repository root:

```
npm install && npm run build
bash docs/demo/reset.sh
```

The script prints a `cd` and four `export` lines; paste them into the terminal you will present from. `DEMO`
is where the prepared files live; [Reset](#reset) says the rest. Do not explain the language before beat 2
lands: the hints do the explaining.

## 1. The hook

**Say.** Every team has a rule like this one: every route that writes goes through the recorder check. It
lives in a wiki page, a review checklist, or one senior engineer's head, and it holds until someone who never
read it adds a route. Today that someone is an agent. It writes fast and plausibly; what it lacks is the rule
it never read and the consequence it cannot see. This is a tree with that rule in it, and it is a file.

**Do.** Before anything, the whole tree is judged.

```
npx wilanis check .
```

```
ok: 185 documents
```

Every one of the 185 is a JSON document; there is no JavaScript in the tree, and `check` judged every
profile at once. Open the viewer on the rule and search for *Writes are for recorders*:

```
npx wilanis-view .     # http://127.0.0.1:4400/
```

In the terminal, ask the tree what the rule reaches:

```
npx wilanis describe @customers/domain/writes-are-for-registrars.invariant.json .
```

```
access: every trigger reaching these domain operations is gated
    @customers/domain/customer.port.json#register
    @customers/domain/customer.port.json#update
    @customers/domain/customer.port.json#remove
    @customers/domain/customer.port.json#removeMany
    @customers/domain/customer.port.json#submit
    @customers/domain/customer.port.json#import
requires: attaches @access/edge/can-register.policy.json
reached by (every one met by @features/access/edge/can-register.policy.json):
    @features/customers/edge/delete-customers.trigger.json  #remove (through #removeMany), #removeMany
    @features/customers/edge/delete-customer.trigger.json  #remove
    @features/customers/edge/import-customers.trigger.json  #record (through #submit), #submit (through #recordAll), #import
    @features/customers/edge/register-customer.trigger.json  #record (through #submit), #submit
    @features/customers/edge/update-customer.trigger.json  #update
```

**Point at.** `reached by (every one met by @features/access/edge/can-register.policy.json)`: five routes reach
a write today, and the rule names none of them. It names six operations and one policy, and the checker
works out who reaches what.

**If asked.** *"We have this. It is a middleware on the router, and the agent's instructions say to use it."*
A middleware is attached where someone remembers to, and an agent remembers what is in its context. This
rule is in the tree, not the context, and `reached by` is computed, not maintained: the sixth route will
appear there on its own, or be refused. The next beat is that route.

## 2. The new hire

**Say.** A year later. An agent is given one line: add a way to archive an entry. It finds the `remove`
operation on the monitor port and scaffolds a route that fires it. It has not read the invariant, and
nothing asked it to.

**Do.** Scaffold the route from the operation it fires, then check.

```
npx wilanis new trigger features/customers/edge/archive-entry . \
  --run '@customers/domain/customer.port.json#remove' --kind '@http/http.trigger-kind.json'
npx wilanis check .
```

```
wrote features/customers/edge/archive-entry.trigger.json
T002  @features/customers/edge/archive-entry.trigger.json#in
    '@customers/domain/customer.port.json#remove' takes {id: string} but the trigger declares no in
    → declare in on the trigger; wilanis describe @customers/domain/customer.port.json#remove shows what it takes
T002  @features/customers/edge/archive-entry.trigger.json#out
    '@customers/domain/customer.port.json#remove' answers @features/customers/domain/Customer.shape.json but the trigger declares no out
    → declare out on the trigger, or fire an operation that answers nothing
T005  @features/customers/edge/archive-entry.trigger.json#settings/response/refusals
    @features/customers/data/delete-row.graph.json may refuse with reason 'missing', which settings.response.refusals does not map
    → add "missing" under settings.response.refusals: how this trigger answers that outcome
T005  @features/customers/edge/archive-entry.trigger.json#settings/response/refusals
    @features/customers/data/delete-row.graph.json may refuse with reason 'upstream', which settings.response.refusals does not map
    → add "upstream" under settings.response.refusals: how this trigger answers that outcome
T005  @features/customers/edge/archive-entry.trigger.json#settings/response/refusals
    @features/customers/data/kept-remove.graph.json may refuse with reason 'invariant', which settings.response.refusals does not map
    → add "invariant" under settings.response.refusals: how this trigger answers that outcome
I001  @features/customers/edge/archive-entry.trigger.json#policies
    trigger reaches @features/customers/domain/customer.port.json#remove, which 'Writes are for recorders' (@features/customers/domain/writes-are-for-registrars.invariant.json) gates with @access/edge/can-register.policy.json, but attaches no such policy
    → attach "@access/edge/can-register.policy.json" under policies, or take @features/customers/domain/customer.port.json#remove out of the invariant's over

6 refusal(s)
```

**Point at.** The last refusal. Read it aloud, whole, and land on its hint:

```
    → attach "@access/edge/can-register.policy.json" under policies, or take @features/customers/domain/customer.port.json#remove out of the invariant's over
```

The file the agent wrote a second ago, the rule it broke by its label, the file the rule lives in, and the
two edits that would fix it. Nothing has run. Each of the six has a stable code, the file, the path inside it
(`#in`, `#policies`, `#settings/response/refusals`) and a hint that is an edit: an agent's whole loop, write, check, edit.

**If asked.** *"The agent should have read the invariant first."* It would have, had it known there was one
to read. Instead the checker read the route, the port it fires, the graphs bound to that port and the
invariant, and told the agent about the rule in the one place it was going to look: the output of the
command it runs after every edit. `kept-remove` is the graph two ports down that will run under this profile.

## 3. Following the hints

**Say.** The agent does what the first five hints say: declare what the route takes and answers, and map the
three reasons to statuses. It leaves the policy alone, since nothing yet told it why.

**Do.** Paste the route with the shapes and the refusals filled in.

```
cp $DEMO/archive-entry.step2.trigger.json features/customers/edge/archive-entry.trigger.json
npx wilanis check .
```

```
I001  @features/customers/edge/archive-entry.trigger.json#policies
    trigger reaches @features/customers/domain/customer.port.json#remove, which 'Writes are for recorders' (@features/customers/domain/writes-are-for-registrars.invariant.json) gates with @access/edge/can-register.policy.json, but attaches no such policy
    → attach "@access/edge/can-register.policy.json" under policies, or take @features/customers/domain/customer.port.json#remove out of the invariant's over

1 refusal(s)
```

One round took five refusals to zero. Now the agent does exactly what the last one says, and no more:

```json
"policies": ["@access/edge/can-register.policy.json"],
```

```
npx wilanis check .
```

```
A005  @features/customers/edge/archive-entry.trigger.json#policies/0
    policy '@features/access/edge/can-register.policy.json' reads request.principal, which the guard hands once it verified a token, but no attachment on this trigger gives one
    → write { "policy": "@access/edge/can-register.policy.json", "in": { "token": "{{request.headers.authorization}}" } } -- the read is where this kind hands the credential
T005  @features/customers/edge/archive-entry.trigger.json#settings/response/refusals
    @features/access/domain/require-registrar.graph.json may refuse with reason 'forbidden', which settings.response.refusals does not map
    → add "forbidden" under settings.response.refusals: how this trigger answers that outcome
T005  @features/customers/edge/archive-entry.trigger.json#settings/response/refusals
    @features/access/domain/require-registrar.graph.json may refuse with reason 'anonymous', which settings.response.refusals does not map
    → add "anonymous" under settings.response.refusals: how this trigger answers that outcome

3 refusal(s)
```

**Point at.** `A005 ... no attachment on this trigger gives one`, and the JSON in its hint. Fixing one refusal
surfaced three the agent could not have seen: the policy decides on who is calling, and nothing on this route
hands the guard a token; and a gated route can now end `forbidden` or `anonymous`, which the route has to
map. A rule catching a route is a conversation, and every turn of it is an edit.

Paste the finished route: the policy given the token as the hint wrote it, and 403, 401, 401 for `forbidden`,
`anonymous` and `invalid_credential`.

```
cp $DEMO/archive-entry.step3.trigger.json features/customers/edge/archive-entry.trigger.json
npx wilanis check .
```

```
ok: 186 documents
```

Three rounds of write, check, edit, and the agent read no manual.

**If asked.** *"So the checker wanted the policy all along. Why not just add it for me?"* Because the second
half of the I001 hint is the other legal edit: take `remove` out of the invariant. Whether archiving is a
write for recorders is the team's decision, and the checker refuses to make it or to let it go unmade. The
invariant is the one sentence the human wrote that the agent cannot talk its way past: however it phrased
the route, the route reached `remove`, and every way to `remove` is gated or refused.

## 4. No test was written

**Say.** The agent wrote no test for this route. The tree has a rehearsal: it runs every route, every policy
and every branch of every switch with the effects stubbed, and says whether each branch settled.

**Do.**

```
npx wilanis rehearse . --profile local
```

```
features/access/domain/require-registrar  switch 'decide'  3/3 branches
  ok  when has(principal) && 'recorder' in principal.roles  answered from 'granted'
  ok  when has(principal)                                   refused on purpose at 'forbidden' as forbidden: "recording entries takes the recorder role"
  ok  anything else                                         refused on purpose at 'anonymous' as anonymous: "sign in first: no token was presented"
```

```
every branch settled -- 44 branch(es), 20 decision(s), 16 graph(s).
3 invariant(s) declared:
  The session is the caller's  holds at 3 trigger(s)
  An entry names a call  proved at 0 site(s), guarded at 13
  Writes are for recorders  holds at 6 trigger(s)
```

This is the test suite the agent did not write. `holds at 6 trigger(s)`: it was five in beat 1. Then the map,
which says how a request flows and what gates it:

```
npx wilanis map . --profile local
```

<!-- #481: today map ignores --profile, printing all three bindings' graphs under #remove and ?? lines under
nested domain calls. This is the archive-entry block of a 2026-09-21 run with the two graphs local does not
bind left out; check it against the real output once #481 lands. -->

```
@features/customers/edge/archive-entry.trigger.json  (@http/http.trigger-kind.json)
  gated by @features/access/edge/can-register.policy.json → @access/domain/access.port.json#requireRecorder  given token
  holds  @features/customers/domain/writes-are-for-registrars.invariant.json  through @features/access/edge/can-register.policy.json
  @customers/domain/customer.port.json#remove
    @features/customers/data/kept-remove.graph.json
      asked @storage/store.port.json#remove  (effect) → store @features/customers/data/customers.store.json entries (remove)
      route [switch → row | missing]
      row @std/object.port.json#make
      missing @std/outcome.port.json#refuse
```

Now serve it. The tree signs its own tokens, and the key it signs them with is the one secret it reads from
the environment; `reset.sh` generated it, and it is the only thing this demo needs from outside the tree.

```
npm run start -- --profile local
```

It ends with `startup 7/7 Listen: ok`. In a second terminal, three calls. No token:

```
curl -s -X POST localhost:8099/monitor/x/archive -w '  [%{http_code}]\n'
```

```
{"reason":"anonymous","message":"sign in first: no token was presented"}  [401]
```

Sign in as cy, who holds the `viewer` group and not `recorder`:

```
TOKEN=$(curl -s -X POST localhost:8099/api/v1/auth-employees -H 'content-type: application/json' \
  -d '{"username":"cy","password":"cy-pass"}' | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')
curl -s -X POST localhost:8099/monitor/x/archive -H "authorization: Bearer $TOKEN" -w '  [%{http_code}]\n'
```

```
{"reason":"forbidden","message":"recording entries takes the recorder role"}  [403]
```

Sign in as bo, a recorder; record an entry, then archive it:

```
TOKEN=$(curl -s -X POST localhost:8099/api/v1/auth-employees -H 'content-type: application/json' \
  -d '{"username":"bo","password":"bo-pass"}' | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')
curl -s -X POST localhost:8099/monitor -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"url":"https://api.example.com/orders","method":"GET"}' -w '  [%{http_code}]\n'
ID=$(curl -s localhost:8099/monitor | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
curl -s -X POST localhost:8099/monitor/$ID/archive -H "authorization: Bearer $TOKEN" -w '  [%{http_code}]\n'
```

```
{"id":"fc750b72-6980-4223-af3e-c129dbfb3220","url":"https://api.example.com/orders","method":"GET","agent":"wilanis-example/0.1.0"}  [201]
{"id":"fc750b72-6980-4223-af3e-c129dbfb3220","url":"https://api.example.com/orders","method":"GET","agent":"wilanis-example/0.1.0"}  [200]
```

**Point at.** The rehearsal's second line and the live 403, side by side:

```
  ok  when has(principal)  refused on purpose at 'forbidden' as forbidden: "recording entries takes the recorder role"
{"reason":"forbidden","message":"recording entries takes the recorder role"}  [403]
```

The same branch, the same sentence. The rehearsal ran it with the effects stubbed before the server was up;
the route mapped the reason to 403 in beat 3; the guard, the policy and the graph did the rest.

**If asked.** *"Where is the role check? I want to read what the agent wrote."* The agent wrote none. One
switch, in `features/access/domain/require-registrar.graph.json`: `has(principal) && 'recorder' in
principal.roles`, the only place a condition can be written, and the rehearsal walked all three branches.
The route never saw the token: the guard verified it before any graph ran and handed `request.principal` to
the policy. No document validates a token and no graph checks access, so an agent cannot get that wrong.

## 5. The closer: all of it or none of it

**Say.** One more thing this tree says once. `POST /monitor.csv` records a file of entries. Here is a file
whose fifth row is not an entry: the URL is empty.

```
cat $DEMO/entries.bad.csv
```

```
url,method
https://api.example.com/orders,GET
https://api.example.com/orders,POST
https://api.example.com/orders/7,PUT
https://api.example.com/customers,GET
,DELETE
```

**Do.** With bo's token from the last beat:

```
curl -s -X POST localhost:8099/monitor.csv -H 'content-type: text/csv' -H "authorization: Bearer $TOKEN" \
  --data-binary @$DEMO/entries.bad.csv -w '  [%{http_code}]\n'
curl -s localhost:8099/monitor -w '  [%{http_code}]\n'
```

```
{"reason":"invariant","message":"'An entry names a call' does not hold: len(url) > 0 && (method != 'DELETE' || has(agent))"}  [500]
[]  [200]
```

**Point at.** `[]`. Four good rows went in before the fifth refused, and the store holds none of them. The
sentence in the 500 is the tree's other invariant, `a-customer-is-reachable.invariant.json`, in its own words;
nobody wrote that message. Then open `features/customers/domain/register-all.graph.json` and point at one line:

```json
"atomic": true,
```

One word. There is no transaction node, no begin, no commit, and no graph undoes by hand what it wrote. The
compiler refuses an atomic graph that could not be one transaction, so the word is checked, not trusted.

**If asked.** *"That is just a database transaction."* It is one, and the point is who opened it. The graph
says it is atomic; the compiler proved every effect it reaches sits on one connection that can roll back, and
would have refused the word otherwise, so an agent that writes it gets the promise or a refusal, never a
half-written store. Under `live` the same operation is bound to a graph without the word: an HTTP call is not something a transaction can undo.

## Other closers

**The PostgreSQL swap.** `--profile production` binds the monitor port to a store in PostgreSQL; not one
route, policy, shape or business graph differs from `local`, and beat 1 judged it with everything else.
`npx wilanis migrate . --profile production` prints what the database would have to do and does nothing until
`--apply`. It needs a PostgreSQL, its URL in `MONITOR_DATABASE_URL`, and [`example/README.md`](../example/README.md#changing-the-shape-and-the-plan-that-follows) as the script.

**The edit that never reaches the serving tree.** With `start` still running, paste the beat-3 file back
over the route (`cp $DEMO/archive-entry.step2.trigger.json features/customers/edge/archive-entry.trigger.json`):
the log prints `reload refused, still serving the last good tree:` with the I001 refusal, hint and all, while
`curl` keeps answering 401, so an agent editing a live tree cannot make the write public for one request.
Paste the finished file back and it prints `reload: 186 documents, serving the new tree`. It needs nothing
beyond what this script already runs; `build.mjs` runs it as its last step.

## Reset

`docs/demo/reset.sh` copies the example to `${1:-$TMPDIR/wilanis-demo}`, replacing what is there, links the
repository's `node_modules` into it, and prints the lines to paste:

```
bash docs/demo/reset.sh /tmp/wilanis-demo
```

```
# the example, copied to /tmp/wilanis-demo; its node_modules link to /Users/you/wilanis-js
cd /tmp/wilanis-demo
export DEMO=/Users/you/wilanis-js/docs/demo
export MONITOR_JWT_SECRET=PNa6n0D3hZ87EO9x60t+aGb7CeEowsPbzyL/EtFNT0Y=
# until #304 lands, start reads every profile's secrets although local never reaches PostgreSQL
export MONITOR_DATABASE_URL=postgres://unused
```

The JWT secret is what the tree signs its tokens with, generated fresh each run with `openssl rand`. The
database URL is a placeholder, never dialled: today `start` reads every profile's secrets before it chooses
one, so `local` asks for a URL it will not use. #302, #303 and #304 change that; when they land, the last two lines go.

The prepared files are `docs/demo/archive-entry.step2.trigger.json` and `.step3.trigger.json` (beat 3) and
`docs/demo/entries.bad.csv` (beat 5); each JSON file says in its `description` which beat pastes it.
