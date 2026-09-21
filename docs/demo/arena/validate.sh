#!/usr/bin/env bash
# The same nine curls against one finished tree, beside the gate: start it under the local profile, sign in,
# record one GET entry and one POST entry as bo, then the nine calls in the same order with the same bodies.
#
#   bash docs/demo/arena/validate.sh <tree> <METHOD> <ROUTE> <out.txt>
#
# ROUTE holds the literal {id}. The output is what the page shows, tokens masked. A tree that does not check
# does not start, and every curl below then answers [000].
set -uo pipefail
TREE=${1:?tree}; METHOD=${2:?METHOD}; ROUTE=${3:?ROUTE}; OUT=${4:?out.txt}
cd "$TREE"
PORT=$(node -e 'const p=require("./project.json");process.stdout.write(String(p.plugins.find(x=>x.use==="@http").settings.port))')
BASE=$(git rev-list --max-parents=0 HEAD)
H="http://localhost:$PORT"
LOG=$(mktemp -t validate)
: > "$OUT"
say() { printf '%s\n' "$*" | tee -a "$OUT"; }

# Stop whatever listens on this tree's port and nothing else: another copy's server is not ours to kill.
free_port() { for pid in $(lsof -ti tcp:"$PORT" 2>/dev/null); do kill "$pid" 2>/dev/null; done; sleep 1; }

# A token for one of the example's employees; sed rather than jq, as the prompt tells the agent.
tok() { curl -s -g -X POST "$H/api/v1/auth-employees" -H 'content-type: application/json' -d "{\"username\":\"$1\",\"password\":\"$1-pass\"}" | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p'; }

# One curl: the command shown with tokens masked, then the body and the status.
c() {
  local label=$1; shift
  local shown="$*"; shown=${shown//$BO/\$BO}; shown=${shown//$CY/\$CY}
  say "### $label"; say "\$ curl $shown"
  curl -s -g --max-time 10 -w '  [%{http_code}]' "$@" | tee -a "$OUT"; echo | tee -a "$OUT"
}

# ROUTE with {id} filled in.
R() { printf '%s' "$ROUTE" | sed "s/{id}/$1/"; }

say "## git churn"; git diff --shortstat "$BASE" | tee -a "$OUT"; git status --short | tee -a "$OUT"
say "## check"; npx wilanis check . 2>&1 | tail -3 | tee -a "$OUT"
say "## rehearse (tail)"; npx wilanis rehearse . --profile local 2>&1 | tail -6 | tee -a "$OUT"
say "## the new route in map"; npx wilanis map . --profile local 2>&1 | grep -A6 -i "toggl\|pin" | head -24 | tee -a "$OUT"

free_port
MONITOR_JWT_SECRET=arena-secret MONITOR_DATABASE_URL=postgres://unused npx wilanis start . --profile local > "$LOG" 2>&1 &
PID=$!
for i in $(seq 1 30); do grep -q "Listen: ok" "$LOG" && break; sleep 1; done
say "## start"; grep -E "startup|http: listening" "$LOG" | cut -c1-140 | tee -a "$OUT"
BO=$(tok bo); CY=$(tok cy)
# Signing in writes the session under .wilanis/ and the reload watcher sees it (wilanis-js#490): wait for both
# reloads, one per sign-in, before recording, or one empties the memory store under the curls below.
for i in $(seq 1 8); do [ "$(grep -c '^reload: [0-9]' "$LOG")" -ge 2 ] && break; sleep 1; done; sleep 1
say "## reload lines so far"; grep "^reload" "$LOG" | tee -a "$OUT"
GETID=$(curl -s -g -X POST "$H/monitor" -H "authorization: Bearer $BO" -H 'content-type: application/json' -d '{"url":"https://api.example.com/orders","method":"GET"}' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
POSTID=$(curl -s -g -X POST "$H/monitor" -H "authorization: Bearer $BO" -H 'content-type: application/json' -d '{"url":"https://api.example.com/orders","method":"POST"}' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
say "recorded GET entry $GETID and POST entry $POSTID as bo"
c "1 toggle a GET entry as bo (expect pinned true)"                 -X "$METHOD" "$H$(R "$GETID")" -H "authorization: Bearer $BO"
c "2 toggle it again as bo (expect pinned false)"                   -X "$METHOD" "$H$(R "$GETID")" -H "authorization: Bearer $BO"
c "3 read it back"                                                   "$H/monitor/$GETID"
c "4 toggle a POST entry as bo"                                      -X "$METHOD" "$H$(R "$POSTID")" -H "authorization: Bearer $BO"
c "5 read the POST entry back (was anything written?)"              "$H/monitor/$POSTID"
c "6 toggle as cy, a viewer without the recorder role"              -X "$METHOD" "$H$(R "$GETID")" -H "authorization: Bearer $CY"
c "7 toggle with no token"                                           -X "$METHOD" "$H$(R "$GETID")"
c "8 toggle an entry that does not exist"                            -X "$METHOD" "$H$(R nope)" -H "authorization: Bearer $BO"
c "9 list: which entries carry pinned now"                           "$H/monitor"
say "## log tail"; tail -12 "$LOG" | tee -a "$OUT"
kill $PID 2>/dev/null; wait $PID 2>/dev/null
say "## invariant files touched?"; git diff --name-only "$BASE" | grep -i invariant | tee -a "$OUT" || say "(no invariant file changed)"
