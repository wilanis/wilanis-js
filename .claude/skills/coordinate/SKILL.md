---
name: coordinate
description: Drive a milestone's issues to merged pull requests with several subagents at once, each in its own worktree off origin/main, relaying the maintainer's review comments back to the agent that wrote the code. Use when asked to "coordinate M0N", "work the milestone in parallel", "run these issues with subagents", "what can be done in parallel", or to pick up review comments on a pull request a subagent opened.
---

# Coordinating a milestone

One milestone at a time, its issues taken by several agents at once where the work does not overlap. This
skill is the coordination: which issues may run together, how an agent is dispatched, what comes back, and
who does the bookkeeping. The work of one issue is `roadmap`'s; merging is `review`'s; this skill never
merges and never edits the tree it is coordinating.

**The primary checkout stays on `main` and stays clean.** Every agent works in its own worktree. That is the
rule the rest of this skill protects, because two agents in one checkout write over each other's branches
and the PRs come out mixed.

## 1. Map what can run in parallel

Read the milestone's issues and the RFC's Implementation plan; the plan's numbered steps are the real
dependency order.

```
gh api repos/wilanis/wilanis-js/milestones --jq '[.[] | select(.state == "open")] | sort_by(.due_on)[0].title'
gh issue list -R wilanis/wilanis-js --milestone "<that title>" --state all \
  --json number,title,state,labels,assignees
git ls-remote --heads origin                       # a branch named N-* is a claim; that issue is taken
```

Two issues may run at once when **no file is touched by both**. Judge that from the steps, not the titles:
a step that defines a type and a step that consumes it collide even in different packages, and a new plugin
package collides with nothing except the root `package.json` and `tsconfig.json`.

Say the split out loud before dispatching, and name the one file each agent must not touch. Where a step is
blocked, say which step blocks it rather than calling the milestone blocked.

**Do not invent parallelism.** Where only one issue can run, run one. Two agents in the same files cost more
than they save. A step whose issue is closed may still be unlanded — check the code, not the issue state.

## 2. Resolve what the agents would otherwise guess

Decide these once, in the dispatch, so two branches cannot answer them differently:

- **A new refusal code.** Codes are per-family and, for a plugin's `X` rules, per-plugin blocks
  (`plugin-http` X0xx, `plugin-auth` X1xx, `plugin-storage` X2xx, `plugin-schedule` X25x). A new plugin takes
  the next free block, not the next free number.
- **Who owns a shared file.** Root `package.json` (the release order), root `tsconfig.json` (project
  references), a test harness's plugin map: exactly one agent may edit each.
- **What has already landed.** Name the types and files the step builds on so an agent does not redefine
  them.

## 3. Dispatch

One agent per issue, `isolation: "worktree"`, **always branched from `origin/main`**, never from another
agent's branch and never from a stale local `main`.

Every dispatch carries, in the prompt:

- The issue number and the RFC step, and an instruction to read `CLAUDE.md`, the `roadmap` skill and the
  whole RFC.
- `git fetch origin` then `git switch -c N-short-title origin/main`, and the claim push from `roadmap`
  step 3 (`--force-with-lease=refs/heads/N-short-title:`, empty lease) — **unless the branch already exists
  on the remote**, in which case say so and tell the agent the claim is already its own, or it will read its
  own claim as someone else's and stop.

  The branch name is CI's, not a convention: `.github/workflows/ci.yml` refuses a head branch that is not
  `<issue>-<short-title>`, and then refuses it again unless issue N exists, is assigned to the pull
  request's author, and no other open pull request serves it. **So the issue comes before the branch.**
  Work that has no issue — a skill, a note, a fix nobody filed — needs one opened and assigned first, or
  the pull request cannot pass however good the change is. A branch already pushed under the wrong name is
  renamed (`git branch -m`), pushed under the new name, and its pull request opened again: the check reads
  the head branch, so editing the old pull request does not move it.
- **`npm install` in the worktree before running tests.** A fresh worktree has no `node_modules` symlinks
  and `packages/view/test/static.test.ts` then fails spuriously, resolving the `@wilanis/access` include to
  an absolute path. It is not a real failure and it is not the agent's change.
- The **measured** baseline (`npx vitest run` on current `main`), not a remembered one. Tell the agent to
  re-measure if `main` moved under it.
- The do-not-touch list from step 1, and the decisions from step 2.
- Plain imperative commit messages, no trailers, no tool or session references. Do not touch `biome.jsonc`.
- **Open the pull request; never merge it.** The maintainer reviews.
- What to report: the PR number, the files changed, the test counts, and anything the RFC left open that
  the agent had to decide.

Where several issues are independent, dispatch them in one message so they run at once.

## 4. Verify what comes back — do not relay it

An agent's report is a claim. Check the things a report gets wrong most often:

```
gh pr view N --json state,mergeable,mergeStateStatus,changedFiles
gh pr diff N --name-only                  # did it stay inside its scope?
cd <the agent's worktree> && npm test     # run the suite yourself
```

- **`mergeable`.** Agents report tests and forget this. `CONFLICTING` means `main` moved: send the agent
  back to rebase and keep both sides. `BEHIND` is only a fast-forward — rebase and push, no conflict.
- **The baseline.** `main` moves during a long task. Re-measure it before believing a delta.
- **A claimed pre-existing failure.** Reproduce it on clean `main` before accepting it. A failure that
  appears in one worktree and not another is usually the missing `npm install`, not the code.
- **Stale `dist`.** A `tsc -b` in the primary checkout clears failures that are only stale build output.
- **An empirical claim.** Where an agent says a mechanism cannot work, run it. Where it pastes terminal
  output into a document, run the command and compare.

Report what you verified, not what you were told.

## 5. Relay a review comment to the agent that wrote the code

Read **all three** places a comment can be, on every pull request the run opened:

```
gh api repos/wilanis/wilanis-js/pulls/N/comments     # inline, on a line of the diff
gh pr view N --json reviews                          # a review's own body
gh pr view N --json comments                         # the conversation
```

Send them back to the agent that wrote the PR, by name, with its context intact. Before sending, **check
each point against the code** and add what you found: a comment names the symptom, and the agent works
faster from the file and line. Where the maintainer offers a choice, say which he chose; where he left it
open, say it is the agent's call and what it must do either way (file the follow-up issue, not merely
mention one).

If the agent cannot be resumed, dispatch a fresh one in a new worktree **on the PR's branch, not on
`main`**, carrying the full review. Say in the report that the original session was lost.

A comment marked "not blocking" is still the maintainer's; fold it into the next pull request that touches
that code rather than dropping it, and say in that PR that it was folded in.

## 6. Keep the primary checkout clean

Check it after every dispatch and before every report:

```
git -C <primary> status --short --branch          # expect: ## main...origin/main and nothing else
```

If an agent has written into it, stop the agents before anything is committed, save the work
(`git diff > <somewhere outside the repo>`, copy the untracked files), restore with `git checkout -- .` and
`git clean -fd <paths>`, and re-dispatch properly. Uncommitted work is recoverable; a mixed commit pushed to
a branch is not.

Pull the primary checkout only to follow `origin/main` (`git pull --ff-only`), and rebuild (`npm run build`)
after a merge so a stale `dist` does not read as a broken tree.

**Do not remove an agent's worktree until its pull request is merged.** Removing it severs the agent's
session, and a review comment then has nobody to go back to. Once merged:

```
rm -rf .claude/worktrees/<name> .git/worktrees/<name>
```

`git worktree remove` and `git worktree prune` may be refused by the sandbox; `rm -rf` on both paths does
the same work. Remove only the worktrees this run created — the others are the maintainer's.

## 7. Close the milestone

The bookkeeping is skipped more often than the code is wrong, and the board is what says what may be taken.
When the last step of an RFC merges, in that pull request: the RFC's header and its row in
`docs/rfcs/README.md` both read `implemented`, and the tracking issue's checklist is ticked.

Then, once the demo in `docs/roadmap.md` runs by hand — the maintainer's judgement, not a test suite's:

```
gh issue close <tracking> -R wilanis/wilanis-js --reason completed
gh api -X PATCH repos/wilanis/wilanis-js/milestones/<n> -f state=closed
gh api graphql -f query='mutation($v:ID!,$f:String!){ updateProjectV2View(input:{viewId:$v,filter:$f}){ projectV2View { name filter } } }' \
  -f v=PVTV_lADOE33gE84Bi9UDzgLogF0 -f f='milestone:"<the next milestone title>"'
```

Then label the next RFC's first step `status:ready`, or the board answers that nothing can be taken.

**A closed issue whose board item is not `Done` is the failure to look for.** It reads as work in flight and
stops the next person taking it. Sweep the milestone before saying it is closed:

```
gh project item-list 1 --owner wilanis --format json --limit 400
```

Fix a stale one with `gh project item-edit --id <item> --project-id PVT_kwDOE33gE84Bi9UD
--field-id PVTSSF_lADOE33gE84Bi9UDzhhzdLc --single-select-option-id 98236657`.
