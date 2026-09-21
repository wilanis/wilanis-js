#!/usr/bin/env bash
# The whole exercise: three models, one prompt, one gate, one page. From the repository root, after
# `npm install && npm run build`:
#
#   bash docs/demo/arena/run.sh
#
# Each model gets a fresh copy of the example under docs/demo/arena/.runs/<model> on a port of its own and
# runs in parallel with the others (run-one.sh); when all three have stopped and been reviewed, render.py
# writes docs/demo/arena/index.html. Nothing varies between runs but the code under test and the date.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
RUNS=$HERE/.runs
MODELS="haiku sonnet opus"
mkdir -p "$RUNS"

# What the footer says about this run.
write_meta() {
  node -e '
const fs = require("fs");
const meta = { date: new Date().toISOString().slice(0, 10), commit: process.argv[2], models: process.argv[3].split(" "),
  how: "each model through `claude -p` with the default effort, one attempt each, no retries, the copy as the working directory" };
fs.writeFileSync(process.argv[1], JSON.stringify(meta, null, 1) + "\n");
' "$RUNS/meta.json" "$(git -C "$REPO" rev-parse --short HEAD)" "$MODELS"
}

# One model, its lines prefixed with its name, answering run-one.sh's status rather than sed's.
one() {
  bash "$HERE/run-one.sh" "$1" 2>&1 | sed "s/^/[$1] /"
  return "${PIPESTATUS[0]}"
}

write_meta
pids=()
for m in $MODELS; do
  one "$m" &
  pids+=($!)
done
status=0
for pid in "${pids[@]}"; do wait "$pid" || status=1; done
python3 "$HERE/render.py" "$RUNS" "$HERE/index.html"
exit $status
