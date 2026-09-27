import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cached, context, linkIssue } from './sync.mjs';

// The sync against a GitHub faked at `fetch`: nothing here reaches the network, and a dry context writes nothing.
process.env.GH_TOKEN = 'not-a-token';

const node = (number, over = {}) => ({
  id: `I_${number}`,
  number,
  state: 'OPEN',
  title: `issue ${number}`,
  body: '',
  updatedAt: '2026-09-27T00:00:00Z',
  labels: { nodes: [] },
  assignees: { nodes: [] },
  issueType: null,
  milestone: null,
  parent: null,
  blockedBy: { nodes: [] },
  blocking: { nodes: [] },
  subIssues: { nodes: [] },
  subIssuesSummary: { completed: 0, total: 0 },
  closedByPullRequestsReferences: { nodes: [] },
  projectItems: { nodes: [] },
  ...over,
});

// What GitHub answers `repository.issue(number:)` for a pull request's number, and for one never used.
const notFound = (n) => ({
  data: { repository: { issue: null } },
  errors: [{ type: 'NOT_FOUND', path: ['repository', 'issue'], message: `Could not resolve to an Issue with the number of ${n}.` }],
});

/** A fetch that answers each issue read with `answer(number)`, and refuses any other request. */
const answering = (answer) => async (_url, request) => {
  const { query, variables } = JSON.parse(request.body);
  if (!query.includes('issue(number:$n)')) throw new Error(`the fake GitHub answers issue reads only, not ${query}`);
  return { ok: true, status: 200, json: async () => answer(variables.n) };
};

/** A GitHub that holds `issues` and nothing else. */
const holding = (...issues) => answering((n) => {
  const found = issues.find((i) => i.number === n);
  return found ? { data: { repository: { issue: found } } } : notFound(n);
});

/** The lines a dry sync of issue `number` prints, fetched and linked as `board.mjs issue` does. */
async function linked(t, fetch, number) {
  t.mock.method(globalThis, 'fetch', fetch);
  const log = t.mock.method(console, 'log', () => {});
  const ctx = context({}, [], true);
  await linkIssue(ctx, await cached(ctx, number));
  return log.mock.calls.map((call) => call.arguments[0]);
}

describe('linkIssue', () => {
  it('skips a Needs that names a pull request, says so, and links the rest', async (t) => {
    const fetch = holding(node(674, { body: '### Notes\n\nNeeds #656 merged.\nNeeds #657.' }), node(657));
    assert.deepEqual(await linked(t, fetch, 674), [
      "skip #656 in #674's body: it is not an issue (a pull request, or no such number)",
      'would link #674 blocked by #657',
    ]);
  });
  it('skips a checklist step that is not an issue, and names the step', async (t) => {
    const fetch = holding(node(16, { body: '- [ ] #656 — step 2 *(needs #657)*\n- [ ] #658 — step 3 *(needs #657)*' }), node(657), node(658));
    assert.deepEqual(await linked(t, fetch, 16), [
      "skip #656 in #16's body: it is not an issue (a pull request, or no such number)",
      'would link #658 blocked by #657',
    ]);
  });
  it('still fails on any other refusal, such as a token missing a permission', async (t) => {
    const forbidden = { data: { repository: { issue: null } }, errors: [{ type: 'FORBIDDEN', path: ['repository', 'issue'], message: 'Resource not accessible by integration' }] };
    t.mock.method(globalThis, 'fetch', answering(() => forbidden));
    await assert.rejects(cached(context({}, [], true), 674), /repository\.issue: Resource not accessible by integration/);
  });
});
