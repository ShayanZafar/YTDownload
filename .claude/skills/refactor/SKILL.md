---
name: refactor
description: Measure what makes this code hard to change (duplication, long functions and files, dead code, churn) and apply the few cleanups with the best payoff, with npm run verify passing. Runs monthly in CI as a pull request; type /refactor to run it locally.
disable-model-invocation: true
allowed-tools: Read Glob Grep Edit MultiEdit Write Bash(npm run verify) Bash(npm run check) Bash(npx *) Bash(git *) Bash(gh pr *) Bash(wc *) Bash(sort *) Bash(uniq *) Bash(head *) Bash(tail *) Bash(xargs *)
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

## 4. Deliver

- In CI (`GITHUB_ACTIONS` is set): create a branch `refactor/<year>-<month>` from the current `main`, push it, and open one pull request with `gh pr create` titled "Monthly refactor: <one line>". The body lists each cleanup (what, why, the measurement it improves), the before/after numbers from step 1, and anything the reviewer should look at closely. If a PR for that branch already exists, push to it instead.
- Locally: leave the commits on the current branch and summarize the same way in the conversation.

If nothing clears the bar in step 2, say so and open no pull request. A quiet month is a good result.
