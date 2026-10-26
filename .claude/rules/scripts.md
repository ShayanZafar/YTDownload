---
paths:
  - "scripts/windows/**"
  - "scripts/unix/**"
  - "scripts/install/**"
  - ".gitattributes"
  - "scripts/needs-build.mjs"
  - "tests/unit/{windows,unix}-scripts.test.ts"
  - "tests/unit/needs-build.test.ts"
  - "docs/run/README.md"
---

# The run scripts (Windows, macOS, Linux)

- Keep `scripts/windows/app.ps1` Windows PowerShell 5.1-compatible and plain ASCII, with CRLF line
  endings (`.gitattributes`; `tests/unit/windows-scripts.test.ts` checks).
- `stop` only kills the app's own process tree: from the server's `node.exe` up through its
  launchers (npm, `cross-env`, `start.cmd`/`Start.cmd`), never the terminal, editor or Explorer
  above them.
- This PC (the owner's Windows 10): Git 2.55. winget's msstore source fails with a certificate error
  here: use `--source winget`. Git's installer stops while anything from Git's folder runs (Git
  Bash, even a `sleep`).
- A copy of the source code runs its build, not the dev server (owner, Oct 26, 2026): `start`
  builds first when `scripts/needs-build.mjs` finds code newer than `dist/index.cjs`, and falls back
  to `npm run dev` if the build fails or with `-Dev`/`--dev`. A new folder or config file the build
  is made from goes in its `BUILD_SOURCES`.
