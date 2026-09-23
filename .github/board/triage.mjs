#!/usr/bin/env node
// The monthly backlog triage: one issue, labelled `triage`, listing what the board cannot fix by itself. The
// sync keeps fields true; this asks a person the questions a field cannot answer (is this still wanted, is
// this claim still alive, may this milestone close). The previous month's issue is closed in favour of it.
//
//   node .github/board/triage.mjs [--dry]      --dry prints the body instead of opening the issue

import { needsTriage } from './derive.mjs';
import { issues, rest } from './github.mjs';

const DAY = 86400e3;
const dry = process.argv.includes('--dry');

const ago = (iso) => Math.floor((Date.now() - Date.parse(iso)) / DAY);
const line = (i, note) => `- [ ] #${i.number} ${note ?? ''}`.trimEnd();

/** The sections of the report, each a heading, what to decide, and the issues it holds. */
export function sections(open, closed, milestones) {
  const quiet = (i) => i.assignees.length > 0 && !i.pullRequests.some((p) => p.state === 'OPEN') && ago(i.updatedAt) >= 14;
  const stale = (from, to) => open.filter((i) => ago(i.updatedAt) >= from && ago(i.updatedAt) < to && !i.labels.includes('triage'));
  return [
    ['Needs a type or an area', 'Label it, or close it if it is not wanted.', open.filter(needsTriage).map((i) => line(i))],
    ['No update in 60 days or more', 'Close it, or say in a comment what it waits for.', stale(60, Infinity).map((i) => line(i, `(${ago(i.updatedAt)} days)`))],
    ['No update in 30 to 60 days', 'Still wanted? Still the right milestone?', stale(30, 60).map((i) => line(i, `(${ago(i.updatedAt)} days)`))],
    ['Claimed and quiet', 'Assigned, no open pull request, 14 days without an update: ask the assignee, or unassign it.', open.filter(quiet).map((i) => line(i, `@${i.assignees.join(' @')}`))],
    ['Ready, but blocked', 'Labelled status:ready while an issue it is blocked by is open: drop the label or the relationship.', open.filter((i) => i.labels.includes('status:ready') && i.openBlockers.length > 0).map((i) => line(i, `blocked by #${i.openBlockers.join(', #')}`))],
    ['RFC with every step closed', 'Mark it implemented and close the tracking issue once its demo runs by hand.', open.filter((i) => i.labels.includes('rfc') && i.labels.includes('status:accepted') && i.steps.length === 0 && i.stepsDone > 0).map((i) => line(i))],
    ['Closed, but not Done on the board', 'The sync missed it: run the board workflow on it.', closed.filter((i) => i.item && i.board.Status !== 'Done').map((i) => line(i, `(${i.board.Status ?? 'no status'})`))],
    ['Milestones', 'Close a milestone with nothing open once its demo runs; move or re-date one past due.', milestones],
  ];
}

/** The milestone lines: open ones with no open issue, and open ones past their due date. */
function milestoneLines(list) {
  const lines = [];
  for (const m of list) {
    if (m.open_issues === 0) lines.push(`- [ ] ${m.title}: nothing open, ${m.closed_issues} closed`);
    else if (m.due_on && Date.parse(m.due_on) < Date.now()) lines.push(`- [ ] ${m.title}: due ${m.due_on.slice(0, 10)}, ${m.open_issues} open`);
  }
  return lines;
}

function render(month, parts) {
  const body = [`The board's monthly triage for ${month}. Tick each line once it is decided; close this issue when every line is.`];
  for (const [heading, ask, lines] of parts) {
    body.push('', `### ${heading}`, '', lines.length ? `${ask}\n\n${lines.join('\n')}` : 'Nothing.');
  }
  return body.join('\n');
}

async function run() {
  const month = new Date().toISOString().slice(0, 7);
  const [open, closed, milestones] = await Promise.all([
    issues('is:open'),
    issues(`is:closed closed:>=${new Date(Date.now() - 45 * DAY).toISOString().slice(0, 10)}`),
    rest('GET', 'milestones?state=open&per_page=100'),
  ]);
  const body = render(month, sections(open, closed, milestoneLines(milestones)));
  if (dry) return console.log(body);
  const previous = open.filter((i) => i.labels.includes('triage'));
  const made = await rest('POST', 'issues', { title: `Backlog triage: ${month}`, body, labels: ['triage', 'maintenance', 'area:process'] });
  for (const old of previous) {
    await rest('POST', `issues/${old.number}/comments`, { body: `Superseded by #${made.number}; what is still open here is listed there again if it still holds.` });
    await rest('PATCH', `issues/${old.number}`, { state: 'closed', state_reason: 'completed' });
  }
  console.log(`opened #${made.number}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
