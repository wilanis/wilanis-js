#!/usr/bin/env bash
# The reviewer's steps over one finished tree, the same for every model: reduce the transcript, derive the
# facts and run the gate again, then the nine curls. Writes <runs>/<model>.json, .report.md, .facts.json,
# .gate.txt and .validation.txt beside the tree at <runs>/<model> and the transcript at <runs>/<model>.jsonl.
#
#   bash docs/demo/arena/review.sh <runs-dir> <model>
set -euo pipefail
RUNS=$(cd "${1:?runs dir}" && pwd); MODEL=${2:?model}
HERE=$(cd "$(dirname "$0")" && pwd)
TREE=$RUNS/$MODEL

# Stop whatever listens on the tree's port, and nothing else, so the gate starts the tree afresh.
free_port() {
  local port
  port=$(node -e 'const p=require(process.argv[1]+"/project.json");process.stdout.write(String(p.plugins.find(x=>x.use==="@http").settings.port))' "$TREE")
  for pid in $(lsof -ti tcp:"$port" 2>/dev/null); do kill "$pid" 2>/dev/null || true; done
  sleep 1
}

echo "review $MODEL: parse"
python3 "$HERE/parse.py" "$RUNS/$MODEL.jsonl" "$TREE" "$RUNS/$MODEL.json" > /dev/null
echo "review $MODEL: facts and the gate"
free_port
python3 "$HERE/facts.py" "$TREE" "$RUNS/$MODEL.facts.json" "$RUNS/$MODEL.gate.txt" > /dev/null
METHOD=$(node -e 'const f=require(process.argv[1]);process.stdout.write(f.trigger.method||"POST")' "$RUNS/$MODEL.facts.json")
ROUTE=$(node -e 'const f=require(process.argv[1]);process.stdout.write(f.trigger.route||"/customers/{id}/active")' "$RUNS/$MODEL.facts.json")
echo "review $MODEL: the nine curls against $METHOD $ROUTE"
free_port
bash "$HERE/validate.sh" "$TREE" "$METHOD" "$ROUTE" "$RUNS/$MODEL.validation.txt" > /dev/null
free_port
grep -E '^(ACCEPTED|REJECTED)' "$RUNS/$MODEL.gate.txt" | sed "s/^/review $MODEL: /"
