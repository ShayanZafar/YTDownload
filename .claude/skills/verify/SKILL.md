---
name: verify
description: Run YTDownload's fast checks (type-check, unit tests, lint, formatting) and report only failures. Claude runs this before each commit; type /verify to run it yourself.
---

From the repo root, run these in order and show only the last lines of each:

1. `npm run check 2>&1 | tail -20`
2. `npx vitest run tests/unit 2>&1 | tail -40`
3. `npx eslint . 2>&1 | tail -30`
4. `npx prettier --check . 2>&1 | tail -20`

For formatting failures in files you changed, run `npx prettier --write <files>` and re-check.

The API tests (`tests/api`) talk to YouTube and the browser tests (`npx playwright test`) drive Chrome and WebKit. Run them only when the change touches download, search, Spotify or player code, and say which ones you ran.

Report pass/fail per step and, for each failure, the file, line and message. Don't paste the full log.

If a step fails because of the change being committed, fix it before committing. If it fails for an unrelated reason, say so and stop; don't change unrelated code to make it pass.
