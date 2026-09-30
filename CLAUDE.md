# YouTube → audio extractor

Small full-stack app: paste a YouTube URL (or search for a song), preview it, download the audio
track. Developed and run locally on Windows (it also works on macOS/Linux). `README.md` is the user
guide, `TECHNICAL.md` has architecture, setup and deployment details, and `LEARNING.md` maps the
stack onto .NET concepts.

## Stack

- **Frontend:** React 18 + Vite, wouter (routing), TanStack Query, shadcn/ui, Tailwind — `client/`
- **Backend:** Express 5 + TypeScript (`tsx` in dev, esbuild bundle in prod) — `server/`
- **Storage:** no database — the download history is `data/history.json` (git-ignored), written by
  `server/storage.ts`; entry shape in `shared/schema.ts`
- **YouTube:** `youtube-dl-exec` wrapping a yt-dlp binary that `npm install` downloads into
  `node_modules/youtube-dl-exec/bin/` (`yt-dlp.exe` on Windows — no Python needed)
- **MP3:** `ffmpeg-static` (ffmpeg fetched by `npm install`; `FFMPEG_BIN` overrides it)

## Layout

- `server/index.ts` — entry point; Vite middleware in dev, static `dist/public` in prod
- `server/env.ts` — loads `.env`; imported first by `index.ts`
- `server/host-check.ts` — refuses unknown Host headers (DNS rebinding); `ALLOWED_HOSTS` adds names
- `server/routes.ts` — `POST /api/video/info`, `GET /api/search`, `GET /api/video/download`,
  `GET /api/downloads`
- `server/search.ts` — song search: `yt-dlp ytsearch12:` (flat, ~4s) + `rankResults()` (official
  uploads up; partial matches and live/cover/remix down unless searched for); pure parts unit-tested
- `server/audio.ts` — yt-dlp and ffmpeg arguments/spawning for the MP3 pipeline (unit-tested)
- `server/youtube-url.ts` — pure URL-parsing and thumbnail helpers (unit-tested)
- `server/storage.ts` — `FileStorage`: newest 100 entries, queued writes, temp-file + rename
- `shared/` — schema and API contracts shared by client and server
- `client/src/pages/Home.tsx` — the whole UI; `client/src/components/ui/` holds only the shadcn/ui
  components in use — add more with `npx shadcn@latest add <name>` (config in `components.json`)
- `client/src/hooks/use-stored-choice.ts` — a choice remembered in localStorage; used for the MP3 /
  Original audio toggle (`use-download-format.ts`) and the Paste a link / Search by song switch
- `client/src/lib/format.ts` — `formatDuration()` and `asLink()` (a link is opened, anything else searched)
- `tests/unit` (no network), `tests/api` (Vitest + Supertest, real YouTube), `tests/browser` (Playwright)

## Commands

- `npm run dev` — dev server at http://localhost:5000 (nothing else needs to be running)
- `npm run check` — type-check
- `npx vitest run tests/unit` — fast unit tests
- `npx vitest run tests/api` — end-to-end API tests (needs internet)
- `npx playwright test` — browser tests (starts `npm run dev` if nothing is on port 5000)
- `npx eslint .` and `npx prettier --check .`
- `npm run build`, then `npm start` — production bundle

## Local setup (Windows)

- No setup beyond `npm install`. `.env` is optional (`PORT`, `HOST`, `HISTORY_FILE`, `FFMPEG_BIN`);
  shell variables override it. Delete `data/history.json` to clear the history.
- The API tests point `HISTORY_FILE` at a temp folder, and the Playwright config starts its own server on
  port 5099 with a temp history, so tests never touch the real history.
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
- The download route owns two child processes. It watches `res` "close" from the very start and
  kills both on cancel, and swallows EPIPE on `ffmpeg.stdin`. Unhandled stream errors or a missed
  kill mean a crashed server or processes left running forever, so re-test cancel paths after edits.
- `?format=original` (the "Original audio" toggle) skips re-encoding: ffmpeg `-c:a copy` into `.opus`
  (Ogg) for Opus, fragmented `.m4a` for AAC, `.mka` otherwise. The metadata pass uses the same
  `bestaudio` selector and the stream is pinned to its `format_id`, so container and codec match.
  The format enum and `buildDownloadUrl()` live in `shared/routes.ts`.
- A download is added to the history only after it fully succeeds (both processes exit 0 and the
  response `finish`es) — never on cancel or failure. The page polls `/api/downloads` until it appears.
- Headers go out with the first chunk of audio, so failures before any audio become a `502`; don't
  write to `res` before the pipeline produces output.
- Search spawns yt-dlp directly (no shell) with the query after `--`; keep it that way so search
  text can't become a command or a yt-dlp option. Results carry their own title/thumbnail, so
  picking one needs no `/api/video/info` call.
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
