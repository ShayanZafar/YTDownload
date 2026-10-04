# YouTube → audio extractor

Small full-stack app: paste a YouTube URL (or search for a song, paste a Spotify song link, or pick
songs from a Spotify playlist — with a Save to folder, it shows which are already there and downloads
the rest), preview it, download the audio track — and play your music: the Save to folder's songs
on the computer running the app, or songs picked on a phone. Developed on Windows, and works the same
on macOS and Linux (CI checks Linux and Windows on every push, macOS weekly — `.github/workflows/tests.yml`).
`README.md` is the user guide, `docs/run/README.md` says how to
install and run it (the ready-to-run build, scripts, terminal, phone, hosting), `TECHNICAL.md` has
architecture, setup and deployment details, and `LEARNING.md` maps the stack onto .NET concepts.

## Stack

- **Frontend:** React 19 + Vite 8, wouter (routing), TanStack Query, shadcn/ui, Tailwind CSS 4 — `client/`
- **Backend:** Express 5 + TypeScript (`tsx` in dev, esbuild bundle in prod) — `server/`
- **Storage:** no database — the download history is `data/history.json` and the settings are
  `data/settings.json` (both git-ignored), written by `server/storage.ts` and `server/settings.ts`;
  shapes in `shared/schema.ts`
- **YouTube:** `youtube-dl-exec` wrapping a yt-dlp binary that `npm install` downloads into
  `node_modules/youtube-dl-exec/bin/` (`yt-dlp.exe` on Windows — no Python needed)
- **MP3:** `ffmpeg-static` (ffmpeg fetched by `npm install`; `FFMPEG_BIN` overrides it)
- **Tags:** `music-metadata` reads the audio files' tags in the Save to folder (`server/library.ts`),
  and — its browser build, loaded on demand — the tags of songs picked on a phone for the player

## Layout

- `server/index.ts` — entry point; Vite middleware in dev, static `dist/public` in prod
- `server/env.ts` — loads `.env`; imported first by `index.ts`
- `server/host-check.ts` — refuses unknown Host headers (DNS rebinding); `ALLOWED_HOSTS` adds names
- `server/routes.ts` — `POST /api/video/info`, `GET /api/search`, `GET /api/spotify/playlist`,
  `GET /api/video/download`, `POST /api/video/save`, `GET/PUT /api/settings`, `GET/POST /api/folders`,
  `POST /api/folders/songs`, `GET /api/music` (+ `/api/music/:id`, `/:id/flac`, `/:id/cover`),
  `GET /api/downloads`
- `server/save.ts` — "Save to": the app saves a download into the chosen folder itself (works in any
  browser): same pipeline into `<name>.<ext>.part` (opened `wx`), renamed when complete, never
  replacing a file (`Song (1).mp3`); streams JSON-line progress (`saveEventSchema`)
- `server/settings.ts` — app settings (the Save to folder) in `data/settings.json` (`SETTINGS_FILE`)
- `server/library.ts` — which of a playlist's songs are in the Save to folder (`POST /api/folders/songs`):
  walks it and its subfolders (≤6 deep, ≤`MAX_SONG_FILES`), reads tags (cached per file until it
  changes), and `findSongs()` matches by the Spotify id in the tags, else title + an artist (tags, file
  name, folder names), else an exact file name with no contradicting artist tag. Pure parts unit-tested.
  `readFolderTags()` (the scan + tags) also feeds the player; `oggDuration()` reads an Ogg file's
  length from its last page (music-metadata would read the whole file)
- `server/music.ts` — the music player's side of the Save to folder (`GET /api/music…`, local-only):
  the songs by id (`musicTrackId()`: the place in the folder, hashed — the page never sends a path),
  `readCover()`, and `convertedForBrowser()`: a song the browser can't play, as FLAC (lossless) in
  `PLAYER_CACHE_DIR` (temp folder, ≤2 GB, oldest-played go first); requests share one conversion,
  and when all of them are gone ffmpeg is killed and the `.part` deleted
- `server/folders.ts` — the folder browser (list/make folders, quick links — on Windows from the
  registry's User Shell Folders — writable check, `createNewFile()`, `availablePath()`)
- `server/local-only.ts` — `localOnly()`: folder routes answer only loopback, same-origin, JSON
  requests with no proxy headers; `GET /api/settings` says `canSaveToFolder: false` elsewhere
- `server/search.ts` — song search: `yt-dlp ytsearch12:` (flat, ~4s) + `rankResults()` (official
  uploads up; partial matches and live/cover/remix down unless searched for); pure parts unit-tested
- `server/spotify.ts` — Spotify song links (`/api/search?q=<link>`): title/artists/length from the
  public embed page `open.spotify.com/embed/track/<id>` (`__NEXT_DATA__`, no account or API key),
  then a YouTube search ranked with `targetDuration` (same length ±`SAME_LENGTH_SECONDS` first).
  Playlists and albums (`/api/spotify/playlist?link=`): the songs from `embed/playlist|album/<id>`
  (`parsePlaylistPage()`; Spotify lists at most 100 songs of a playlist there → `maybeMore`)
- `server/audio.ts` — yt-dlp and ffmpeg arguments (unit-tested), `fetchAudioInfo()` (metadata pass)
  and `startAudioPipeline()` (yt-dlp → ffmpeg, used by both download and save), yt-dlp error lines
- `server/youtube-url.ts` — pure URL-parsing and thumbnail helpers (unit-tested)
- `server/storage.ts` — `FileStorage`: newest 1,000 entries (`MAX_HISTORY`), queued writes,
  temp-file + rename
- `shared/` — schema and API contracts shared by client and server; `shared/filename.ts` has
  `safeFileName()`, used by the server to name downloads and by the page to show that name;
  `shared/spotify-names.ts` has `cleanTrackTitle()` and `spotifyFileName()` ("Artists - Title", the
  default name of any download found from Spotify); `shared/audio-types.ts` has `AUDIO_TYPES` (the
  audio files the app knows: MIME type, and what to ask `canPlayType()`)
- `client/src/pages/Home.tsx` — the whole UI; `client/src/components/ui/` holds only the shadcn/ui
  components in use — add more with `npx shadcn@latest add <name>` (config in `components.json`)
- `client/src/hooks/use-stored-choice.ts` — a choice remembered in localStorage; used for the MP3 /
  Original audio toggle (`use-download-format.ts`) and the Link / Search / Spotify playlist switch;
  `use-stored-value.ts` remembers free text (the open playlist's link)
- `client/src/lib/format.ts` — `formatDuration()`, `isSpotifyLink()`, `isSpotifyPlaylistLink()` and
  `asLink()` (a YouTube link is opened, a playlist/album link opens the panel, anything else is
  searched)
- `client/src/components/spotify-playlist.tsx` — the playlist panel: lists the songs (filter); picking
  one searches its song link. With a Save to folder: In folder marks and counts
  (`hooks/use-songs-in-folder.ts`, refetched on focus and after saves), a Not in folder view, tick
  boxes and Download (`hooks/use-download-all.ts`: one song at a time — search, `confidentMatch()`
  (same length as on Spotify) or mark "check", then `saveOnServer()`; Stop aborts). Without a folder:
  Downloaded marks from history entries' `spotifyId`. Downloads carry `spotifyId` (history + file tag)
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
- The music player: `hooks/use-player.tsx` (`PlayerProvider` in `App.tsx`: one `<audio>` for the
  page, queue/shuffle/repeat, the FLAC fallback for folder songs, Media Session) and
  `components/player-bar.tsx` (fixed to the bottom; rendered by `layout.tsx`). `components/music-library.tsx`
  is "Your music": the folder's songs (`hooks/use-folder-music.ts`) or songs picked on the device
  (`hooks/use-device-music.ts`, `lib/device-music.ts`: tags read in the page, played from blob URLs);
  `lib/music.ts` has the pure parts (songs, sort/filter, play order; unit-tested)
- `scripts/build.ts` — the production build (`npm run build`). `scripts/windows/` — double-click
  helpers for running the app (`start.cmd`, `stop.cmd`, `update.cmd`, `update-yt-dlp.cmd`,
  `autostart-on/off.cmd`), all thin wrappers around `app.ps1`. Keep `app.ps1` Windows PowerShell
  5.1-compatible and plain ASCII, with CRLF line endings (`.gitattributes`;
  `tests/unit/windows-scripts.test.ts` checks). `stop` only kills the app's own process tree: from
  the server's `node.exe` up through its launchers (npm, `cross-env`, `start.cmd`/`Start.cmd`), never
  the terminal, editor or Explorer above them. The scripts serve two kinds of copy, told apart by
  `server\index.ts`: the source (installs everything, runs `npm run dev`) and a ready-to-run build
  (`npm ci --omit=dev`, `npm start`)
- `.github/workflows/install.yml` — after every push to `main`, builds the app on GitHub and
  force-pushes the ready-to-run result to the `install` branch as a single commit: `dist/`,
  `package*.json`, the Windows scripts and `scripts/install/` (README with the build filled in,
  `.gitignore`, `Start/Stop/Update.cmd` shortcuts — one line each, as `Update.cmd` replaces them
  while they run). PCs `git clone --depth 1 --branch install`; `update.cmd` fetches and resets
  (no history to merge). Never commit to `install` by hand
- `.github/workflows/tests.yml` — `npm ci`, yt-dlp/ffmpeg run, type-check, unit tests + the music API
  test, lint on Linux and Windows after every push (macOS on Mondays / by hand: its minutes count
  10×). The YouTube API and browser tests aren't run there (GitHub's machines get refused)
- `scripts/yt-dlp.mjs` — the `postinstall`: on macOS/Linux, swaps youtube-dl-exec's Python yt-dlp
  (needs Python 3.10+) for yt-dlp's standalone build (`yt-dlp_macos`, `yt-dlp_linux[_aarch64]`,
  musl builds); a no-op on Windows (`yt-dlp.exe` is standalone). `--update` (`npm run
update-yt-dlp`) runs `yt-dlp -U`. Plain JS, no packages — the install branch ships it too
- `client/public/` — `manifest.webmanifest` and the icons (tab, phones' home screens), drawn by
  `scripts/make-icons.ts` with Chrome (`npx tsx scripts/make-icons.ts`; `tests/unit/web-app.test.ts`)
- `tests/unit` (no network), `tests/api` (Vitest + Supertest, real YouTube), `tests/browser`
  (Playwright, in Chrome and WebKit; Firefox on request). The player's tests (`music*.test.ts`,
  `player.spec.ts`) make their own songs with ffmpeg — no YouTube needed

## Commands

- `npm run dev` — dev server at http://localhost:5000 (nothing else needs to be running);
  `scripts\windows\start.cmd` does the same with install checks and opens the browser
- `npm run check` — type-check
- `npx vitest run tests/unit` — fast unit tests
- `npx vitest run tests/api` — end-to-end API tests (needs internet)
- `npx playwright test` — browser tests in installed Google Chrome and WebKit (starts its own server on
  port 5099); `--project=chrome|webkit` for one; `E2E_BROWSERS=chrome,webkit,firefox` adds Firefox.
  First time: `npx playwright install chrome webkit firefox`
- `npx eslint .` and `npx prettier --check .`
- `npm run build`, then `npm start` — production bundle
- `npm run update-yt-dlp` — the newest yt-dlp, on any system (Windows: `update-yt-dlp.cmd` too)

## Local setup (Windows, macOS, Linux)

- No setup beyond `npm install` (Node 24 LTS; no Python on any system). `.env` is optional (`PORT`,
  `HOST`, `HISTORY_FILE`, `SETTINGS_FILE`, `FFMPEG_BIN`, `PLAYER_CACHE_DIR`); shell variables override
  it. Delete `data/history.json` to clear the history.
- The API tests point `HISTORY_FILE`/`SETTINGS_FILE` at a temp folder, and the Playwright config starts its
  own server on port 5099 with a temp history and settings, so tests never touch the real ones.
- `npm install` needs `YOUTUBE_DL_SKIP_PYTHON_CHECK=1` in the environment on a system without Python
  3.9+: youtube-dl-exec's installer demands it though the app doesn't use Python (`yt-dlp.exe` on
  Windows; `scripts/yt-dlp.mjs` installs the standalone build on macOS/Linux afterwards). Don't use
  `npm rebuild youtube-dl-exec` on macOS/Linux — it brings back the Python yt-dlp until
  `node scripts/yt-dlp.mjs` runs again; `npm run update-yt-dlp` updates it in place.
- In PowerShell, `npm` may be blocked by the script execution policy — use `npm.cmd` (or `cmd.exe`).
- If `npm install` skips dev dependencies, `NODE_ENV=production` is set in that shell — unset it.
- This PC's global npm is 11.21 (npm 12 needs Node 24.15+; this PC has 24.13). npm 10 rewrote
  `package-lock.json` without the `libc` fields — never use it on this repo.

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
- A download with `spotifyId` is tagged with it — ID3 `TXXX:spotify_id` (MP3), `SPOTIFY_ID` (.opus/.mka),
  or the song's link as the comment of an .m4a (the ipod muxer drops custom keys; `use_metadata_tags`
  breaks the standard ones) — and with Spotify's title/artists (`spotifySongTags()`, ≤5 s, else
  YouTube's). That tag is how the playlist panel recognises the app's own files after a rename.
- `music-metadata` is ESM-only and describes `parseFile` only under the "node" exports condition, which
  TypeScript's `bundler` resolution ignores: `library.ts` loads it with `import()` and types it by hand.
  Regexes with the `u` flag (`\p{L}`) must be built with `new RegExp(...)`: tsc refuses the literal at
  this project's default ES5 target.
- "Download all" stays one song at a time, and never downloads a match that isn't the same length as
  the Spotify song: unattended picks must be near-certain, and bursts of downloads invite YouTube's
  bot checks.
- Spotify: only a validated kind (track/playlist/album) and 22-character id go into the embed URL we
  fetch (no user-controlled URLs are ever fetched). If Spotify links break, check the embed page's
  `__NEXT_DATA__` shape first (`parseEmbedPage()`, `parsePlaylistPage()`); the cloud workspace can't
  reach Spotify. No sign-in on purpose: since Feb 2026 Spotify's Web API Development Mode needs the
  app owner to have Premium, and the app must stay free — so only public playlists, first 100 songs.
- "Save to" folder: download links stay real `<a href download>` elements — `startDownload()` only
  calls `preventDefault()` (and `POST /api/video/save` instead) when a folder is set — so the default
  path and its tests are unchanged. Anything that reads or writes the user's disk must sit behind
  `localOnly()`. A save's lifetime is its connection: aborting the fetch (Cancel, closing the tab)
  kills the pipeline and deletes the `.part` file, so re-test cancel paths after edits here too.
- Music player: songs play untouched (the browser decodes the file, like VLC). Start a song inside the
  click that asked for it — `player.play()` calls `audio.play()` synchronously; phones refuse `play()`
  outside a tap, so don't move it into an effect — and keep the one `<audio>` element, which may then
  move on by itself. The Save to folder's songs are local-only (`/api/music…` behind `localOnly()`)
  and asked for by id, never by path. Songs picked on another device never reach the server. A
  folder song the browser can't play (`canPlayType()` says "", or it fails to load) is converted to
  FLAC; re-test skipping during a conversion after edits (ffmpeg must stop, no `.part` left).
  Playwright's WebKit on Windows plays media through Media Foundation: opening a song blocks the page
  for several seconds (give such clicks a long timeout), it can't play blob: URLs, and it plays WMA
  but not Ogg/Opus or AIFF — `player.spec.ts` asks the browser instead of assuming.
- Every feature must work in current Chrome, Edge, Firefox and Safari (oldest: Chrome/Edge 111,
  Firefox 128, Safari 16.4 — Vite 8's build target and Tailwind CSS 4's minimum). No browser-only APIs,
  and no `for await` over streams — `tests/unit/browser-support.test.ts` checks. Playwright runs every test in Chrome and WebKit, and
  in Firefox only via `E2E_BROWSERS`: on this Windows 10 PC Playwright's Firefox and Chromium builds
  fail to start (side-by-side configuration error), which is also why Chrome is the installed one
  (`channel: "chrome"`). The installed Firefox works over BiDi (`channel: "moz-firefox"`), but BiDi's
  `fill()` doesn't reach React inputs — type with `pressSequentially()` there. Playwright's WebKit on
  Windows draws in software and waits for 5 still frames before each click (1 elsewhere), so keep
  the page still when nothing's happening: a never-ending animation (the hero's dot used to pulse)
  repaints it every frame, and with a `blur(120px)` background glow (now a gradient, `.ambient-glow`)
  each repaint took ~1 s — clicks took ~10 s and long tests timed out. No endless decorative
  animations or big `blur()` areas. Slow frames delay network answers too, so a late answer must
  never undo what the user did meanwhile.
- yt-dlp needs a JavaScript runtime for YouTube; we pass `--js-runtimes node` via `YT_DLP_BASE_FLAGS`.
- If extraction suddenly breaks, update yt-dlp before debugging code: `npm run update-yt-dlp`.
- Prettier config is in `.prettierrc` (`endOfLine: auto`, so CRLF checkouts on Windows are fine).
- Dependencies: runtime imports only in `dependencies`, everything else in `devDependencies`.
  `npm audit` should stay at 0. Use npm 11+ (npm 10 crashes resolving this tree from scratch and drops
  the lockfile's `libc` fields). `allowScripts` in package.json approves, by name, the install scripts
  the app needs — esbuild, ffmpeg-static (ffmpeg), youtube-dl-exec (yt-dlp); npm 12 blocks all others.
  Everything is on its newest version except TypeScript (6.0: typescript-eslint supports < 6.1, not
  the native TypeScript 7 yet) and `@types/node` (follows the Node the app runs on, 24).
- Tailwind CSS 4: no `tailwind.config.ts` — the theme is `@theme` in `client/src/index.css`, which
  scans `client/` only (`source('..')`); custom classes are `@utility`; animations come from
  `tw-animate-css`; the plugin is `@tailwindcss/vite` (no PostCSS config). Zod 4: messages go in an
  `error` option, errors are `.issues`, `z.record()` takes a key schema.
- Don't make Vite errors exit the process (the old Replit template did) — a refused request or a
  half-saved file would kill the dev server.

## Workflow

- Commit to `main` after each completed milestone (a feature, fix or cleanup that is done and
  tested) without asking first, then push to `origin/main`. Keep each commit to one milestone with a
  descriptive message; don't commit half-finished work. Each push rebuilds the `install` branch that
  PCs update from (the workflow doesn't run the tests), so only push what passes them.
