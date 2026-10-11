---
name: verify
disable-model-invocation: true
description: Run YTDownload's one check (prettier, eslint, tsc, unit tests and the music API test) and report only failures. A commit hook runs it before each commit; type /verify to run it yourself.
---

A commit hook runs this same check before every `git commit` and blocks the commit when it fails, so there is no need to run it before committing; run it directly while working, to check a step.

From the repo root, run the project's check and show only the end of the output:

`npm run verify 2>&1 | tail -40`

It runs `prettier --check`, `eslint`, `tsc`, `npm run licenses` (every dependency must carry a free, open-source licence; a failure names the package and its licence, which means replacing the package, not widening the allow-list), then `vitest run tests/unit tests/api/music.e2e.test.ts`, and stops at the first step that fails. CI runs the same command on every push to main and every pull request.

For formatting failures in files you changed, run `npx prettier --write <files>` and re-check. The other API tests (`tests/api`) talk to YouTube and the browser tests (`npx playwright test`) drive Chrome and WebKit: run them only when the change touches download, search, Spotify or player code, and say which ones you ran.

Report which step failed and, for each failure, the file, line and message. Don't paste the full log.

If a step fails because of the change being committed, fix it before committing. If it fails for an unrelated reason, say so and stop; don't change unrelated code to make it pass.
