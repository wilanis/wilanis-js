#!/usr/bin/env bash
# The Stop hook of an arena copy (provisional, wilanis-js#495): an agent cannot finish while `wilanis check`
# refuses the tree, or while the gate rejects the endpoint it wrote. Claude Code runs it with the tree as the
# working directory and the event's JSON on stdin, and reads one JSON object back: {"decision": "block",
# "reason": ...} keeps the agent working with the reason in front of it; anything else lets it stop.
# A counter under .wilanis/ caps the blocks at five, so an agent that cannot fix the tree can still hand it
# back and say so: the sixth stop is allowed, with the verdict attached.
set -uo pipefail
cd "$(dirname "$0")/../.."
cat > /dev/null   # the event; nothing in it decides anything here
CAP=5
COUNTER=.wilanis/arena-stop-blocks
mkdir -p .wilanis
n=$(cat "$COUNTER" 2>/dev/null || echo 0)

# Refuse the stop with a reason the agent reads, counting it.
block() {
  echo $((n + 1)) > "$COUNTER"
  node -e 'process.stdout.write(JSON.stringify({ decision: "block", reason: process.argv[1] }))' "$1"
  exit 0
}

# Allow the stop, saying why in a message the agent sees.
allow_saying() {
  node -e 'process.stdout.write(JSON.stringify({ systemMessage: process.argv[1] }))' "$1"
  exit 0
}

# Block, or allow once the cap is reached.
judge() { # judge <what failed> <detail>
  if [ "$n" -ge "$CAP" ]; then
    allow_saying "$1 after $CAP blocked stops; hand the tree back and say so in your report. $2"
  fi
  block "$1 (stop $((n + 1)) of $CAP blocked). Fix this before you finish:
$2"
}

# The one new trigger against the baseline commit, committed or not; its verb and route drive the gate.
new_trigger() {
  local base
  base=$(git rev-list --max-parents=0 HEAD 2>/dev/null) || return 1
  { git diff --name-only --diff-filter=A "$base"; git ls-files --others --exclude-standard; } | grep '\.trigger\.json$' | sort -u
}

CHECK=$(npx wilanis check . 2>&1)
if ! printf '%s' "$CHECK" | tail -1 | grep -q '^ok: '; then
  judge "wilanis check still refuses the tree" "$(printf '%s' "$CHECK" | tail -40)"
fi

TRIGGERS=$(new_trigger)
if [ "$(printf '%s\n' "$TRIGGERS" | grep -c .)" -ne 1 ]; then
  allow_saying "the tree checks; the gate was not run, since the diff against the baseline holds $(printf '%s\n' "$TRIGGERS" | grep -c .) new trigger(s) rather than one"
fi
METHOD=$(node -e 'try{const t=require("./"+process.argv[1]).settings||{};process.stdout.write(String(t.method||""))}catch(e){}' "$TRIGGERS")
ROUTE=$(node -e 'try{const t=require("./"+process.argv[1]).settings||{};process.stdout.write(String(t.route||""))}catch(e){}' "$TRIGGERS")
if [ -z "$METHOD" ] || [ -z "$ROUTE" ]; then
  allow_saying "the tree checks; the gate was not run, since $TRIGGERS names no settings.method and settings.route yet"
fi
GATE=$(bash accept.sh "$METHOD" "$ROUTE" 2>&1)
if printf '%s' "$GATE" | grep -q '^ACCEPTED'; then
  exit 0
fi
judge "accept.sh $METHOD '$ROUTE' rejects the work" "$(printf '%s' "$GATE" | grep -E '^(FAIL|      expected|      got|REJECTED)')"
