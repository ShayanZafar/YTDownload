---
name: refactor
description: Measure what makes this code hard to change (duplication, long functions and files, dead code, churn) and apply the few cleanups with the best payoff, with npm run verify passing; also fixes drift in the scripts, docs references and workflows. Runs monthly in CI as a pull request; type /refactor to run it locally.
disable-model-invocation: true
allowed-tools: Read Glob Grep Edit MultiEdit Write Bash(npm run verify) Bash(npm run check) Bash(npx *) Bash(git *) Bash(gh pr *) Bash(gh issue *) Bash(wc *) Bash(sort *) Bash(uniq *) Bash(head *) Bash(tail *) Bash(xargs *)
---

# Refactor for cheaper changes

The goal is code that the next feature can be added to with less reading and less risk: one place for each idea, functions you can hold in your head, no dead weight. Behavior never changes. Show only the last lines of each command.

## 1. Measure (report only; none of these fail the run)

- Churn, the best predictor of where refactoring pays: `git log --since="90 days ago" --name-only --format="" -- client server shared | sort | uniq -c | sort -rn | head -15`
- Long files: `git ls-files "client/src/**/*.ts" "client/src/**/*.tsx" "server/*.ts" "shared/*.ts" | xargs wc -l | sort -n | tail -12`
- Complex functions: `npx eslint client/src server shared --rule "complexity: [warn, 15]" --rule "max-lines-per-function: [warn, {max: 120, skipBlankLines: true, skipComments: true}]" --rule "max-depth: [warn, 4]" -f compact 2>&1 | tail -40`
- Duplication: `npx --yes jscpd --min-tokens 70 --format "typescript,tsx" --reporters consoleFull client/src server shared 2>&1 | tail -40`
- Dead code and unused dependencies: `npx --yes knip --no-progress 2>&1 | tail -40` (treat its report as leads to check by hand, not as truth)

## 2. Choose at most three cleanups

Start from the backlog: `gh issue list --label debt --state open --json number,title,body`. Rank those with what you measured; a cleanup that resolves one says `Fixes #<n>` in its commit and pull request. Debt you measured but won't fix this month: file it as a `debt` issue (search the open ones first; body: Where, Cost of leaving it, Fix, Size).

Rank by payoff divided by risk. Good candidates:
- The same logic in two or three places → one helper, with the existing tests covering each caller.
- A function over ~80 lines that does several things → split along the things it does, keeping names from the existing code.
- A file over ~500 lines with clear seams (for example a component that also holds its data fetching) → split at the seam.
- Exports, branches and dependencies nothing uses → delete.

Rules:
- Never change behavior or public interfaces, and never add a dependency.
- Prefer the smallest change that removes the problem; no reformatting beyond what `prettier --write` does to the files you touched.
- Leave `client/src/components/ui/` (shadcn) and generated files alone.
- One cleanup per commit, each independently revertable, with a message that says what is now easier to change.

## 2b. Pin behavior before touching untested code

If the code you'll change has no test that would fail when its behavior changed, write characterization tests first: call it with the inputs it sees today (real examples from callers or tests) and assert the outputs you observe now, in `tests/unit`. Commit them on their own, then refactor against them. If you can't characterize it cheaply, pick another cleanup.

## 3. Verify each one

After every cleanup, run `npm run verify 2>&1 | tail -40`. It must pass before the commit. If a cleanup needs more than a small test change to keep verify green, revert it and pick another.

## 4. Setup files (mechanical fixes only; doesn't count against the three)

The files that steer sessions drift as the code changes. Fix what is mechanical, in one extra commit `setup: <what changed>`; judgment calls (shortening CLAUDE.md, merging docs) are for the user's `/tune`, so only report them.

- References: every `scripts/…`, `npm run …`, `docs/….md` and `.github/workflows/….yml` named in `CLAUDE.md`, `README.md`, `docs/` and `.claude/skills/` exists (Grep for them, confirm with Glob); fix the name, or delete the sentence if the thing is gone.
- Clickable scripts: each double-click action has a `.cmd`, a `.command` and a `.sh` (helpers exempt); `git ls-files --eol scripts` shows `i/lf` for all of them; `git ls-files -s scripts` shows `100755` for every `.sh` and `.command` (`git update-index --chmod=+x <file>` fixes it); a `.command` only `cd`s and `exec`s its `.sh`; the three do the same steps.
- Workflows: the names `auto-merge.yml` lists (`workflows:`, `ON_MAIN`) match the `name:` of real workflows; `uses:` versions agree across workflows.
- Sizes, reported in the PR body: `wc -w CLAUDE.md .claude/skills/*/SKILL.md`. `CLAUDE.md` is sent with every request; over 600 words, say so and what you'd move to the docs, but don't move it here.
## 5. Deliver

- In CI (`GITHUB_ACTIONS` is set): create a branch `refactor/<year>-<month>` from the current `main`, push it, and open one pull request with `gh pr create` titled "Monthly refactor: <one line>". The body lists each cleanup (what, why, the measurement it improves), the before/after numbers from step 1, and anything the reviewer should look at closely. If a PR for that branch already exists, push to it instead.
- Locally: leave the commits on the current branch and summarize the same way in the conversation.

If nothing clears the bar in step 2, say so and open no pull request. A quiet month is a good result.
