# The route written a year later

This is the demo as a script: one story, five beats, twenty minutes. The rule is
`features/monitor/domain/writes-are-for-recorders.invariant.json`, stated once. The protagonist is a new hire
who never read it and adds a write route. The compiler is the character who talks back, and the room wants
the new hire to get it wrong.

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
lives in a wiki page, a review checklist, or one senior engineer's head. It holds for a year, and then someone
who never read it adds a route, the reviewer is on holiday, and the write is public. This is a tree with that
rule in it, and it is a file.

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
npx wilanis describe @monitor/domain/writes-are-for-recorders.invariant.json .
```

```
access: every trigger reaching these domain operations is gated
    @monitor/domain/monitor.port.json#record
    @monitor/domain/monitor.port.json#update
    @monitor/domain/monitor.port.json#remove
    @monitor/domain/monitor.port.json#removeMany
    @monitor/domain/monitor.port.json#submit
    @monitor/domain/monitor.port.json#import
requires: attaches @access/edge/can-record.policy.json
reached by (every one met by @features/access/edge/can-record.policy.json):
    @features/monitor/edge/delete-entries.trigger.json  #remove (through #removeMany), #removeMany
    @features/monitor/edge/delete-entry.trigger.json  #remove
    @features/monitor/edge/import-entries.trigger.json  #record (through #submit), #submit (through #recordAll), #import
    @features/monitor/edge/record-entry.trigger.json  #record (through #submit), #submit
    @features/monitor/edge/update-entry.trigger.json  #update
```

**Point at.** `reached by (every one met by @features/access/edge/can-record.policy.json)`: five routes reach
a write today, and the rule names none of them. It names six operations and one policy, and the checker
works out who reaches what.

**If asked.** *"We have this. It is a middleware on the router."* A middleware is attached where someone
remembers to attach it, and the router does not know which handlers write. This file says which operations
are writes, and `reached by` is computed, not maintained: the sixth route will appear there on its own, or be
refused. The next beat is that route.

## 2. The new hire

**Say.** A year later. Someone joins, is asked for a way to archive an entry, and finds the `remove`
operation on the monitor port. They have not read the invariant. They have not read the wiki either, because
there is none: the rule is in the tree.

**Do.** Scaffold the route from the operation it fires, then check.

```
npx wilanis new trigger features/monitor/edge/archive-entry . \
  --run '@monitor/domain/monitor.port.json#remove' --kind '@http/http.trigger-kind.json'
npx wilanis check .
```

```
wrote features/monitor/edge/archive-entry.trigger.json
T002  @features/monitor/edge/archive-entry.trigger.json#in
    '@monitor/domain/monitor.port.json#remove' takes {id: string} but the trigger declares no in
    → declare in on the trigger; wilanis describe @monitor/domain/monitor.port.json#remove shows what it takes
T002  @features/monitor/edge/archive-entry.trigger.json#out
    '@monitor/domain/monitor.port.json#remove' answers @features/monitor/domain/Entry.shape.json but the trigger declares no out
    → declare out on the trigger, or fire an operation that answers nothing
T005  @features/monitor/edge/archive-entry.trigger.json#settings/response/refusals
    @features/monitor/data/delete-row.graph.json may refuse with reason 'missing', which settings.response.refusals does not map
    → add "missing" under settings.response.refusals: how this trigger answers that outcome
T005  @features/monitor/edge/archive-entry.trigger.json#settings/response/refusals
    @features/monitor/data/delete-row.graph.json may refuse with reason 'upstream', which settings.response.refusals does not map
    → add "upstream" under settings.response.refusals: how this trigger answers that outcome
T005  @features/monitor/edge/archive-entry.trigger.json#settings/response/refusals
    @features/monitor/data/kept-remove.graph.json may refuse with reason 'invariant', which settings.response.refusals does not map
    → add "invariant" under settings.response.refusals: how this trigger answers that outcome
I001  @features/monitor/edge/archive-entry.trigger.json#policies
    trigger reaches @features/monitor/domain/monitor.port.json#remove, which 'Writes are for recorders' (@features/monitor/domain/writes-are-for-recorders.invariant.json) gates with @access/edge/can-record.policy.json, but attaches no such policy
    → attach "@access/edge/can-record.policy.json" under policies, or take @features/monitor/domain/monitor.port.json#remove out of the invariant's over

6 refusal(s)
```

**Point at.** The last refusal. Read it aloud, whole, and land on its hint:

```
    → attach "@access/edge/can-record.policy.json" under policies, or take @features/monitor/domain/monitor.port.json#remove out of the invariant's over
```

The file written a minute ago, the rule it broke by its name, the file the rule lives in, and the two edits
that would fix it. Nothing has run. The other five say the route takes nothing, answers nothing, and has no
answer for three ways the operation behind it can end.

**If asked.** *"A linter would catch a missing decorator."* A linter reads the file it is given. This read
the route, the port it fires, the graphs bound to that port and the invariant, and said the graph behind
`remove` can refuse with `missing` before anyone wrote the route's response. `kept-remove` is the graph that
will run under this profile, two ports down from the file the new hire wrote.

## 3. Following the hints

**Say.** The new hire does what the first five hints say: declare what the route takes and answers, and map
the three reasons to statuses. They do not attach the policy yet, because they still do not know why.

**Do.** Paste the route with the shapes and the refusals filled in.

```
cp $DEMO/archive-entry.step2.trigger.json features/monitor/edge/archive-entry.trigger.json
npx wilanis check .
```

```
I001  @features/monitor/edge/archive-entry.trigger.json#policies
    trigger reaches @features/monitor/domain/monitor.port.json#remove, which 'Writes are for recorders' (@features/monitor/domain/writes-are-for-recorders.invariant.json) gates with @access/edge/can-record.policy.json, but attaches no such policy
    → attach "@access/edge/can-record.policy.json" under policies, or take @features/monitor/domain/monitor.port.json#remove out of the invariant's over

1 refusal(s)
```

One left. Now do exactly what it says, and no more: add this line to the file, under `out`.

```json
"policies": ["@access/edge/can-record.policy.json"],
```

```
npx wilanis check .
```

```
A005  @features/monitor/edge/archive-entry.trigger.json#policies/0
    policy '@features/access/edge/can-record.policy.json' reads request.principal, which the guard hands once it verified a token, but no attachment on this trigger gives one
    → write { "policy": "@access/edge/can-record.policy.json", "in": { "token": "{{request.headers.authorization}}" } } -- the read is where this kind hands the credential
T005  @features/monitor/edge/archive-entry.trigger.json#settings/response/refusals
    @features/access/domain/require-recorder.graph.json may refuse with reason 'forbidden', which settings.response.refusals does not map
    → add "forbidden" under settings.response.refusals: how this trigger answers that outcome
T005  @features/monitor/edge/archive-entry.trigger.json#settings/response/refusals
    @features/access/domain/require-recorder.graph.json may refuse with reason 'anonymous', which settings.response.refusals does not map
    → add "anonymous" under settings.response.refusals: how this trigger answers that outcome

3 refusal(s)
```

**Point at.** `A005 ... no attachment on this trigger gives one`, and the JSON in its hint. The policy decides
on who is calling, and nothing on this route hands the guard a token to find that out. The two T005 below it
are new because the route is new: a gated route can now end `forbidden` or `anonymous`, and the route has
to say what those are on the wire.

Paste the finished route: the policy given the token as the hint wrote it, and 403, 401, 401 for `forbidden`,
`anonymous` and `invalid_credential`.

```
cp $DEMO/archive-entry.step3.trigger.json features/monitor/edge/archive-entry.trigger.json
npx wilanis check .
```

```
ok: 186 documents
```

**If asked.** *"So the checker wanted the policy all along. Why not just add it for me?"* Because the second
half of the I001 hint is the other legal edit: take `remove` out of the invariant. Whether archiving is a
write for recorders is the team's decision, and the checker refuses to make it. What it does instead is
refuse to let it go unmade.

## 4. No test was written

**Say.** Nobody wrote a test for this route. The tree has a rehearsal: it runs every route, every policy and
every branch of every switch with the effects stubbed, and says whether each branch settled.

**Do.**

```
npx wilanis rehearse . --profile local
```

```
features/access/domain/require-recorder  switch 'decide'  3/3 branches
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

`holds at 6 trigger(s)`: it was five in beat 1. Then the map, which says how a request flows and what gates
it:

```
npx wilanis map . --profile local
```

<!-- #481: today map ignores --profile, printing all three bindings' graphs under #remove and ?? lines under
nested domain calls. This is the archive-entry block of a 2026-09-21 run with the two graphs local does not
bind left out; check it against the real output once #481 lands. -->

```
@features/monitor/edge/archive-entry.trigger.json  (@http/http.trigger-kind.json)
  gated by @features/access/edge/can-record.policy.json → @access/domain/access.port.json#requireRecorder  given token
  holds  @features/monitor/domain/writes-are-for-recorders.invariant.json  through @features/access/edge/can-record.policy.json
  @monitor/domain/monitor.port.json#remove
    @features/monitor/data/kept-remove.graph.json
      asked @storage/store.port.json#remove  (effect) → store @features/monitor/data/entries.store.json entries (remove)
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

**If asked.** *"Where is the role check? I want to read it."* One switch, in
`features/access/domain/require-recorder.graph.json`: `has(principal) && 'recorder' in principal.roles`. It
is the only place a condition can be written, and the rehearsal walked all three of its branches. The route
never saw the token: the guard verified it before any graph ran and handed `request.principal` to the policy.
No document in this tree validates a token, and no graph checks access.

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
sentence in the 500 is the tree's other invariant, `an-entry-names-a-call.invariant.json`, in its own words;
nobody wrote that message. Then open `features/monitor/domain/record-all.graph.json` and point at one line:

```json
"atomic": true,
```

One word. There is no transaction node, no begin, no commit, and no graph undoes by hand what it wrote. The
compiler refuses an atomic graph that could not be one transaction, so the word is checked, not trusted.

**If asked.** *"That is just a database transaction."* It is one, and the point is who opened it. The graph
says it is atomic; the compiler proved every effect it reaches sits on one connection that can roll back, and
would have refused the word otherwise. Under the `live` profile the same operation is bound to a graph
without the word, because an HTTP call to the upstream is not something a transaction can undo.

## Other closers

**The PostgreSQL swap.** `--profile production` binds the monitor port to a store in PostgreSQL; not one
route, policy, shape or business graph differs from `local`, and beat 1 judged it with everything else.
`npx wilanis migrate . --profile production` prints what the database would have to do and does nothing until
`--apply`. It needs a PostgreSQL to talk to, its URL in `MONITOR_DATABASE_URL`, and the walk in
[`example/README.md`](../example/README.md#changing-the-shape-and-the-plan-that-follows) as the script.

**The reload while serving.** With `start` still running, paste the beat-3 file back over the route
(`cp $DEMO/archive-entry.step2.trigger.json features/monitor/edge/archive-entry.trigger.json`): the log
prints `reload refused, still serving the last good tree:` followed by the I001 refusal, hint and all, while
`curl` keeps answering 401. Paste the finished file back and it prints `reload: 186 documents, serving the
new tree`. It needs nothing beyond what this script already runs, and answered exactly that on the day this
was written.

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
database URL is a placeholder and is never dialled: today `start` reads every profile's secrets before it
chooses one, so `local` asks for a URL it will not use. Issues #302, #303 and #304 change that so only the
secrets the chosen profile reads are asked for; when they land, the last two lines go.

The prepared files are `docs/demo/archive-entry.step2.trigger.json` and `.step3.trigger.json` (beat 3) and
`docs/demo/entries.bad.csv` (beat 5); each JSON file says in its `description` which beat pastes it.
