---
paths:
  - "package.json"
  - "package-lock.json"
  - "scripts/{licenses,license-rules}.ts"
  - "scripts/{yt-dlp,ffmpeg-check}.mjs"
  - "tests/unit/{license-rules,yt-dlp-script,ffmpeg-check}.test.ts"
  - ".github/dependabot.yml"
  - ".github/workflows/tests.yml"
  - ".prettierrc"
  - ".prettierignore"
  - "eslint.config.js"
  - "tsconfig.json"
---

# Dependencies, npm scripts and tooling

- Runtime imports only in `dependencies`, everything else in `devDependencies`. `npm audit` should
  stay at 0.
- Every dependency must carry a free, open-source licence (`npm run licenses`): `ffmpeg-static`, GPL
  like ffmpeg itself, is the one agreed exception, so a new copyleft or non-open package fails the
  check — replace the package rather than widening the list.
- npm scripts set environment variables with `cross-env`, never a bare `VAR=value` prefix.
- npm 10 also crashes resolving this tree from scratch (besides dropping the lockfile's `libc`
  fields). `allowScripts` in package.json approves, by name, the install scripts the app needs —
  esbuild, ffmpeg-static (ffmpeg), youtube-dl-exec (yt-dlp); npm 12 blocks all others. This PC: Node
  24.19, npm 12.2.
- Everything is on its newest version except TypeScript (6.0: typescript-eslint supports < 6.1, not
  the native TypeScript 7 yet) and `@types/node` (follows the Node the app runs on, 24).
- The `postinstall` checks yt-dlp against its release's `SHA2-256SUMS` and ffmpeg against the
  hashes pinned in `scripts/ffmpeg-check.mjs`. Bumping ffmpeg-static to a new binary release means
  adding that release's hashes (the `.gz` files unpacked, one per system) there.
- Why CLAUDE.md rules out `npm rebuild youtube-dl-exec` on macOS/Linux: it brings back the Python
  yt-dlp until `node scripts/yt-dlp.mjs` runs again; `npm run update-yt-dlp` updates it in place.
- Prettier config is in `.prettierrc` (`endOfLine: auto`, so CRLF checkouts on Windows are fine).
