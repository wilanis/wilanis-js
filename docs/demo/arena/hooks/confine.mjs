#!/usr/bin/env node
// The PreToolUse hook of an arena copy: the agent acts inside its copy and nowhere else. Claude Code runs it
// with the copy as the working directory and the tool call's JSON on stdin, and reads one JSON object back;
// a `deny` refuses the call with a reason the agent sees. `bypassPermissions` skips the permission prompts,
// not the hooks, so this is what keeps a `cd <repository root> && npm test` from leaving the copy.
//
// Refused: a Bash command naming a path outside the copy (an absolute path under a home directory that is
// not the copy's, or a `cd` out of it), and a kill by name (`pkill`, `killall`), since three copies serve
// on one machine and a name matches all of them; a write or edit to a file outside the copy.
import { resolve } from 'node:path';

const root = process.cwd();
const HOME_LIKE = /(^|[\s=:'"(])(\/Users\/[^\s'"`;|&)]+|\/home\/[^\s'"`;|&)]+)/g;
const CD_OUT = /(^|[;&|]\s*|\bthen\s+|\bdo\s+)cd\s+(\.\.|\/|~)/m;
const KILL_BY_NAME = /(^|[\s;&|(])(pkill|killall)\b/;

/** Whether an absolute path lies inside the copy (its node_modules link included). */
function inside(path) {
  return path === root || path.startsWith(`${root}/`);
}

/** The reason a Bash command is refused, or null when it stays inside the copy. */
function judgeBash(command) {
  if (KILL_BY_NAME.test(command)) {
    return 'kill by port, never by name: other trees serve on this machine. Use kill $(lsof -ti tcp:<your port>)';
  }
  for (const match of command.matchAll(HOME_LIKE)) {
    if (!inside(match[2])) return `${match[2]} is outside your project at ${root}; work only inside it`;
  }
  const cd = command.match(CD_OUT);
  if (cd && !inside(resolveCd(cd[2], command))) return `cd out of ${root}: work only inside your project`;
  return null;
}

/** Where a `cd` lands, for the few forms the pattern accepts. */
function resolveCd(start, command) {
  if (start === '~') return process.env.HOME || '/';
  if (start === '..') return resolve(root, '..');
  const abs = command.match(/cd\s+(\/[^\s;&|)]*)/);
  return abs ? abs[1] : '/';
}

/** The reason a file tool call is refused, or null when the file is inside the copy. */
function judgeFile(input) {
  const path = input.file_path || input.notebook_path;
  if (!path) return null;
  const abs = resolve(root, path);
  return inside(abs) ? null : `${abs} is outside your project at ${root}; write only inside it`;
}

/** Read the event, judge the call, and answer Claude Code. */
function main(text) {
  const event = JSON.parse(text || '{}');
  const input = event.tool_input || {};
  const reason = event.tool_name === 'Bash' ? judgeBash(String(input.command || '')) : judgeFile(input);
  if (!reason) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
    }),
  );
}

let stdin = '';
process.stdin.on('data', (chunk) => {
  stdin += chunk;
});
process.stdin.on('end', () => main(stdin));
