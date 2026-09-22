# The arena: three agents, one gate

Three models are each given the same one-paragraph task in identical copies of the example, unsupervised:
add an operation that toggles the optional boolean `active` on a customer, expose it over HTTP, validate it with
curl. Beside the task sits an acceptance test the reviewer wrote first, `accept.sh`, and the agent is told its
work is done when the test prints ACCEPTED. When all three have stopped, the reviewer's steps run over each
finished tree and one page is written: what each tree says, what the reviewer noted, what it cost, the gate's
verdict, the same nine curls against each, every tool call, and each agent's own report.

[`index.html`](index.html) is the record of one complete run, committed as `docs/demo/index.html` is. The
first run, on 2026-09-21, produced four repository bugs (#489 to #492) and three template issues (#494, #495,
#496), two of which this harness carries provisionally as the skill and the Stop hook it plants; the point of
the harness is to run the same exercise again after those land, with one command, and compare. The committed
page was rendered from that first run's trees and transcripts with `render-from.sh`, since the run itself
predates the harness; its footer says so.

## Running it

It needs the workspace built, the `claude` CLI signed in, `curl`, `lsof`, `git`, `python3` (the standard
library only) and `node`; nothing is installed. From the repository root:

```
npm install && npm run build
bash docs/demo/arena/run.sh
```

That is the whole procedure: build, run, read the page. `run.sh` sets up three copies under
`docs/demo/arena/.runs/` (gitignored), runs the three models in parallel, reviews each, and writes
`docs/demo/arena/index.html`. Nothing varies between runs but the code under test and the date. Expect ten to
twenty minutes and, at list price, a few dollars per model.

The agent runs as `claude -p` with `--permission-mode bypassPermissions`: the copy is scratch, nothing it can
reach matters, and a permission prompt nobody answers would hang the run. `--setting-sources project` makes
the copy's own `.claude/settings.json` the only settings in force, so what the agent sees does not depend on
whose machine it runs on; a `~/.claude/CLAUDE.md`, if the machine has one, is still read, so keep that in
mind when comparing runs across machines. The transcript is what the CLI streams to stdout
(`--output-format stream-json --verbose`), one JSON object per line, the same shape as the session file it
keeps; it ends in a `result` line with the CLI's own cost, which the page shows beside the list-price figure.

## What each file is

| File | What it is |
| --- | --- |
| `run.sh` | The one command: `run-one.sh` for each of haiku, sonnet, opus in parallel, then `render.py`. |
| `run-one.sh <model>` | What `run.sh` is made of: `setup.sh`, the agent through `claude -p` in the copy, then `review.sh`. |
| `setup.sh <name> <port>` | One copy of `example/` under `.runs/<name>`: `node_modules` linked, the http port set, `wilanis init` run, the skill and the Stop hook planted, `accept.sh` copied, and one git commit as the baseline. |
| `accept.sh <METHOD> <ROUTE>` | The gate, committed into each copy. Criteria numbered, each printing PASS or FAIL with expected and actual, ending ACCEPTED or REJECTED (exit 0 or 1). Criterion 3 reports the access rule's `holds at N trigger(s)` without judging it. It kills only what listens on its own port. |
| `prompt.md` | The prompt as sent, with `<arena>`, `<model>` and `<port>` filled in by `run-one.sh` and nothing else varying between models. |
| `scenario.json` | The page's title, thesis, the invariant as the example ships it, and the paragraphs that introduce each section. |
| `review.sh <runs> <model>` | The reviewer's steps over one finished tree: `parse.py`, `facts.py` (which runs the gate again), `validate.sh`. |
| `parse.py <transcript> <tree> <out.json>` | The transcript to metrics and a timeline: wall clock, turns, tool calls by name, tokens by kind (each API message counted once), cost at list price from the one price table at the top of the file, check rounds and the codes seen, file rewrites, churn from git against the baseline. Writes the agent's final report beside the JSON. Reads the CLI's stream and the session-file spelling alike. |
| `facts.py <tree> <out.json> [gate.txt]` | What the reviewer read by hand the first time, derived from the tree: does it check, what the rehearsal says the rule holds at, the new trigger's verb, route, policies, refusal map and `out`, whether the access rule's `over` gained the fired operation and whether any invariant's `when` or `requires` changed, whether `CustomerView` gained `active`, which bindings meet the operation, files added and changed; and the gate's verdict, run again with the trigger's own verb and route. |
| `validate.sh <tree> <METHOD> <ROUTE> <out.txt>` | The same nine curls against each result: sign in, wait for the reload, register two customers, toggle, read back, refuse, list. |
| `render.py <runs> <out.html>` | One static page, inline CSS, dark mode, phone width, no script. |
| `tables.py` | The rows of the page's three tables: the facts, the reviewer's notes, the metrics. |
| `render-from.sh <dir> [out.html]` | The reviewer's steps and the page again from saved material (`<dir>/<model>/` trees and `<dir>/<model>.jsonl` transcripts), calling no model. |
| `notes.json` | Optional, reviewer-written: the judgements no script derives, one row each, rendered as a second table. It names the commit it was written for and is shown only while that is the commit on the page; after a rerun, rewrite it or delete it. |
| `skill/SKILL.md` | The graph-idiom skill of #494, planted in each copy's `.claude/skills/wilanis-graphs/` until `wilanis init` ships it. |
| `hooks/stop.sh` | The Stop hook of #495, planted in each copy's `.claude/hooks/` and named in its `.claude/settings.json` until `wilanis init` ships it: an agent cannot stop while `wilanis check` refuses or while the gate rejects; five blocks, then the stop is allowed with the verdict attached. It answers in every state: no new trigger yet, a trigger with no route yet, a tree that refuses, a gate that rejects. |
| `hooks/confine.mjs` | The PreToolUse hook that keeps the agent in its copy: a Bash command naming a path outside it, a `cd` out of it, a kill by name (`pkill`, `killall`), or a write to a file outside it is refused with a reason the agent reads. `bypassPermissions` skips the prompts, not the hooks. |
| `.gitignore` | `.runs/`. |

## Adding a criterion

A criterion is one `check` line in `accept.sh`: a number, what it asserts in words, what a pass looks like,
the actual output, and a grep pattern the output must match. Give it the next number, keep it about what the
endpoint does and never about how the tree is written, and make it print PASS or FAIL like the others. The
page shows the gate verbatim, so the words are what a reader sees. A new fact belongs in `facts.py` (derive it
from the tree, add a row in `render.py`'s `fact_rows`); a judgement only a reader can make belongs in
`notes.json`.

## What one run prints

`run.sh` prefixes each model's lines with its name; `run-one.sh` alone prints them bare. This is the proof run
of the harness, Haiku alone, which the reviewer stopped after 32 minutes and 266 tool calls while the agent was
still editing (so its verdict is the state of a half-finished tree, not a result to compare against the page):

```
haiku: setting up the copy on port 8111
haiku: the agent is working in docs/demo/arena/.runs/haiku
haiku: claude exited 143 (see docs/demo/arena/.runs/haiku.claude.log)
haiku: the agent stopped; reviewing
review haiku: parse
review haiku: facts and the gate
review haiku: the nine curls against POST /customers/{id}/active
review haiku: REJECTED  15 of 17 criteria fail
```

That run is where two of the hooks' rules come from: the agent ran `cd <repository root> && npm test` and
`pkill -f "npx wilanis start"`, both of which `confine.mjs` now refuses, and it saw the gate reject three
times (15, 15 and 3 of 17) and the Stop hook block four stops before it was killed. A "Stop hook error"
appeared once in its transcript, after the first block: the likeliest cause is the hook's 180 s budget of the
time, which a gate against a server that will not come up could exceed (30 s waiting for `Listen`, twelve
curls of 10 s each); the budget is now 300 s and every path of the hook answers with JSON.

## The confounds, and how the harness avoids them

**The reload a sign-in causes (#490).** Signing in writes the session under the tree's `.wilanis/`, the
reload watcher sees it, and the tree is reloaded with an empty memory store: every customer registered before the
reload lands is gone. `accept.sh` and `validate.sh` both sign in first, then wait for the `reload:` line in
the server's log before recording anything, and say so in a comment naming the issue. When #490 lands the wait
finds no line and times out harmlessly.

**Cross-copy interference.** Three trees serve at once on one machine, and an agent may leave its server
running. Every kill in every script is by port, `lsof -ti tcp:$PORT`, never by process name, so a copy stops
only what listens on its own port and another copy's server is never its to kill. The ports are fixed in
`run-one.sh`: 8111 haiku, 8112 sonnet, 8113 opus. The agent is held to the same rule: `confine.mjs` refuses
`pkill` and `killall`, the prompt says to kill by port, and the prompt itself goes to the CLI on stdin so no
process's command line carries its words for a kill by name to match.

**An agent leaving its copy.** `bypassPermissions` lets an agent run anything, and one did `cd` to the
repository root and run `npm test` there. `confine.mjs` refuses a Bash command that names a path outside the
copy or `cd`s out of it, and a write to a file outside it; the reason names the copy, so the agent reads where
it belongs. It is a rule over the command's text, not a sandbox: a path built at run time gets past it, which
is the known limit.
