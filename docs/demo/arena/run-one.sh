#!/usr/bin/env bash
# One model through the whole exercise: a fresh copy, the agent in it through the Claude Code CLI, then the
# reviewer's steps. This is what run.sh is made of; run.sh runs it once per model, in parallel.
#
#   bash docs/demo/arena/run-one.sh <haiku|sonnet|opus>
#
# The agent runs as `claude -p` with `--permission-mode bypassPermissions`: the copy is scratch, nothing it
# can reach matters, and a prompt nobody answers would hang the run. `--setting-sources project` makes the
# copy's own .claude/settings.json (what wilanis init wrote, plus the Stop hook) the only settings in force,
# so a run does not depend on whose machine it is on. The transcript is what the CLI streams to stdout as
# `--output-format stream-json --verbose`: one JSON object per line, the same shape as the session file it
# keeps, ending in a `result` line with the CLI's own cost and duration; parse.py reads either.
set -euo pipefail
MODEL=${1:?model: haiku, sonnet or opus}
HERE=$(cd "$(dirname "$0")" && pwd)
RUNS=$HERE/.runs
case $MODEL in
  haiku) PORT=8111 ;;
  sonnet) PORT=8112 ;;
  opus) PORT=8113 ;;
  *) echo "run-one.sh: no port for model '$MODEL'; add one to the table" >&2; exit 2 ;;
esac

# The prompt as sent: prompt.md with the three placeholders filled, nothing else varying between models.
prompt() {
  sed -e "s|<arena>|$RUNS|g" -e "s|<model>|$MODEL|g" -e "s|<port>|$PORT|g" "$HERE/prompt.md"
}

# Stop whatever the agent left listening on its port, and nothing else.
free_port() {
  for pid in $(lsof -ti tcp:"$PORT" 2>/dev/null); do kill "$pid" 2>/dev/null || true; done
}

echo "$MODEL: setting up the copy on port $PORT"
bash "$HERE/setup.sh" "$MODEL" "$PORT" > "$RUNS/$MODEL.setup.log" 2>&1
echo "$MODEL: the agent is working in $RUNS/$MODEL"
# The prompt goes in on stdin, so the CLI's command line never carries its text: a kill by name matching a
# word of the prompt would otherwise find this process too.
(
  cd "$RUNS/$MODEL"
  prompt | claude -p --model "$MODEL" --permission-mode bypassPermissions --setting-sources project \
    --output-format stream-json --verbose > "$RUNS/$MODEL.jsonl" 2> "$RUNS/$MODEL.claude.log"
) || echo "$MODEL: claude exited $? (see $RUNS/$MODEL.claude.log)"
free_port
echo "$MODEL: the agent stopped; reviewing"
bash "$HERE/review.sh" "$RUNS" "$MODEL"
