---
name: backlog
description: File, groom and work this repo's backlog of technical debt and the owner's decisions, kept as GitHub issues labelled debt, decision and irreversible, with decisions made recorded in docs/decisions.md. Use when you find debt or a choice that's the owner's, for the weekly triage, for a weekly work run on the top debt item, or when asked about the backlog.
---

# Backlog: debt and decisions

The backlog is this repo's GitHub issues. Nothing about it lives only in a chat or a session: if it isn't an issue or a line in `docs/decisions.md`, it will be lost.

- `debt`: code that costs more to change than it should.
- `decision`: a choice that's the owner's (ShayanZafar), not yours.
- `irreversible`: added to a decision that can't be undone (deleting a branch, data or a published thing). It never takes a default and waits for the owner.

Use the REST API (`gh api repos/<owner>/<repo>/...`), since GraphQL may be blocked. Every comment you post ends with the attribution footer your session gives you.

## Filing

Before filing, search the open and closed issues (`gh api 'repos/<owner>/<repo>/issues?state=all&labels=debt&per_page=100'`) so you don't open a duplicate. File it the moment you find it, even mid-task: a debt or decision mentioned only in a summary or a PR body is lost.

**Debt** (label `debt`; the body follows `.github/ISSUE_TEMPLATE/debt.yml`):

```
**Where:** files, and lines if it helps.
**Cost of leaving it:** what it makes slower, riskier or more expensive to change.
**Fix:** the change, in two or three sentences.
**Size:** S (under an hour), M (one session) or L (needs a spec).
Found <how>, <Mon D, YYYY>.
```

**Decision** (label `decision`, plus `irreversible` if it can't be undone; title `Decide: <question>?`):

```
**Question:** one sentence.
**Options**
- **A. <name>:** what it costs and what it gets.
- **B. <name>:** ...
**Recommendation:** the option, and why in a sentence or two.
**Blocking:** what waits on this, or "nothing".
**Default:** If there's no answer by <today + 7 days, YYYY-MM-DD>, <option> applies.
Raised by <who or what>, <Mon D, YYYY>.
```

Leave out the Default line for an irreversible decision and say instead why it waits. Assign every decision to ShayanZafar (`gh api -X POST repos/<owner>/<repo>/issues/<n>/assignees -f 'assignees[]=ShayanZafar'`), so it shows in his GitHub notifications. Don't ask in chat what a decision issue can ask: file it and carry on with the recommendation's side of the work only when it's reversible and nothing irreversible depends on it.

## Recording a decision

When the owner answers (a comment by ShayanZafar picking an option or saying what to do), or a reversible decision's default date is today or earlier with no answer:

1. Add one line at the top of the list in `docs/decisions.md` (newest first): `- YYYY-MM-DD — <decision>. Why: <reason>. (#n)`. For a default add "(default applied: no answer in 7 days)" before `(#n)`. Never apply a default to an `irreversible` decision.
2. If it's a standing rule (it says how things are to be done from now on), also add one dated line to CLAUDE.md where that subject belongs.
3. Put all record-keeping changes from one run in one branch and one pull request (`claude/decisions-YYYY-MM-DD`). Never push to the default branch and never merge.
4. Comment on the issue that it's recorded, linking that pull request, and close it (`state_reason: completed`).
5. If the decision calls for work: do it in its own pull request when it's small and clear (see Working), otherwise file it as `debt` and link the decision.

Never ask again about anything in `docs/decisions.md`. Decisions made before Oct 12, 2026 are recorded inline in CLAUDE.md with their dates.

## Weekly triage

Run in this order and change nothing that isn't due:

1. **Answers:** read the comments on every open `decision`; record those he answered.
2. **Defaults:** record the default of every open, non-irreversible decision whose date has come.
3. **Work a recorded decision calls for:** as in Recording, step 5.
4. **Debt hygiene:** close debt that's already fixed (check the code, and say which commit fixed it), duplicates (link the one kept), and items over 90 days old that nobody will do (say why). Fill in a missing Size or Fix. Correct a Where that has drifted.
5. **Decision hygiene:** every open decision has options, a recommendation, a default date or the `irreversible` label, and is assigned to ShayanZafar; add what's missing (a new default date is 7 days from today).

## Working (one debt item)

1. Pick the open `debt` issue with the best payoff for its size: S before M, and never an L (it needs a spec, which is a decision for the owner). Skip one that waits on an open decision, has an open pull request (search `Fixes #<n>` in open PRs), or is labelled `blocked`.
2. Branch `claude/debt-<n>-<slug>` from the default branch, make the change, and run the repo's check (below) until it passes. Follow CLAUDE.md's Definition of done.
3. Open a ready-for-review pull request whose body says `Fixes #<n>`, using `.github/pull_request_template.md`. Never merge it and never push to the default branch.
4. If the item turns out bigger than its Size, or needs a choice that's the owner's, stop: correct the Size, or file the decision and label the debt `blocked`, and say so on the issue.

One item per run. Anything new you notice on the way is filed as its own issue, not fixed in this pull request.

## The check

| Repo | Command |
| --- | --- |
| ThirteenF | `scripts/verify.sh` |
| YTDownload | `YOUTUBE_DL_SKIP_PYTHON_CHECK=1 YOUTUBE_DL_HOST=https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp npx npm@11 ci`, then `npm run verify` (the `YOUTUBE_DL_HOST` download skips GitHub's API, whose 60-an-hour anonymous limit a shared cloud address has usually used up) |
| ShayanZafar.Github.io | `node scripts/check-site.mjs` |

If the check can't run in your environment (no network for an install, a rate limit), say exactly what failed and which parts you ran instead. Don't open a pull request with code changes the check hasn't passed.

## Board and report

If the run's instructions name a backlog board, update its rows after the run: one row per open issue (repo, number, kind, title, link, who it's on, status, size, recommendation, default date, pull request), and remove the rows of closed issues. GitHub stays the source of truth: the board is a view of it.

Finish with a short report: decisions waiting on the owner (link, question in a few words, recommendation, default date or "irreversible"), decisions recorded and how (his answer or the default), pull requests opened, debt opened and closed, and the three debt items with the best payoff for their size. If nothing is waiting and nothing changed, say so in one line.
