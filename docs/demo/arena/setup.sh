#!/usr/bin/env bash
# One copy of the example for one model: the pinned field, its own port, what `wilanis init` writes, the
# graph-idiom skill, the Stop hook, the gate, and a git commit as the baseline every diff is measured against.
#
#   bash docs/demo/arena/setup.sh <name> <port>        writes docs/demo/arena/.runs/<name>
#
# Needs the workspace built (npm install && npm run build): the copy links the repository's node_modules.
set -euo pipefail
NAME=${1:?name}; PORT=${2:?port}
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
DIR=$HERE/.runs/$NAME

# Copy the example, leaving behind what is not a document: installed packages and the tree's working state.
copy_example() {
  rm -rf "$DIR"
  mkdir -p "$HERE/.runs"
  cp -R "$REPO/example" "$DIR"
  rm -rf "$DIR/node_modules" "$DIR/.wilanis" "$DIR/scenarios"
  ln -s "$REPO/node_modules" "$DIR/node_modules"
}

# The task's premise: Entry and the REST row carry an optional boolean `pinned`; the tree listens on its own port.
plant_pinned_and_port() {
  node -e '
const fs = require("fs");
const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const write = (p, d) => fs.writeFileSync(p, JSON.stringify(d, null, 2) + "\n");
const port = Number(process.argv[1]);
let d = read("features/monitor/domain/Entry.shape.json");
d.fields.pinned = { type: "boolean", required: false, description: "whether a reader pinned this entry to the top of the digest" };
write("features/monitor/domain/Entry.shape.json", d);
d = read("features/monitor/edge/EntryRow.shape.json");
d.fields.pinned = { type: "boolean", required: false };
write("features/monitor/edge/EntryRow.shape.json", d);
d = read("project.json");
d.plugins.find((p) => p.use === "@http").settings.port = port;
write("project.json", d);
fs.writeFileSync("README.md", fs.readFileSync("README.md", "utf8").split(":8099").join(":" + port));
' "$PORT"
}

# What an agent finds beside the documents: CLAUDE.md and the hooks `wilanis init` writes, then the skill and
# the Stop hook of this harness (issues #494 and #495, provisional until the runtime ships them), and the
# PreToolUse hook that keeps the agent inside its copy.
plant_agent_files() {
  npx wilanis init . > /dev/null
  mkdir -p .claude/skills/wilanis-graphs .claude/hooks
  cp "$HERE/skill/SKILL.md" .claude/skills/wilanis-graphs/SKILL.md
  cp "$HERE/hooks/stop.sh" .claude/hooks/stop.sh
  cp "$HERE/hooks/confine.mjs" .claude/hooks/confine.mjs
  node -e '
const fs = require("fs");
const s = JSON.parse(fs.readFileSync(".claude/settings.json", "utf8"));
s.hooks = s.hooks || {};
s.hooks.Stop = (s.hooks.Stop || []).concat([{ hooks: [{ type: "command", command: "bash .claude/hooks/stop.sh", timeout: 300 }] }]);
s.hooks.PreToolUse = (s.hooks.PreToolUse || []).concat([
  { matcher: "Bash|Edit|Write|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: "node .claude/hooks/confine.mjs" }] },
]);
fs.writeFileSync(".claude/settings.json", JSON.stringify(s, null, 2) + "\n");
'
}

# The baseline: one commit holding everything the agent starts from, so `git diff` against it is the agent's work.
commit_baseline() {
  printf 'node_modules\n.wilanis/\nscenarios/\n' > .gitignore
  git init -q
  git add -A
  git -c user.name=arena -c user.email=arena@example.invalid commit -q -m "The example, with a pinned flag on Entry, the agent files and the acceptance test"
}

copy_example
cd "$DIR"
plant_pinned_and_port
plant_agent_files
cp "$HERE/accept.sh" accept.sh
npx wilanis check .
commit_baseline
echo "baseline committed in $DIR on port $PORT"
