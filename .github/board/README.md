# The board

The [Roadmap project](https://github.com/orgs/wilanis/projects/1) is a view of the issues, not a second place to
keep them. Labels, assignees, branches, pull requests and relationships are what a person edits; the sync in this
directory derives every board field from them, so a field set by hand is put back on the next event. To change
what the board says about an issue, change the issue.

## Fields

| Field | Derived from |
| --- | --- |
| Type | the issue's native type, set from the most specific of `rfc`, `bug`, `maintenance`, `documentation`, `enhancement` (Feature), `task`. A type the organization has not created yet is skipped with a note. |
| Area | every `area:*` label with an option: core, compiler, runtime, engine, view, plugin-http, plugin-storage, plugin-auth, plugin-blob, plugin-search. Other area labels still count for triage. |
| Status | the first that holds: closed → **Done**; an open pull request that is not a draft → **In Review**; waiting on something → **Blocked**; assigned, claimed by an `<issue>-<short-title>` branch, or served by a draft → **In Progress**; an accepted RFC with a closed step → **In Progress**; `status:ready` → **Ready**; else **Todo**. |
| Waiting on | `waiting:decision` → Decision, `waiting:schema` → Schema approval, `waiting:dependency` → Dependency (outside this repository); else an open blocked-by issue → Issue; else a parent RFC not yet accepted → RFC. |

So a pull request moves its issue on its own: opening it marks In Review, a draft marks In Progress, merging it
closes the issue and marks Done, and closing it unmerged returns the issue to whatever else holds.

## Dependencies

Blocked-by relationships and sub-issues are GitHub's own, so the issue page shows them. The sync adds the ones a
body already states and never removes one:

- a tracking issue's checklist line `- [ ] #X — step n *(needs #A, #B)*`: X is blocked by A and B;
- `Needs #A and #B` anywhere else in an issue: it is blocked by them;
- a task's `### RFC and step` naming `#T, step n`: it is a sub-issue of T.

A relationship is added only between two open issues: a blocker that has already closed blocks nothing.

## Hygiene

`needs-triage` is added to an open issue with no type label or no `area:*` label, and removed once it has both.
`.github/workflows/triage.yml` opens `Backlog triage: YYYY-MM` on the first of each month: what needs triage,
what has had no update for 30 or 60 days, claims with no pull request for 14 days, ready issues still blocked,
RFCs whose steps have all closed, closed issues not Done, and milestones empty or past due. It closes the
previous month's.

## Views

Inbox (open issues), Ready next (Status Ready), In Progress (In Progress or In Review), Blocked, Bugs (type Bug),
RFC Tracker (label `rfc`, a board), Stale (no update in 30 days), Small wins (`good first issue`), and Now and
Milestones as before. Grouping and sorting are set in the project's UI; the API sets a view's filter and fields
only.

## Running it

The workflows need a `PROJECT_TOKEN` secret: a fine-grained token owned by the organization with **Projects:
read and write** on the organization and **Issues: read and write**, **Pull requests: read** and **Contents:
read** on this repository. `GITHUB_TOKEN` cannot write an organization project. Without the secret both workflows
say so as a warning and skip, so an unset token never fails a pull request's checks.

```
GH_TOKEN=$(gh auth token) node .github/board/board.mjs issue 195 173 --dry   # what a sync would write
GH_TOKEN=$(gh auth token) node .github/board/board.mjs all                   # every open issue
GH_TOKEN=$(gh auth token) node .github/board/triage.mjs --dry                # this month's triage body
node --test .github/board/*.test.mjs                                         # the rules
```
