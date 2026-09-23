import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { areasOf, blockersIn, claimOf, needsTriage, parentIn, statusOf, typeOf, waitingOf } from './derive.mjs';

const issue = (over = {}) => ({
  number: 9,
  state: 'OPEN',
  labels: ['task', 'area:core'],
  assignees: [],
  pullRequests: [],
  openBlockers: [],
  parent: { number: 1, labels: ['rfc', 'status:accepted'] },
  claimed: false,
  stepsDone: 0,
  ...over,
});

describe('typeOf and areasOf', () => {
  it('takes the most specific type label', () => {
    assert.equal(typeOf(['task', 'documentation']), 'Documentation');
    assert.equal(typeOf(['rfc', 'status:draft']), 'RFC');
    assert.equal(typeOf(['question']), null);
  });
  it('maps area labels to options and drops the ones without one', () => {
    assert.deepEqual(areasOf(['area:plugin-http', 'area:core', 'area:process']), ['Core', 'HTTP']);
  });
});

describe('statusOf', () => {
  it('is Done when closed, whatever else it carries', () => {
    assert.equal(statusOf(issue({ state: 'CLOSED', labels: ['waiting:decision'] })), 'Done');
  });
  it('is In Review under an open pull request that is not a draft, even when blocked', () => {
    const pr = { state: 'OPEN', isDraft: false };
    assert.equal(statusOf(issue({ pullRequests: [pr], openBlockers: [4] })), 'In Review');
  });
  it('is Blocked by an open blocker, a waiting label, or an RFC not accepted', () => {
    assert.equal(statusOf(issue({ openBlockers: [4], labels: ['task', 'status:ready'] })), 'Blocked');
    assert.equal(waitingOf(issue({ labels: ['task', 'waiting:schema'] })), 'Schema approval');
    assert.equal(waitingOf(issue({ parent: { number: 1, labels: ['rfc', 'status:draft'] } })), 'RFC');
  });
  it('is In Progress when assigned, claimed by a branch, or served by a draft', () => {
    assert.equal(statusOf(issue({ assignees: ['someone'] })), 'In Progress');
    assert.equal(statusOf(issue({ claimed: true })), 'In Progress');
    assert.equal(statusOf(issue({ pullRequests: [{ state: 'OPEN', isDraft: true }] })), 'In Progress');
  });
  it('falls back to Todo when a closed-unmerged pull request is all that served it', () => {
    assert.equal(statusOf(issue({ pullRequests: [{ state: 'CLOSED', isDraft: false }] })), 'Todo');
  });
  it('is Ready when labelled so, and an accepted RFC is In Progress once a step has closed', () => {
    assert.equal(statusOf(issue({ labels: ['task', 'status:ready'] })), 'Ready');
    const rfc = { labels: ['rfc', 'status:accepted'], parent: null };
    assert.equal(statusOf(issue({ ...rfc, stepsDone: 0 })), 'Todo');
    assert.equal(statusOf(issue({ ...rfc, stepsDone: 2 })), 'In Progress');
  });
});

describe('needsTriage', () => {
  it('holds an open issue with no type or no area label', () => {
    assert.equal(needsTriage(issue({ labels: ['area:core'] })), true);
    assert.equal(needsTriage(issue({ labels: ['bug'] })), true);
    assert.equal(needsTriage(issue({ labels: ['bug', 'area:process'] })), false);
    assert.equal(needsTriage(issue({ state: 'CLOSED', labels: [] })), false);
  });
});

describe('what a body states', () => {
  it("reads a tracking issue's checklist needs, and no line without one", () => {
    const body = [
      '- [x] #186 — step 1, one `outcomeOf` `status:ready`',
      '- [ ] #187 — step 2, a switch catches *(needs #186)* (#574)',
      '- [ ] #195 — step 10 *(needs #188, #191)*',
      '- [x] #175 — step 11 *(blocked on RFC 0011\'s step 3)* (#570)',
    ].join('\n');
    assert.deepEqual(blockersIn(16, body), [
      [187, 186],
      [195, 188],
      [195, 191],
    ]);
  });
  it("reads a task's Needs line as its own blockers", () => {
    assert.deepEqual(blockersIn(173, '### Notes\nNeeds #169 and #170.'), [
      [173, 169],
      [173, 170],
    ]);
  });
  it('reads the parent a task names and the issue a branch claims', () => {
    assert.equal(parentIn('### RFC and step\n\n#16, step 10\n'), 16);
    assert.equal(parentIn('no step'), null);
    assert.equal(claimOf('195-example-catches-upstream'), 195);
    assert.equal(claimOf('worktree-agent-x'), null);
  });
});
