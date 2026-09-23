#!/usr/bin/env node
// The board sync, from a workflow or by hand:
//
//   node .github/board/board.mjs issue <n>...   one or more issues, and what depends on them
//   node .github/board/board.mjs pr <n>         the issues a pull request serves
//   node .github/board/board.mjs all            every open issue, and every issue closed in the last week
//
// `--dry` prints each write instead of making it.

import { branches, issues, project, servedBy } from './github.mjs';
import { cached, context, remember, syncIssue } from './sync.mjs';
import { claimOf } from './derive.mjs';

const [command, ...rest] = process.argv.slice(2);
const dry = rest.includes('--dry');
const numbers = rest.filter((a) => /^\d+$/.test(a)).map(Number);

async function run() {
  const [board, names] = await Promise.all([project(), branches()]);
  const ctx = context(board, names.map(claimOf).filter(Boolean), dry);
  if (command === 'issue') return syncWithDependents(ctx, numbers);
  if (command === 'pr') return syncPullRequest(ctx, numbers[0]);
  if (command === 'all') return syncAll(ctx);
  throw new Error(`unknown command '${command ?? ''}': say issue <n>..., pr <n> or all`);
}

/** Syncs the named issues, then the open ones whose block or RFC they are, once each. */
async function syncWithDependents(ctx, first) {
  const done = new Set();
  const queue = [...first];
  while (queue.length > 0) {
    const number = queue.shift();
    if (done.has(number)) continue;
    done.add(number);
    const issue = await cached(ctx, number);
    if (!issue) continue;
    const dependents = await syncIssue(ctx, issue);
    if (first.includes(number)) queue.push(...dependents);
  }
}

async function syncPullRequest(ctx, number) {
  const { branch, closes } = await servedBy(number);
  const claimed = claimOf(branch);
  await syncWithDependents(ctx, [...new Set([...closes, ...(claimed ? [claimed] : [])])]);
}

async function syncAll(ctx) {
  const week = new Date(Date.now() - 7 * 86400e3).toISOString().slice(0, 10);
  const all = [...(await issues('is:open')), ...(await issues(`is:closed closed:>=${week}`))];
  remember(ctx, all);
  for (const issue of all) await syncIssue(ctx, issue);
  console.log(`synced ${all.length} issues`);
}

run().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
