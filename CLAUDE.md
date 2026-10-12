# YouTube → audio extractor

Full-stack app: find a song (YouTube or Spotify link, search, playlist), download its audio (from
YouTube, else SoundCloud), save it into a chosen folder, and play your music. Developed on Windows;
keep everything working the same on macOS and Linux.

## Where things are

Instructions for Claude are this file (≤600 words, checked by `npm run verify`) and
`.claude/rules/` (one file per area, each loaded only when its files are touched); everything else
is documentation, read when needed:

- `TECHNICAL.md` — architecture, API, tests, deployment. Its **File-by-file reference** says what
  every file does: read it before changing code you haven't seen.
- `docs/`: `sources.md` (outside sources, fallbacks), `core-flows.md` (flows and their tests),
  `decisions.md`, `specs/`.
- `README.md` (user guide), `docs/run/README.md` (running it), `LEARNING.md` (the stack for .NET
  developers).

## Stack

React 19 + Vite 8, wouter, TanStack Query, shadcn/ui, Tailwind CSS 4 (`client/`); Express 5 +
TypeScript (`server/`); schemas and API contracts in `shared/`; no database, just JSON files in
`data/`. yt-dlp (`youtube-dl-exec`), ffmpeg (`ffmpeg-static`), `music-metadata` for tags.

## Commands

- `npm run verify` — the one check before a change is done (prettier, eslint, tsc, licences, core
  flows, instructions, unit tests, music and history API tests; no network).
- `npm run dev` — http://localhost:5000. `npm run build`, `npm start` — production.
- `npx vitest run tests/unit`; `npx vitest run tests/api` (needs internet); `npx playwright test`
  (browser tests).
- `npm run core-flows`, `npm run instructions`, `npm run coverage`, `npm run check`,
  `npm run update-yt-dlp`, `npm run clean`.
- Install: `npm install` (Node 24 LTS, npm 11+; never npm 10, which drops the lockfile's `libc`
  fields). Without Python 3.9+, set `YOUTUBE_DL_SKIP_PYTHON_CHECK=1`. In PowerShell, `npm.cmd`.
  `.env`: optional (TECHNICAL.md › Environment Variables).

## Rules everywhere

- Never slow the app down (the owner's rule, Oct 11, 2026): no cooldowns, queues or caps of our own;
  parallel work is one per CPU core (`cpuCores()`, `mapAtOnce()`); when a source refuses, switch to
  the next at once. In full: `.claude/rules/outside-sources.md`.
- Anything that reads or writes the user's disk sits behind `localOnly()`. Only canonical links
  reach yt-dlp (`audioLinkOf()`), and the app never fetches a user-controlled URL.

## Definition of done

- `npm run verify` passes. Show its last lines in your summary.
- A change to a route, a pipeline (yt-dlp, ffmpeg), a file the app writes or a Windows script comes
  with a unit test that runs without the network (the player's tests make songs with ffmpeg). What
  only YouTube or Spotify can check: also run `tests/api` or the browser tests, and say which.
- Core flows (`docs/core-flows.md`): each names a unit, an integration and a UI test, all on
  stand-ins; changing a flow updates all three, a new feature adds its flow and three tests, and
  `Gaps allowed` only goes down.
- Docs match the code: new files, routes and modules go in TECHNICAL.md's File-by-file reference;
  new commands and environment variables in TECHNICAL.md (here only if every session needs them);
  a rule for one area in its `.claude/rules/` file; what users see in `README.md` /
  `docs/run/README.md`.
- Never skip or delete a test, loosen a check, or add an `eslint-disable` / `@ts-expect-error` to get
  green without asking the user first.

## Workflow

- After each completed milestone (a feature, fix or cleanup, done and tested), commit it alone to
  `main` with a descriptive message, without asking first, and push to `origin/main`; never
  half-finished work. Each push rebuilds the `install` branch PCs update from, untested, so push
  only what passes `npm run verify`.
