# YouTube → audio extractor

Full-stack app: find a song (YouTube link, search, Spotify song link, Spotify or YouTube playlist),
download its audio from YouTube (SoundCloud when YouTube can't answer), save it into a chosen folder,
and play your music. Developed on Windows; works the same on macOS and Linux.

Docs: `README.md` (user guide), `docs/run/README.md` (install and run), `TECHNICAL.md` (architecture;
**its File-by-file reference says what every file does — read it before changing code you haven't
seen**, and its Conventions and gotchas section has the full rules below with their reasons),
`docs/sources.md` (outside sources and fallbacks), `docs/core-flows.md`, `docs/decisions.md`,
`LEARNING.md` (the stack for a .NET developer).

## Stack

React 19 + Vite 8, wouter, TanStack Query, shadcn/ui, Tailwind CSS 4 (`client/`); Express 5 +
TypeScript (`server/`); `shared/` for schemas and API contracts. No database: JSON files in `data/`
(history, settings, source health). yt-dlp via `youtube-dl-exec`, ffmpeg via `ffmpeg-static`,
`music-metadata` for tags.

## Commands

- `npm run verify` — the one check before a change is done (prettier, eslint, tsc, licences, core
  flows, unit tests, music and history API tests; no network). CI runs it on every push and PR.
- `npm run dev` — http://localhost:5000. `npm run build`, `npm start` — production.
- `npx vitest run tests/unit`; `npx vitest run tests/api` (needs internet); `npx playwright test`
  (Chrome and WebKit, own server on port 5099; `E2E_BROWSERS=…,firefox` adds Firefox).
- `npm run core-flows`, `npm run coverage`, `npm run check`, `npm run update-yt-dlp`, `npm run clean`.

## Local setup

- `npm install` only (Node 24 LTS, npm 11+; no Python). `.env` is optional — variables in
  TECHNICAL.md's Developer setup notes.
- Without Python 3.9+, install with `YOUTUBE_DL_SKIP_PYTHON_CHECK=1`. Never `npm rebuild
youtube-dl-exec` on macOS/Linux. Never use npm 10 on this repo (drops the lockfile's `libc` fields).
- PowerShell: use `npm.cmd`. `NODE_ENV=production` in the shell skips dev dependencies.
- Tests point every data file at temp folders; a unit test that records source health sets
  `SOURCE_HEALTH_FILE` or passes a stand-in store.

## Rules (full text and reasons: TECHNICAL.md › Conventions and gotchas)

- Cross-platform: `cross-env` for env vars in npm scripts; no `reusePort`.
- Never slow the app down (the owner's rule, Oct 11, 2026): no cooldowns, queues or caps of our own;
  parallel work is one per CPU core (`cpuCores()`, `mapAtOnce()`); when a source refuses, switch to
  the next source at once; test against stand-ins, never live services.
- A download owns two child processes (`startAudioPipeline()`); re-test cancel paths after any edit
  to downloads, saves or the player's FLAC conversion (no processes or `.part` files left).
- Don't write to `res` before the pipeline produces audio (failures before it are a `502`). History
  gets an entry only after a download fully succeeds. Keep `/api/downloads` cheap.
- MP3s are 320k CBR with the app's own ID3v2.3 tag (`id3v2Tag()`); ffmpeg writes none.
- Only canonical links reach yt-dlp (`audioLinkOf()`); search passes the query after `--`, no shell.
- New YouTube calls go through `youtubeGuard.run()`; routes answer `YouTubeRefused` with
  `sendRefused()`. Update `docs/sources.md` when a source or fallback changes.
- Spotify: only validated ids/codes go into fetched URLs; no sign-in (the app stays free).
- Anything that reads or writes the user's disk sits behind `localOnly()`; folder songs are asked
  for by id, never by path. Download links stay real `<a href download>` elements.
- Player: `audio.play()` runs synchronously inside the click; keep the one `<audio>` element.
- Browsers: Chrome/Edge 111, Firefox 128, Safari 16.4 and newer; no `for await` over streams; no
  endless animations or big `blur()` areas (they stall Playwright's WebKit on Windows, where opening
  a song also blocks the page for seconds).
- Download names: `safeFileName()` + `res.attachment()`. `u`-flag regexes via `new RegExp()`.
- Dev server: `vite.config.ts`'s `server.fs` allows only `client/`, `shared/`, `node_modules/`;
  never replace `viteConfig.server` in `server/vite.ts`. Vite errors never exit the process.
- Windows scripts: `app.ps1` stays PowerShell 5.1, ASCII, CRLF; `stop` kills only the app's tree.
  Never commit to the `install` branch.
- Dependencies: runtime imports in `dependencies`; free open-source licences only; `npm audit` at 0.
- If extraction breaks, `npm run update-yt-dlp` before debugging code.

## Definition of done

- `npm run verify` passes. Show its last lines in your summary.
- A change to a route, a pipeline (yt-dlp, ffmpeg), a file the app writes or a Windows script comes
  with a unit test that runs without the network — the player's tests show how to make songs with
  ffmpeg instead of downloading them. If the change can only be checked against YouTube or Spotify,
  run `tests/api` or the browser tests too and say which ones you ran.
- Core flows (`docs/core-flows.md`): every flow names a unit, an integration and a UI test, all on
  stand-ins. A change to a core flow updates all three; a new feature adds its flow and all three
  tests. `Gaps allowed` only goes down.
- Docs match the code: a new file, route or module goes in TECHNICAL.md's File-by-file reference; a
  new command or environment variable here too; anything a user sees in `README.md` /
  `docs/run/README.md`.
- Never skip or delete a test, loosen a check, or add an `eslint-disable` / `@ts-expect-error` to get
  green without asking the user first.

## Workflow

- Commit to `main` after each completed milestone (a feature, fix or cleanup that is done and
  tested) without asking first, then push to `origin/main`. Keep each commit to one milestone with a
  descriptive message; don't commit half-finished work. Each push rebuilds the `install` branch that
  PCs update from (the workflow doesn't run the tests), so only push what passes `npm run verify`.
