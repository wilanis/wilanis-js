// Brings one issue's board item and its relationships in line with what `derive.mjs` says of it. Only a
// difference is written, so a sync over an issue already in line makes no write at all. Relationships are
// only ever added: one a person removed by hand is not put back unless the body still states it.

import { areasOf, blockersIn, needsTriage, parentIn, statusOf, typeOf, waitingOf } from './derive.mjs';
import { graphql, issue as fetchIssue, labelId } from './github.mjs';

/** A context for a run: the project, the claimed issue numbers, a cache of issues, and whether to write. */
export function context(project, claims, dry) {
  return { project, claims: new Set(claims), dry, cache: new Map(), labels: new Map(), said: new Set() };
}

/** Keeps issues already read, so a relationship one sync adds is seen by the sync of the other end. */
export function remember(ctx, issues) {
  for (const issue of issues) ctx.cache.set(issue.number, issue);
}

/** The issue numbered `number`, read once per run; null for a pull request. */
export async function cached(ctx, number) {
  if (!ctx.cache.has(number)) ctx.cache.set(number, await fetchIssue(number));
  return ctx.cache.get(number);
}

async function write(ctx, what, query, variables) {
  console.log(`${ctx.dry ? 'would ' : ''}${what}`);
  if (ctx.dry) return;
  await graphql(query, variables);
  // GitHub's secondary limit counts writes per minute; a backfill makes hundreds, an event a handful.
  await new Promise((resolve) => setTimeout(resolve, 300));
}

/** Syncs one issue, and answers the issue numbers whose board depends on it and may have moved with it. */
export async function syncIssue(ctx, issue) {
  await linkIssue(ctx, issue);
  await placeIssue(ctx, issue);
  return [...issue.blocking, ...(issue.labels.includes('rfc') ? issue.steps : [])];
}

/** Adds the blocked-by relationships and the parent an open issue's body states and GitHub lacks. */
export async function linkIssue(ctx, issue) {
  if (issue.state !== 'OPEN') return;
  await linkBlockers(ctx, issue);
  await linkParent(ctx, issue);
}

/** Brings the issue's board item, type and triage label in line with what is derived from it. */
export async function placeIssue(ctx, issue) {
  const derived = { ...issue, claimed: ctx.claims.has(issue.number) };
  await placeItem(ctx, derived);
  await setType(ctx, derived);
  await setField(ctx, derived, 'Status', statusOf(derived));
  await setField(ctx, derived, 'Waiting on', waitingOf(derived));
  await setAreas(ctx, derived);
  await setTriage(ctx, derived);
}

async function linkBlockers(ctx, issue) {
  for (const [number, blocker] of blockersIn(issue.number, issue.body)) {
    const target = number === issue.number ? issue : await cached(ctx, number);
    const source = await cached(ctx, blocker);
    if (!target || !source || target.state !== 'OPEN' || source.state !== 'OPEN') continue;
    if (target.blockers.includes(blocker)) continue;
    await write(ctx, `link #${number} blocked by #${blocker}`, 'mutation($i:ID!,$b:ID!){ addBlockedBy(input:{issueId:$i,blockingIssueId:$b}){ clientMutationId } }', {
      i: target.id,
      b: source.id,
    });
    target.blockers.push(blocker);
    target.openBlockers.push(blocker);
  }
}

async function linkParent(ctx, issue) {
  const number = parentIn(issue.body);
  if (!number || issue.parent) return;
  const parent = await cached(ctx, number);
  if (!parent) return;
  await write(ctx, `make #${issue.number} a sub-issue of #${number}`, 'mutation($p:ID!,$s:ID!){ addSubIssue(input:{issueId:$p,subIssueId:$s}){ clientMutationId } }', {
    p: parent.id,
    s: issue.id,
  });
  issue.parent = { number, labels: parent.labels };
}

async function placeItem(ctx, issue) {
  if (issue.item) return;
  console.log(`${ctx.dry ? 'would ' : ''}add #${issue.number} to the project`);
  if (ctx.dry) return;
  const data = await graphql('mutation($p:ID!,$c:ID!){ addProjectV2ItemById(input:{projectId:$p,contentId:$c}){ item { id } } }', {
    p: ctx.project.id,
    c: issue.id,
  });
  issue.item = data.addProjectV2ItemById.item.id;
}

async function setType(ctx, issue) {
  const want = typeOf(issue.labels);
  if (!want || issue.issueType === want) return;
  const type = ctx.project.types[want];
  if (!type) return sayOnce(ctx, want, `the organization has no issue type ${want}: issues labelled for it keep theirs`);
  await write(ctx, `type #${issue.number} ${want}`, 'mutation($i:ID!,$t:ID!){ updateIssueIssueType(input:{issueId:$i,issueTypeId:$t}){ clientMutationId } }', {
    i: issue.id,
    t: type,
  });
}

async function setField(ctx, issue, name, want) {
  const field = ctx.project.fields[name];
  const have = issue.board[name] ?? null;
  if (!field || !issue.item || have === want) return;
  if (want === null) return clear(ctx, issue, field, `clear ${name} on #${issue.number}`);
  await write(ctx, `set ${name} of #${issue.number} to ${want}${have ? ` (was ${have})` : ''}`, SET, {
    p: ctx.project.id,
    i: issue.item,
    f: field.id,
    v: { singleSelectOptionId: field.options[want] },
  });
}

async function setAreas(ctx, issue) {
  const field = ctx.project.fields.Area;
  const want = areasOf(issue.labels);
  const have = issue.board.Area ?? [];
  if (!field || !issue.item || same(want, have)) return;
  if (want.length === 0) return clear(ctx, issue, field, `clear Area on #${issue.number}`);
  await write(ctx, `set Area of #${issue.number} to ${want.join(', ')}`, SET, {
    p: ctx.project.id,
    i: issue.item,
    f: field.id,
    v: { multiSelectOptionIds: want.map((a) => field.options[a]) },
  });
}

async function setTriage(ctx, issue) {
  const want = needsTriage(issue);
  if (want === issue.labels.includes('needs-triage')) return;
  if (!ctx.labels.has('needs-triage')) ctx.labels.set('needs-triage', await labelId('needs-triage'));
  const verb = want ? 'addLabelsToLabelable' : 'removeLabelsFromLabelable';
  await write(ctx, `${want ? 'add' : 'remove'} needs-triage on #${issue.number}`, `mutation($i:ID!,$l:[ID!]!){ ${verb}(input:{labelableId:$i,labelIds:$l}){ clientMutationId } }`, {
    i: issue.id,
    l: [ctx.labels.get('needs-triage')],
  });
}

const SET = 'mutation($p:ID!,$i:ID!,$f:ID!,$v:ProjectV2FieldValue!){ updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:$v}){ clientMutationId } }';

async function clear(ctx, issue, field, what) {
  await write(ctx, what, 'mutation($p:ID!,$i:ID!,$f:ID!){ clearProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f}){ clientMutationId } }', {
    p: ctx.project.id,
    i: issue.item,
    f: field.id,
  });
}

const same = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

function sayOnce(ctx, key, line) {
  if (ctx.said.has(key)) return;
  ctx.said.add(key);
  console.log(`note: ${line}`);
}
