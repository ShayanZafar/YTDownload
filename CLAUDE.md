# YouTube → audio extractor

Small full-stack app: paste a YouTube URL (or search for a song, or paste a Spotify song link),
preview it, download the audio track. Developed and run locally on Windows (it also works on
macOS/Linux). `README.md` is the user guide, `TECHNICAL.md` has architecture, setup and
deployment details, and `LEARNING.md` maps the stack onto .NET concepts.

## Stack

- **Frontend:** React 18 + Vite, wouter (routing), TanStack Query, shadcn/ui, Tailwind — `client/`
- **Backend:** Express 5 + TypeScript (`tsx` in dev, esbuild bundle in prod) — `server/`
- **Storage:** no database — the download history is `data/history.json` and the settings are
  `data/settings.json` (both git-ignored), written by `server/storage.ts` and `server/settings.ts`;
  shapes in `shared/schema.ts`
- **YouTube:** `youtube-dl-exec` wrapping a yt-dlp binary that `npm install` downloads into
  `node_modules/youtube-dl-exec/bin/` (`yt-dlp.exe` on Windows — no Python needed)
- **MP3:** `ffmpeg-static` (ffmpeg fetched by `npm install`; `FFMPEG_BIN` overrides it)

## Layout

- `server/index.ts` — entry point; Vite middleware in dev, static `dist/public` in prod
- `server/env.ts` — loads `.env`; imported first by `index.ts`
- `server/host-check.ts` — refuses unknown Host headers (DNS rebinding); `ALLOWED_HOSTS` adds names
- `server/routes.ts` — `POST /api/video/info`, `GET /api/search`, `GET /api/video/download`,
  `POST /api/video/save`, `GET/PUT /api/settings`, `GET/POST /api/folders`, `GET /api/downloads`
- `server/save.ts` — "Save to": the app saves a download into the chosen folder itself (works in any
  browser): same pipeline into `<name>.<ext>.part` (opened `wx`), renamed when complete, never
  replacing a file (`Song (1).mp3`); streams JSON-line progress (`saveEventSchema`)
- `server/settings.ts` — app settings (the Save to folder) in `data/settings.json` (`SETTINGS_FILE`)
- `server/folders.ts` — the folder browser (list/make folders, quick links — on Windows from the
  registry's User Shell Folders — writable check, `createNewFile()`, `availablePath()`)
- `server/local-only.ts` — `localOnly()`: folder routes answer only loopback, same-origin, JSON
  requests with no proxy headers; `GET /api/settings` says `canSaveToFolder: false` elsewhere
- `server/search.ts` — song search: `yt-dlp ytsearch12:` (flat, ~4s) + `rankResults()` (official
  uploads up; partial matches and live/cover/remix down unless searched for); pure parts unit-tested
- `server/spotify.ts` — Spotify song links (`/api/search?q=<link>`): title/artists/length from the
  public embed page `open.spotify.com/embed/track/<id>` (`__NEXT_DATA__`, no account or API key),
  then a YouTube search ranked with `targetDuration` (same length ±`SAME_LENGTH_SECONDS` first)
- `server/audio.ts` — yt-dlp and ffmpeg arguments (unit-tested), `fetchAudioInfo()` (metadata pass)
  and `startAudioPipeline()` (yt-dlp → ffmpeg, used by both download and save), yt-dlp error lines
- `server/youtube-url.ts` — pure URL-parsing and thumbnail helpers (unit-tested)
- `server/storage.ts` — `FileStorage`: newest 1,000 entries (`MAX_HISTORY`), queued writes,
  temp-file + rename
- `shared/` — schema and API contracts shared by client and server; `shared/filename.ts` has
  `safeFileName()`, used by the server to name downloads and by the page to show that name
- `client/src/pages/Home.tsx` — the whole UI; `client/src/components/ui/` holds only the shadcn/ui
  components in use — add more with `npx shadcn@latest add <name>` (config in `components.json`)
- `client/src/hooks/use-stored-choice.ts` — a choice remembered in localStorage; used for the MP3 /
  Original audio toggle (`use-download-format.ts`) and the Paste a link / Search by song switch
- `client/src/lib/format.ts` — `formatDuration()`, `isSpotifyLink()` and `asLink()` (a YouTube link
  is opened; a Spotify link or anything else is searched)
- `client/src/lib/save-to-folder.ts` + `hooks/use-save-settings.ts` — the page's side of "Save to":
  settings/folder API calls and `saveOnServer()` (reads the progress lines with `getReader()`).
  `components/folder-picker.tsx` is the folder browser (native `<dialog>`, portalled to `<body>`);
  `components/save-to-setting.tsx` sits under the search box, always visible — other devices get
  a note there instead
- `client/src/components/renameable-title.tsx` — the preview card's title; click it to rename the
  file (sent as `?name=` on the download link); Enter keeps, Esc cancels
- `client/src/lib/history-filter.ts` + `components/history-search.tsx` — searching Recent
  Extractions in the browser: word/partial matching, autocomplete suggestions (combobox; picking one
  filters to that exact title), date ranges, highlighting; the list pages 25 at a time
- `tests/unit` (no network), `tests/api` (Vitest + Supertest, real YouTube), `tests/browser`
  (Playwright, in Chrome and WebKit; Firefox on request)

## Commands

- `npm run dev` — dev server at http://localhost:5000 (nothing else needs to be running)
- `npm run check` — type-check
- `npx vitest run tests/unit` — fast unit tests
- `npx vitest run tests/api` — end-to-end API tests (needs internet)
- `npx playwright test` — browser tests in installed Google Chrome and WebKit (starts its own server on
  port 5099); `--project=chrome|webkit` for one; `E2E_BROWSERS=chrome,webkit,firefox` adds Firefox.
  First time: `npx playwright install chrome webkit firefox`
- `npx eslint .` and `npx prettier --check .`
- `npm run build`, then `npm start` — production bundle

## Local setup (Windows)

- No setup beyond `npm install`. `.env` is optional (`PORT`, `HOST`, `HISTORY_FILE`, `SETTINGS_FILE`,
  `FFMPEG_BIN`); shell variables override it. Delete `data/history.json` to clear the history.
- The API tests point `HISTORY_FILE`/`SETTINGS_FILE` at a temp folder, and the Playwright config starts its
  own server on port 5099 with a temp history and settings, so tests never touch the real ones.
- In PowerShell, `npm` may be blocked by the script execution policy — use `npm.cmd` (or `cmd.exe`).
- `npm install` / `npm rebuild youtube-dl-exec` need `YOUTUBE_DL_SKIP_PYTHON_CHECK=1` in the environment:
  the package's installer demands Python 3.9+ even though Windows' `yt-dlp.exe` doesn't use it.
- If `npm install` skips dev dependencies, `NODE_ENV=production` is set in that shell — unset it.

## Conventions and gotchas

- Keep everything cross-platform: set env vars in npm scripts with `cross-env`, never a bare
  `VAR=value` prefix; no `reusePort` in `listen()` (fails with ENOTSUP on Windows).
- Downloads stream yt-dlp stdout → ffmpeg stdin → response: `bestaudio` (best free stream, usually
  Opus ~130 kbps; no Premium/cookies) → 320k CBR MP3, LAME `-q 2`, ID3v2.3 tags. CBR is deliberate:
  a streamed VBR file has no seek header, so players show the wrong duration.
- A download (or save) owns two child processes, started by `startAudioPipeline()` in `audio.ts`,
  which swallows EPIPE on `ffmpeg.stdin` and kills yt-dlp once ffmpeg is done. The routes watch `res`
  "close" from the very start and call `stop()` on cancel. Unhandled stream errors or a missed kill
  mean a crashed server or processes left running forever, so re-test cancel paths after edits.
- `?format=original` (the "Original audio" toggle) skips re-encoding: ffmpeg `-c:a copy` into `.opus`
  (Ogg) for Opus, fragmented `.m4a` for AAC, `.mka` otherwise. The metadata pass uses the same
  `bestaudio` selector and the stream is pinned to its `format_id`, so container and codec match.
  The format enum and `buildDownloadUrl()` live in `shared/routes.ts`.
- The history search has no API: the page filters what `/api/downloads` returns. Keep that endpoint
  cheap (it's polled while a download runs) — the request log truncates JSON bodies to 200 chars.
- A download is added to the history only after it fully succeeds (both processes exit 0 and the
  response `finish`es) — never on cancel or failure. The page polls `/api/downloads` until it appears.
- Headers go out with the first chunk of audio, so failures before any audio become a `502`; don't
  write to `res` before the pipeline produces output.
- Download names: always `safeFileName()` + `res.attachment()` (ASCII `filename` plus UTF-8
  `filename*`), so accents and non-Latin titles survive. Linux Chromium with no UTF-8 locale
  (`LANG` unset) can't use non-ASCII file names — run such browsers with `LANG=C.UTF-8`.
- Search spawns yt-dlp directly (no shell) with the query after `--`; keep it that way so search
  text can't become a command or a yt-dlp option. Results carry their own title/thumbnail, so
  picking one needs no `/api/video/info` call.
- Spotify: only the validated 22-character track id goes into the one embed URL we fetch (no
  user-controlled URLs are ever fetched). If Spotify links break, check the embed page's
  `__NEXT_DATA__` shape first (`parseEmbedPage()`); the cloud workspace can't reach Spotify.
- "Save to" folder: download links stay real `<a href download>` elements — `startDownload()` only
  calls `preventDefault()` (and `POST /api/video/save` instead) when a folder is set — so the default
  path and its tests are unchanged. Anything that reads or writes the user's disk must sit behind
  `localOnly()`. A save's lifetime is its connection: aborting the fetch (Cancel, closing the tab)
  kills the pipeline and deletes the `.part` file, so re-test cancel paths after edits here too.
- Every feature must work in current Chrome, Edge, Firefox and Safari (build target: Safari 16+). No
  browser-only APIs; no regex lookbehind (Safari < 16.4 throws) and no `for await` over streams —
  `tests/unit/browser-support.test.ts` checks. Playwright runs every test in Chrome and WebKit, and
  in Firefox only via `E2E_BROWSERS`: on this Windows 10 PC Playwright's Firefox and Chromium builds
  fail to start (side-by-side configuration error), which is also why Chrome is the installed one
  (`channel: "chrome"`). The installed Firefox works over BiDi (`channel: "moz-firefox"`), but BiDi's
  `fill()` doesn't reach React inputs — type with `pressSequentially()` there.
- yt-dlp needs a JavaScript runtime for YouTube; we pass `--js-runtimes node` via `YT_DLP_BASE_FLAGS`.
- If extraction suddenly breaks, update yt-dlp before debugging code: `npm rebuild youtube-dl-exec`
  (with `YOUTUBE_DL_SKIP_PYTHON_CHECK=1` set).
- Prettier config is in `.prettierrc` (`endOfLine: auto`, so CRLF checkouts on Windows are fine).
- Dependencies: runtime imports only in `dependencies`, everything else in `devDependencies`.
  `npm audit` should stay at 0. npm 10 crashes resolving this tree from scratch (`edgesOut`), so
  add/update packages with `npx npm@11 …`; plain `npm install` from the lockfile is fine.
  If a newer npm blocks install scripts, approve the ones the app needs:
  `npm install-scripts approve esbuild ffmpeg-static youtube-dl-exec` (they fetch esbuild, ffmpeg, yt-dlp).
- Don't make Vite errors exit the process (the old Replit template did) — a refused request or a
  half-saved file would kill the dev server.

## Workflow

- Commit to `main` after each completed milestone (a feature, fix or cleanup that is done and
  tested) without asking first, then push to `origin/main`. Keep each commit to one milestone with a
  descriptive message; don't commit half-finished work.
