---
name: review
description: Review a pull request or an RFC of wilanis-js for the maintainer. Picks one, briefs them (what it changes, decision points with a recommendation, pros and cons, risks, checks), then on their explicit yes merges the pull request by rebase, posts the review comment, or accepts the RFC. Asked to "review open PRs" (or "review the open pull requests", "go through the PRs"), it runs the sweep instead: every open pull request is read, the ones that meet the rails and hold no defect are merged, and the rest get a review requesting the fix, written for the session that will make it. Use when asked to "review PR N", "review RFC NNNN", "what is waiting for review", "merge N", or "review open PRs".
---

# Reviewing for the maintainer

The maintainer validates every detail; this skill makes that fast and keeps the record straight. The
procedure is one. The target is a pull request, or one RFC file inside the pull request that proposes it.

There are two ways in. Named a target ("review PR N", "review RFC NNNN"), the procedure below runs on it
and stops at a question: the maintainer decides. Asked to **review open PRs**, the request is the
decision for every pull request open at that moment, and section 5 says what it decides: merge what
meets the rails and holds no defect, request the fix on what does not, and leave what only the
maintainer can settle. Sections 1 to 4 still say how each one is read and what merging means.

## 1. Pick

```
gh pr list -R wilanis/wilanis-js --json number,title,labels,headRefName,statusCheckRollup,reviewDecision
```

If the user named one, use it. Otherwise show what is open with the state of its checks and let them
choose. For an RFC: the file under `docs/rfcs/` and the pull request that proposes it; the file's header
names the tracking issue, and the issue names the pull request.

## 2. Read, in a fresh subagent

Spawn an `Explore` or `general-purpose` agent, never a fork: the brief comes from what is there, not from
the memory of the session that wrote it. Give it the pull request number or the RFC path and ask for the
brief below and nothing else. It reads the whole diff (`gh pr diff N`) or the whole file plus the code the
file names, and `CLAUDE.md`.

## 3. The brief

Under 300 words, in this order:

- **What it changes**, in CLAUDE.md's terms: document kinds, checker rule families, plugin hooks, promises
  the runtime makes, schemas. "None" when none.
- **Decision points**: each a question the maintainer must answer, with a recommendation and the reason. For
  an RFC these are its Open questions plus anything the reader found unsettled.
- **Pros and cons**, only where a real alternative exists.
- **Risks**: what breaks or drifts if this is wrong; any rail below that is not met.
- **Checks**: CI state, unresolved threads, up to date with `main`, the branch named after an issue.

Present it, then ask one question about this one target: merge, comment, accept, or leave.

## 4. Act, on an explicit yes for this target

A yes covers this pull request or this RFC and nothing else. Never carry it to the next one.

### Merge a pull request

Rails, all of them: every check green; no unresolved thread; up to date with `main` (rebase, push, wait
for the checks again if not); the head branch named `<issue>-<short-title>`; and, when the pull request
adds or changes a file under `docs/rfcs/`, every full spec in it has `**Status:** accepted` with the
steps below done, or the maintainer has said which files stay draft and why. A merge is never the
acceptance; the acceptance comes first. Then:

```
gh pr merge N -R wilanis/wilanis-js --rebase --delete-branch
```

Report the commits now on `main`. If the pull request closed a task, tick it in the tracking issue's
checklist and look at the RFC's other tasks; when it was the last, the RFC's status becomes `implemented`
(the `roadmap` skill says how).

### Comment on an RFC

Draft the comment from the decision points the maintainer settled, in their voice, plain. Offer it as text
to paste, or post it on their word. It posts under their account with no marker; they approved the text.
A remark about a line goes on that line of the file in the pull request; a remark about the whole goes on
the tracking issue:

```
gh api repos/wilanis/wilanis-js/pulls/N/comments -f body="..." -f path="docs/rfcs/NNNN-title.md" -f commit_id="$(gh pr view N -R wilanis/wilanis-js --json headRefOid -q .headRefOid)" -F line=LINE -f side=RIGHT
gh issue comment M -R wilanis/wilanis-js --body "..."
```

### Accept an RFC

Rails: it is a full spec, never a stub (a stub is expanded first, with the `rfc` skill); no open question
is left in the file, each answered in the text or moved under "decided during implementation"; the tracking
issue exists. Then, in the pull request that holds the file:

1. The header: `**Status:** accepted`. The row in `docs/rfcs/README.md`. Commit and push to the pull
   request's branch.
2. The labels: `gh issue edit M -R wilanis/wilanis-js --remove-label status:draft --add-label status:accepted`.
3. The tracking issue's **Tasks** section becomes the Implementation plan as a checklist, one line per
   step, a step already done ticked with the pull request that did it. Each step still to do becomes a
   task issue with the `task` template: labels `task` and the RFC's `area:*`, the tracking issue's
   milestone, `good first issue` where the plan says so; linked as a sub-issue of the tracking issue
   (`gh api -X POST repos/wilanis/wilanis-js/issues/M/sub_issues -F sub_issue_id=<the task's id, not its
   number>`). Label the unblocked ones `status:ready`.
The pull request merges when every full spec in it is accepted or moved out; the stubs in it merge as
stubs.

## 5. The sweep: review open PRs

"Review open PRs" is a standing yes for this run and for the pull requests open when it starts. It is not
carried past the run, and a pull request opened during it is left for the next.

**Take stock.** List what is open (section 1). Set aside a draft, and a pull request whose `decision` job
is waiting for the maintainer: a change of decision under `fitness/` or a schema under
`packages/core/schemas/` is theirs to approve, and the sweep only reports it. Everything else is a
candidate.

**Read every candidate in its own fresh subagent** (section 2), all at once. Each brief ends in a verdict
and its reason, one of:

- `merge` -- the rails are met, the code does what the pull request says, and the reader found no defect
  against `CLAUDE.md` (a rule in two places, an import against the arrow, a file or function past the
  house limit that lint somehow let through, a test that does not bite, a document kind or hook the task
  did not ask for). A decision point whose recommendation is plain is not a blocker; the sweep takes the
  recommendation and says so in the report.
- `fix` -- something must change before it merges. The brief names each thing: the file and line, what
  is wrong, and the edit that fixes it.
- `leave` -- only the maintainer can settle it: a decision point with no plain recommendation, an RFC
  whose acceptance is a judgement, a pull request whose purpose the reader could not make out.

**Order the merges.** Pull requests that touch the same files, or build one on another, go in the order
their issues were meant to: the lower issue number first unless a pull request's body says otherwise. A
merge puts the others behind `main`; before each next one, rebase its branch, push, and wait for the
checks (the rails in section 4 already say so). A rebase that conflicts is not resolved by the sweep: it
turns that pull request's verdict into `fix`, with the conflicting files named.

**Merge** each `merge` verdict as section 4 says, one at a time, rails checked again at the moment of
merging. Do the bookkeeping section 4 names (the task ticked in the tracking issue, the RFC's status when
it was the last task).

**Request the fix** on each `fix` verdict. The session that makes the fix will read the comment without
this conversation, so the comment carries the whole case: what is wrong, where, and the edit that fixes
it; and, where the fix is a choice, which way to take and why. A remark about a line goes on that line;
the summary goes in a review whose first line says **Needs a fix before merging**. It is a comment review,
not one that requests changes: the pull requests are the maintainer's own, and GitHub refuses a
request-changes review on one's own pull request.

```
gh pr review N -R wilanis/wilanis-js --comment --body "..."
gh api repos/wilanis/wilanis-js/pulls/N/comments -f body="..." -f path="<file>" -f commit_id="$(gh pr view N -R wilanis/wilanis-js --json headRefOid -q .headRefOid)" -F line=LINE -f side=RIGHT
```

A pull request that waits on another (stacked on its branch, or asked to rebase on it) and needs no fix of
its own gets a comment review saying so, and what to do when the one it waits on lands.

Check each point against the code before posting it; a comment that is wrong costs the next session more
than no comment. The comment is plain and in the maintainer's voice, with no marker and no signature; it
posts under their account. Nothing is edited on the branch: the fix is the other session's work, and the
sweep never pushes to a pull request it did not merge. The `coordinate` skill's step 5 is what picks the
comment up.

**Report**, one line per pull request open at the start: its number, title, verdict, and what was done --
the commits now on `main`, the review posted, or the reason it was left. `main` takes only pull requests, so
a change the sweep itself makes (this file, a tracking issue's text) goes through an issue, a branch named
after it, and a pull request of its own. Say what the sweep did not
verify. A `leave` line asks its one question so the maintainer can answer it in a word.

