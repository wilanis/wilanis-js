// What the board says about an issue, derived from what the issue already carries: its labels, assignees,
// pull requests, parent and blocked-by relationships. Labels are the source; the project's fields are a view
// of them, so nothing here is written by hand and nothing here reads the project.

/** The label that names each Type, most specific first: the first an issue carries wins. */
export const TYPES = [
  ['rfc', 'RFC'],
  ['bug', 'Bug'],
  ['maintenance', 'Maintenance'],
  ['documentation', 'Documentation'],
  ['enhancement', 'Feature'],
  ['task', 'Task'],
];

/** The area label behind each Area option. An area label not named here is an area, but has no option. */
export const AREAS = {
  'area:core': 'Core',
  'area:compiler': 'Compiler',
  'area:runtime': 'Runtime',
  'area:engine': 'Engine',
  'area:view': 'View',
  'area:plugin-http': 'HTTP',
  'area:plugin-storage': 'Storage',
  'area:plugin-auth': 'Auth',
  'area:plugin-blob': 'Blob',
  'area:plugin-search': 'Search',
};

/** The label that says an issue waits on something outside the tree of issues. */
export const WAITING = {
  'waiting:decision': 'Decision',
  'waiting:schema': 'Schema approval',
  'waiting:dependency': 'Dependency',
};

/** The Type an issue's labels name, or null. */
export function typeOf(labels) {
  const hit = TYPES.find(([label]) => labels.includes(label));
  return hit ? hit[1] : null;
}

/** The Area options an issue's labels name, in the order of AREAS. */
export function areasOf(labels) {
  return Object.entries(AREAS)
    .filter(([label]) => labels.includes(label))
    .map(([, area]) => area);
}

/** What an open issue waits on, or null: a waiting label, then an open blocker, then an RFC not accepted. */
export function waitingOf(issue) {
  if (issue.state !== 'OPEN') return null;
  const labelled = Object.entries(WAITING).find(([label]) => issue.labels.includes(label));
  if (labelled) return labelled[1];
  if (issue.openBlockers.length > 0) return 'Issue';
  const parent = issue.parent;
  if (parent?.labels.includes('rfc') && !parent.labels.some((l) => l === 'status:accepted' || l === 'status:implemented')) {
    return 'RFC';
  }
  return null;
}

/** The Status an issue is in. An open pull request outranks a block: the work is already under review. */
export function statusOf(issue) {
  if (issue.state !== 'OPEN') return 'Done';
  const open = issue.pullRequests.filter((pr) => pr.state === 'OPEN');
  if (open.some((pr) => !pr.isDraft)) return 'In Review';
  if (waitingOf(issue)) return 'Blocked';
  if (open.length > 0 || issue.assignees.length > 0 || issue.claimed) return 'In Progress';
  if (issue.labels.includes('rfc')) return rfcStatusOf(issue);
  if (issue.labels.includes('status:ready')) return 'Ready';
  return 'Todo';
}

/** An RFC's tracking issue is in progress once it is accepted and one of its steps has closed. */
function rfcStatusOf(issue) {
  if (issue.labels.includes('status:accepted') && issue.stepsDone > 0) return 'In Progress';
  return 'Todo';
}

/** Whether an open issue lacks what triage needs to place it: a type label and an area label. */
export function needsTriage(issue) {
  if (issue.state !== 'OPEN') return false;
  if (!typeOf(issue.labels)) return true;
  return !issue.labels.some((l) => l.startsWith('area:'));
}

const numbers = (text) => [...text.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));

/**
 * The blocked-by pairs an issue's body states. A tracking issue's checklist says `- [ ] #X — ... *(needs #A,
 * #B)*`, so X is blocked by A and B; any other issue says `Needs #A and #B` in its notes, so it is.
 */
export function blockersIn(number, body) {
  const pairs = [];
  const lines = (body ?? '').split('\n');
  for (const line of lines) {
    const step = line.match(/^\s*- \[[ xX]\] #(\d+)\b.*?\*\(needs ([^)]*)\)\*/);
    if (step) for (const blocker of numbers(step[2])) pairs.push([Number(step[1]), blocker]);
  }
  for (const line of lines) {
    if (/^\s*- \[[ xX]\]/.test(line)) continue;
    const need = line.match(/\bneeds? ((?:#\d+(?:,\s*|\s+and\s+|\s*))+)/i);
    if (need) for (const blocker of numbers(need[1])) pairs.push([number, blocker]);
  }
  return pairs.filter(([issue, blocker]) => issue !== blocker);
}

/** The tracking issue a task's body names under "RFC and step", or null. */
export function parentIn(body) {
  const hit = (body ?? '').match(/###\s*RFC and step\s+#(\d+)/);
  return hit ? Number(hit[1]) : null;
}

/** The issue a branch named `<issue>-<short-title>` claims, or null. */
export function claimOf(branch) {
  const hit = branch.match(/^(\d+)-[a-z0-9-]+$/);
  return hit ? Number(hit[1]) : null;
}
