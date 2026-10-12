# YouTube → audio extractor

Small full-stack app: paste a YouTube URL (or search for a song, paste a Spotify song link, or pick
songs from a Spotify or YouTube playlist — with a Save to folder, it shows which are already there
and downloads the rest), preview it, download the audio track — from YouTube, or from SoundCloud
when YouTube can't answer — and play your music: the Save to folder's songs
on the computer running the app, or songs picked on a phone. Developed on Windows, and works the same
on macOS and Linux (CI checks Linux and Windows on every push, macOS weekly — `.github/workflows/tests.yml`).
`README.md` is the user guide, `docs/run/README.md` says how to
install and run it (the ready-to-run build, scripts, terminal, phone, hosting), `TECHNICAL.md` has
architecture, setup and deployment details, `docs/sources.md` is the register of the outside
sources (YouTube, SoundCloud, Spotify: primary, fallbacks, what "unreliable" means, what was
rejected), and `LEARNING.md` maps the stack onto .NET concepts.

## Stack

- **Frontend:** React 19 + Vite 8, wouter (routing), TanStack Query, shadcn/ui, Tailwind CSS 4 — `client/`
- **Backend:** Express 5 + TypeScript (`tsx` in dev, esbuild bundle in prod) — `server/`
- **Storage:** no database — the download history is `data/history.json`, the settings are
  `data/settings.json` and the source-health report is `data/source-health.json` (all git-ignored),
  written by `server/storage.ts`, `server/settings.ts` and `server/source-health.ts`; shapes in
  `shared/schema.ts`
- **YouTube and SoundCloud:** `youtube-dl-exec` wrapping a yt-dlp binary that `npm install` downloads
  into `node_modules/youtube-dl-exec/bin/` (`yt-dlp.exe` on Windows — no Python needed); SoundCloud
  through the same yt-dlp, with no key or account
- **MP3:** `ffmpeg-static` (ffmpeg fetched by `npm install`; `FFMPEG_BIN` overrides it)
- **Tags:** `music-metadata` reads the audio files' tags in the Save to folder (`server/library.ts`),
  and — its browser build, loaded on demand — the tags of songs picked on a phone for the player

## Layout

- `server/index.ts` — entry point; Vite middleware in dev, static `dist/public` in prod
- `server/env.ts` — loads `.env`; imported first by `index.ts`
- `server/host-check.ts` — refuses unknown Host headers (DNS rebinding); `ALLOWED_HOSTS` adds names
- `server/routes.ts` — `POST /api/video/info`, `GET /api/search` (`?source=soundcloud`: SoundCloud
  alone), `GET /api/spotify/link`, `GET /api/spotify/playlist`, `GET /api/youtube/playlist`,
  `GET /api/video/download`, `POST /api/video/save`, `GET/PUT /api/settings` (with `cpuCores`),
  `GET/POST /api/folders`, `POST /api/folders/songs`, `POST /api/folders/playlist-file`,
  `GET /api/music` (+ `/api/music/:id`, `/:id/flac`, `/:id/cover`), `GET/DELETE /api/downloads`,
  `DELETE /api/downloads/:id`, `POST /api/downloads/restore` (Undo), `GET /api/lyrics`,
  `GET /api/health/sources`
- `server/youtube-limits.ts` — `youtubeGuard`, which every yt-dlp call to YouTube but the audio stream
  goes through (search, video info, playlists, the metadata pass before a download): a 10-minute
  cache of search/video/playlist answers (`TtlCache`, 200 entries, LRU) and
  `classifyYtDlpError()` (throttled / bot-check / broken / unavailable / other). Every call is made
  at once — nothing gates, holds back or delays one. A throttled or bot-check failure throws
  `YouTubeRefused`, which the routes answer at once with a `502` through `sendRefused()` —
  `{ message, source: "youtube", limited: true }`, the message saying what to do instead — download
  and save too when nothing has been sent yet (`pipelineEnded()`); it's remembered for 10 minutes
  (`refusedRecently()`, `HEDGE_FOR_MS`), during which searches ask SoundCloud at the same time as
  YouTube. A broken/bot-check failure also starts the yt-dlp self-update in the background (nobody
  waits for it). Pure parts take the time as an argument; unit-tested with a fake clock
- `server/yt-dlp-update.ts` — `YtDlpUpdater`: runs `node scripts/yt-dlp.mjs --update` (what
  `npm run update-yt-dlp` runs; never through a shell) at most once an hour, 2-minute limit, one
  log line at the start and one at the end; a failed update counts as the hour's try
- `server/source-health.ts` — records every attempt against `youtube` (primary for audio),
  `soundcloud` (its fallback), `spotify` (primary for song details), `spotify-oembed` (its
  fallback) and `spotify-web-api` (primary for a playlist's songs past 100; no fallback) — ok, or
  throttled / blocked / error with a note, and a 429's Retry-After (`until`); the last 24 h, ≤500
  events, in memory — and writes the report to `data/source-health.json` (`SOURCE_HEALTH_FILE`;
  debounced, temp file + rename): per source
  `role`/`for`/`ok`/`failed`/`throttled`/`lastOk`/`lastError`/`refusedUntil`, `unreliable` (a
  primary with ≥5 attempts and under half successful, or refusing the app for more than another
  hour — `REFUSED_FOR_MS`, the owner's decision of Oct 12, 2026 — and every fallback for its job
  unreliable too, or none) and a one-sentence `summary`; such a refusal also rewrites the file
  when it stops counting and when it ends. `GET /api/health/sources` serves it
  (not local-only; no paths in it). Pure parts unit-tested with a fake clock
- `server/save.ts` — "Save to": the app saves a download into the chosen folder itself (works in any
  browser): same pipeline into `<name>.<ext>.part` (opened `wx`), renamed when complete onto a name
  claimed with `wx` too (`claimNewName()`), so saves finishing together never take the same name and
  none waits for another — never replacing a file (`Song (1).mp3`); streams JSON-line progress
  (`saveEventSchema`)
- `server/settings.ts` — app settings (the Save to folder) in `data/settings.json` (`SETTINGS_FILE`)
- `server/library.ts` — which of a playlist's songs are in the Save to folder (`POST /api/folders/songs`):
  walks it and its subfolders (≤6 deep, ≤`MAX_SONG_FILES`), reads tags (one file per CPU core;
  cached per file until it changes), and `findSongs()` matches by the Spotify id in the tags, else title + an artist (tags, file
  name, folder names), else an exact file name with no contradicting artist tag. Pure parts unit-tested.
  `readFolderTags()` (the scan + tags) also feeds the player; `oggDuration()` reads an Ogg file's
  length from its last page (music-metadata would read the whole file)
- `server/playlist-file.ts` — "Save playlist file" (`POST /api/folders/playlist-file`, local-only): the
  playlist's songs found in the Save to folder (`songsInFolder()` — the page sends songs, never a
  path), written there as "<name>.m3u8" in the playlist's order; replaces only a file with the app's
  `PLAYLIST_FILE_MARK` line, else "<name> (1).m3u8". Pure parts unit-tested
- `server/music.ts` — the music player's side of the Save to folder (`GET /api/music…`, local-only):
  the songs by id (`musicTrackId()`: the place in the folder, hashed — the page never sends a path),
  `readCover()`, and `convertedForBrowser()`: a song the browser can't play, as FLAC (lossless) in
  `PLAYER_CACHE_DIR` (temp folder, ≤2 GB, oldest-played go first); requests share one conversion,
  and when all of them are gone ffmpeg is killed and the `.part` deleted
- `server/folders.ts` — the folder browser (list/make folders, quick links — on Windows from the
  registry's User Shell Folders — writable check), and new files that never replace one:
  `createNewFile()` (the `.part`) and `claimNewName()` (the finished name), both opened `wx`
- `server/cpu-cores.ts` — `cpuCores()` (`os.availableParallelism()`: how many things the app does at
  once wherever it can — Download all's songs, the folder's tag reads, a long Spotify playlist's
  pages) and `mapAtOnce()` (one per core, results in order)
- `server/local-only.ts` — `localOnly()`: folder routes answer only loopback, same-origin, JSON
  requests with no proxy headers; `GET /api/settings` says `canSaveToFolder: false` elsewhere
- `server/search.ts` — song search: `yt-dlp ytsearch12:` (flat, ~4s) + `rankResults()` (official
  uploads up; partial matches and live/cover/remix down unless searched for), and SoundCloud's
  `scsearch12:` ranked the same way (30-second previews last). `searchSongs()` always asks YouTube;
  SoundCloud at once when YouTube's search fails or finds nothing, and at the same time while YouTube
  has refused in the last 10 minutes (hedging); YouTube's results when it has some, else
  SoundCloud's — each result and the answer carry `source`. `searchSoundCloudOnly()` for
  `?source=soundcloud`. SoundCloud's answers are cached like YouTube's; pure parts unit-tested
- `server/soundcloud.ts` — SoundCloud, the fallback for audio: `soundCloudResult()` (a search entry
  as a result with its canonical link), `looksLikePreview()` (a 30-second preview of a
  subscribers-only track), `lookUpSoundCloud()` (the look-up before a download, recorded in source
  health; refuses a preview: yt-dlp's format id ends "_preview"), `recordSoundCloud()`
- `server/audio-source.ts` — `lookUpAudio()` and `audioEnded()`: the download and save routes' look-up
  and end of stream for a YouTube video (through `youtubeGuard`) or a SoundCloud track
- `server/spotify.ts` — Spotify song links (`/api/search?q=<link>`): title/artists/length from the
  public embed page `open.spotify.com/embed/track/<id>` (`__NEXT_DATA__`, no account or API key),
  then a search ranked with `targetDuration` (same length ±`SAME_LENGTH_SECONDS` first;
  `spotifySearchQuery()` adds "audio" for YouTube, not SoundCloud).
  A download's album, track number, release date and 640 px cover come from the song's own page
  (`open.spotify.com/track/<id>` fetched with a curl User-Agent, which gets its link-preview `<meta>`
  tags: `parseTrackPage()`).
  Every Spotify request goes through `fetchSpotify()`: recorded in source health, never retried or
  delayed. A song's details from the embed page are kept 10 minutes (`spotifyTrackCache`; Download
  all asks about each song more than once). When the embed page fails for any reason but 404 (a 429 included), at once,
  `fetchSpotifyTrack()` falls back to the keyless oEmbed endpoint
  (`fetchOembedTrack()`, `parseOembed()`): title and cover only — artists `[]`, `duration: null`,
  `source: "spotify-oembed"` on the track (optional field in `spotifyTrackSchema`); the page then
  searches by title and "Download all" marks such a song "check".
  Playlists and albums (`/api/spotify/playlist?link=`): the songs from `embed/playlist|album/<id>`
  (`parsePlaylistPage()`; Spotify lists at most 100 songs of a playlist there), and past 100 the
  rest from the Web API with the embed page's anonymous pass (`readEmbedAccessToken()`,
  `fetchMorePlaylistSongs()`: the first page gives the total, the rest are asked for together, one
  per CPU core; ≤`SPOTIFY_PLAYLIST_MAX_SONGS`). Why it stopped short goes in the answer's `more`
  (`reason`: `refused` — a 429 with Retry-After, `parseRetryAfter()` — `failed`, `spotify-own` —
  Spotify's own playlists answer 404 — or `limit`; `retryAt`, `note`) next to `maybeMore`. A
  refusal is the route's quota, not one pass's: `webApiRefusal` remembers it until its Retry-After,
  and meanwhile playlists open with their first 100 songs without asking the Web API
  `spotify.link` short links: `resolveShortLink()` asks Spotify's short-link host where it leads
  (redirects followed only between `spotify.link`/`spotify.app.link`); `GET /api/spotify/link`
  tells the page where one leads, so it can search or open the playlist panel
- `server/youtube-playlist.ts` — YouTube playlists (`/api/youtube/playlist?link=`): yt-dlp's
  `--flat-playlist` of `youtube.com/playlist?list=<validated id>` (first 500), `parsePlaylistJson()`
  into the Spotify playlist's shape with `source: "youtube"`; refuses mixes and personal lists
- `server/audio.ts` — yt-dlp and ffmpeg arguments (unit-tested), `fetchAudioInfo()` (metadata pass,
  with YouTube Music's album and date), `prepareAudioOutput()` (the output, with the cover: written
  to a `ytdownload-cover-` temp folder for .opus/.mka, `cleanup()` after) and `startAudioPipeline()`
  (yt-dlp → ffmpeg, used by both download and save, for a YouTube video or a SoundCloud track alike;
  an MP3's tag goes out with the first chunk, `withPrefix()`, and on a cancel the stream handed out
  is drained so ffmpeg can't block), yt-dlp error lines
- `server/tags.ts` — the MP3's ID3v2.3 tag, written by the app (`id3v2Tag()`: title, artist, album,
  year, track, `TXXX:spotify_id`, front cover) since ffmpeg can't stream one with a cover; the Ogg
  cover block (`flacPictureBlock()`), `jpegSize()`. Pure, unit-tested
- `server/cover.ts` — download covers: Spotify's album cover (validated `i.scdn.co` /
  `image-cdn-xx.spotifycdn.com` URL), else the video's thumbnail (`i.ytimg.com`, built from the video
  id, looked for alongside the look-up) or a SoundCloud track's artwork (`sndcdn.com`, 500×500, from
  the look-up; `isSoundCloudArtworkUrl()`), made a ≤600 px square JPEG by ffmpeg (`squareJpeg()`);
  `coverFor()` waits ≤10 s, never fails
- `server/lyrics.ts` — lyrics for the player from LRCLIB's search (`lrclib.net`, free, no key; only
  title, artist and length sent): `searchesFor()`, `pickLyrics()` (same length ±3 s, synced first),
  `parseLrc()`; answers cached in memory. Pure parts unit-tested
- `server/youtube-url.ts` — pure URL-parsing and thumbnail helpers (unit-tested)
- `server/storage.ts` — `FileStorage`: newest 1,000 entries (`MAX_HISTORY`), queued writes,
  temp-file + rename; `server/retry-when-busy.ts` retries the renames and deletes Windows briefly
  blocks (antivirus, the indexer)
- `shared/` — schema and API contracts shared by client and server; `shared/soundcloud-link.ts` has
  `parseSoundCloudLink()` (a SoundCloud track's one canonical link,
  `https://api.soundcloud.com/tracks/<digits>`, from that or the URL-encoded URN form yt-dlp lists —
  exact text matching, nothing else) and `audioLinkOf()` (what a download or save may fetch: a
  YouTube video's canonical watch link or a SoundCloud track's — the only links that reach yt-dlp);
  `shared/filename.ts` has
  `safeFileName()`, used by the server to name downloads and by the page to show that name;
  `shared/spotify-names.ts` has `cleanTrackTitle()` and `spotifyFileName()` ("Artists - Title", the
  default name of any download found from Spotify); `shared/audio-types.ts` has `AUDIO_TYPES` (the
  audio files the app knows: MIME type, and what to ask `canPlayType()`)
- `client/src/pages/Home.tsx` — the page: its state and what each action does (open a link, search,
  open a playlist, Paste, download or save), laid out from components — `find-box.tsx` (the Link /
  Search / Playlist switch, the box, Paste, the copied-link suggestion), `preview-card.tsx` (the
  chosen video, Download Audio, Original audio), `search-results.tsx` (with the inline video
  preview; a SoundCloud mark on SoundCloud's results, and **Search SoundCloud** over YouTube's) and
  `recent-extractions.tsx` (the history, its search and filters; removing a song and Clear history,
  with Undo in the note — `hooks/use-history-actions.tsx`).
  `client/src/components/ui/` holds only the shadcn/ui components in use — add more with
  `npx shadcn@latest add <name>` (config in `components.json`)
- `client/src/hooks/use-youtube.ts` — the page's API calls as TanStack Query hooks (history,
  search — `searchSongs()`, `soundCloudOnly` for SoundCloud alone — Spotify links, playlists —
  `usePlaylist()` — and video info)
- `client/src/lib/clipboard.ts` + `hooks/use-clipboard-link.ts` — Paste and the copied-link
  suggestion (`findCopiedLink()`, `textToPaste()`, `canReadClipboard()`; unit-tested)
- `client/src/hooks/use-stored-choice.ts` — a choice remembered in localStorage; used for the MP3 /
  Original audio toggle (`use-download-format.ts`) and the Link / Search / Playlist switch;
  `use-stored-value.ts` remembers free text (the open playlist's link); `use-recent-playlists.ts`
  the playlists opened lately (`lib/recent-playlists.ts`, pure, unit-tested), listed under the box in
  Playlist mode by `components/recent-playlists.tsx`
- `client/src/lib/format.ts` — `formatDuration()`, `isSpotifyLink()`, `isSpotifyPlaylistLink()` and
  `asLink()` (a YouTube link is opened, a playlist/album link opens the panel, anything else is
  searched)
- `client/src/components/spotify-playlist.tsx` — the playlist panel (Spotify playlists and albums,
  and YouTube playlists — `source`; `usePlaylist()` picks the endpoint from the link): lists the songs
  (filter); picking a Spotify song searches its song link, picking a video opens it. Under a
  playlist it couldn't list to the end, a note says why and when the app asks again
  (`playlistMoreNote()` in `lib/playlist-more.ts`), and `usePlaylist()` asks again by itself at
  `more.retryAt` (`hooks/use-ask-again-at.ts`; a tab asleep then asks once it's shown), the rest
  joining the list in place. With a Save to
  folder: In folder marks and counts (`hooks/use-songs-in-folder.ts`, refetched on focus and after
  saves; when more songs arrive, the last answer stands meanwhile and Download waits for the new one), a Not in folder view, tick boxes and Download (`hooks/use-download-all.ts`:
  `downloadSongs()` works on as many songs at once as the app's computer has CPU cores
  (`cpuCores` from `/api/settings`) — search, `confidentMatch()` (same length as on Spotify) or mark
  "check", then `saveOnServer()`, and after a save YouTube refused, the same on SoundCloud alone; a
  YouTube playlist's videos are saved as they are; Stop, or a problem with the folder, aborts every
  song in flight), and Play / Shuffle
  (the songs in the folder, in the playlist's order: `playlistQueue()` in `lib/music.ts`) and Save
  playlist file. Without a
  folder: Downloaded marks from history entries' `spotifyId` (or video id). Downloads carry
  `spotifyId` (history + file tag)
- `client/src/lib/save-to-folder.ts` + `hooks/use-save-settings.ts` — the page's side of "Save to":
  settings/folder API calls and `saveOnServer()` (reads the progress lines with `getReader()`).
  `components/folder-picker.tsx` is the folder browser (native `<dialog>`, portalled to `<body>`);
  `components/save-to-setting.tsx` sits under the search box, always visible — other devices get
  a note there instead
- `client/src/components/video-preview.tsx` — a search result's video in YouTube's embedded player
  (`youtubeEmbedUrl()` in `shared/youtube-link.ts`, youtube-nocookie), opened by its thumbnail under
  that result, one at a time; it pauses the app's player
- `client/src/components/renameable-title.tsx` — the preview card's title; click it to rename the
  file (sent as `?name=` on the download link); Enter keeps, Esc cancels
- `client/src/lib/history-filter.ts` + `components/history-search.tsx` — searching Recent
  Extractions in the browser: word/partial matching, autocomplete suggestions (combobox; picking one
  filters to that exact title), date ranges, highlighting; the list pages 25 at a time
- The music player: `hooks/use-player.tsx` (`PlayerProvider` in `App.tsx`: one `<audio>` for the
  page, queue/shuffle/repeat, the FLAC fallback for folder songs, Media Session) and
  `components/player-bar.tsx` (fixed to the bottom; rendered by `layout.tsx`), with `components/up-next.tsx`
  (the queue, opened from the bar; Play next / Add to queue are `queueWith()` in `lib/music.ts`),
  `components/lyrics-panel.tsx` (Lyrics, opened from the bar in Up next's place: synced lines follow
  the song, a click seeks; `hooks/use-lyrics.ts`, `lib/lyrics.ts`),
  `hooks/use-player-shortcuts.tsx` (keyboard shortcuts; the pure part is `lib/player-keys.ts`) and
  `lib/remembered-player.ts` (the folder-song queue and position kept in localStorage, so the next
  visit carries on, paused; pure, unit-tested). `components/music-library.tsx`
  is "Your music": the folder's songs (`hooks/use-folder-music.ts`) or songs picked on the device
  (`hooks/use-device-music.ts`, `lib/device-music.ts`: tags read in the page, one per core of that
  device, played from blob URLs);
  `lib/music.ts` has the pure parts (songs, sort/filter, play order; unit-tested)
- `scripts/build.ts` — the production build (`npm run build`). `scripts/windows/` — double-click
  helpers for running the app (`start.cmd`, `stop.cmd`, `update.cmd`, `update-yt-dlp.cmd`,
  `autostart-on/off.cmd`), all thin wrappers around `app.ps1`; `scripts/unix/` is the same for
  macOS and Linux (`app.sh`, POSIX sh, with `start/stop/update/update-yt-dlp.sh` wrappers and
  `.command` files for Finder; `tests/unit/unix-scripts.test.ts` checks them). Keep `app.ps1` Windows PowerShell
  5.1-compatible and plain ASCII, with CRLF line endings (`.gitattributes`;
  `tests/unit/windows-scripts.test.ts` checks). `stop` only kills the app's own process tree: from
  the server's `node.exe` up through its launchers (npm, `cross-env`, `start.cmd`/`Start.cmd`), never
  the terminal, editor or Explorer above them. The scripts serve two kinds of copy, told apart by
  `server\index.ts`: the source (installs everything, runs `npm run dev`) and a ready-to-run build
  (`npm ci --omit=dev`, `npm start`)
- `.github/workflows/install.yml` — after every push to `main`, builds the app on GitHub and
  force-pushes the ready-to-run result to the `install` branch as a single commit: `dist/`,
  `package*.json`, the Windows and Unix scripts and `scripts/install/` (README with the build filled in,
  `.gitignore`, `Start/Stop/Update.cmd` shortcuts — one line each, as `Update.cmd` replaces them
  while they run). PCs `git clone --depth 1 --branch install`; `update.cmd` fetches and resets
  (no history to merge). Never commit to `install` by hand
- `.github/workflows/tests.yml` — `npm ci`, yt-dlp/ffmpeg run, then `npm run verify` (formatting,
  lint, type-check, dependency licences, unit tests + the music and history API tests) on Linux and Windows after every push (macOS on Mondays / by hand: its minutes count
  10×), and on pull requests. The YouTube API and browser tests aren't run there (GitHub's machines
  get refused)
- `.github/workflows/claude-code-review.yml` — Claude reviews each pull request once (opened or
  marked ready; not drafts, forks or Dependabot's) with inline comments, on a different model.
  `claude-refactor.yml` — monthly, runs the `/refactor` skill and opens a pull request.
  `claude-backlog.yml` — when the owner comments on a `decision` or `debt` issue, records the
  answer in `docs/decisions.md`, does the work it calls for and opens a pull request (`backlog`
  skill). All three need the `CLAUDE_CODE_OAUTH_TOKEN` secret and skip, green, without it. `.github/dependabot.yml` —
  monthly grouped npm and Actions updates (TypeScript majors by hand);
  `.github/pull_request_template.md` — the PR checklist
- `.claude/skills/` — `verify` (runs `npm run verify`, before each commit), `refactor` (measure,
  then at most three behaviour-preserving cleanups) and `backlog` (files, triages and works the
  `debt`/`decision` issues; records decisions in `docs/decisions.md`)
- `scripts/yt-dlp.mjs` — the `postinstall`: on macOS/Linux, swaps youtube-dl-exec's Python yt-dlp
  (needs Python 3.10+) for yt-dlp's standalone build (`yt-dlp_macos`, `yt-dlp_linux[_aarch64]`,
  musl builds); a no-op on Windows (`yt-dlp.exe` is standalone). `--update` (`npm run
update-yt-dlp`) runs `yt-dlp -U`. Plain JS, no packages — the install branch ships it too
- `client/public/` — `manifest.webmanifest` and the icons (tab, phones' home screens), drawn by
  `scripts/make-icons.ts` with Chrome (`npx tsx scripts/make-icons.ts`; `tests/unit/web-app.test.ts`)
- `tests/unit` (no network: yt-dlp, SoundCloud and Spotify played by stand-ins — `audio-routes.test.ts`
  runs the real routes and pipeline with a Node process writing ffmpeg-made audio, and
  `spotify-routes.test.ts` the playlist route with a stand-in Spotify), `tests/api`
  (Vitest + Supertest, real YouTube, SoundCloud — `soundcloud.e2e.test.ts` — and Spotify), `tests/browser`
  (Playwright, in Chrome and WebKit; Firefox on request). The player's tests (`music*.test.ts`,
  `player.spec.ts`) make their own songs with ffmpeg — no YouTube needed. Tests name their temp
  files `yt-audio-<what>-` + `fs.mkdtemp()`'s suffix and delete them afterwards; each run's
  `globalSetup` (`scripts/leftovers.ts`) deletes what stopped runs left (a Playwright run's server
  files once its process is gone, other test folders a day old), and `scripts/clean.ts` everything
  at once (`clean-script.test.ts` checks every name)
- `docs/decisions.md` — decisions made, one line each (date, decision, why, issue). Pending decisions
  and debt are GitHub issues labelled `decision` and `debt`; the `backlog` skill files and closes
  them, and the monthly refactor takes `debt` issues first
- `docs/core-flows.md` — the core flows (what a person relies on the app for), each naming a unit,
  an integration and a UI test (`file` › exact title), `—` for a gap, and `Gaps allowed: N`.
  `scripts/core-flows.ts` (`npm run core-flows`, in verify) checks it, with the pure rules in
  `scripts/core-flows-rules.ts` (`tests/unit/core-flows.test.ts`): each named test exists, unit and
  integration tests are ones verify runs, UI tests are `tests/browser` specs, and the gaps equal
  the allowed count. Integration means real routes/pipeline with stand-ins (`audio-routes.test.ts`,
  `spotify-routes.test.ts`, the music and history API tests); a browser test counts only if it runs on stand-ins (`page.route`,
  ffmpeg-made songs) — several in `download.spec.ts` need live YouTube or Spotify and don't

## Commands

- `npm run verify` — the one check before a change is done: `prettier --check`, `eslint`, `tsc`,
  `npm run licenses` (every dependency must carry a free, open-source licence; `ffmpeg-static`, GPL like
  ffmpeg itself, is the one agreed exception, so a new copyleft or non-open package fails the check rather
  than widening the list), `npm run core-flows`, then the unit tests and the music and history API tests (no network). CI runs the same script on every push and pull
  request
- `npm run core-flows` — checks `docs/core-flows.md` against the tests (one line when all is well)
- `npm run dev` — dev server at http://localhost:5000 (nothing else needs to be running);
  `scripts\windows\start.cmd` (`scripts/unix/start.sh` on macOS and Linux) does the same with install checks and opens the browser
- `npm run check` — type-check
- `npx vitest run tests/unit` — fast unit tests
- `npx vitest run tests/api` — end-to-end API tests (needs internet)
- `npx playwright test` — browser tests in installed Google Chrome and WebKit (starts its own server on
  port 5099); `--project=chrome|webkit` for one; `E2E_BROWSERS=chrome,webkit,firefox` adds Firefox.
  First time: `npx playwright install chrome webkit firefox`
- `npx eslint .` and `npx prettier --check .`
- `npm run coverage` — the unit tests with V8 coverage of `client/src`, `server` and `shared` (not
  `components/ui`): a text summary and an HTML report in `reports/coverage/` (git-ignored)
- `npm run build`, then `npm start` — production bundle
- `npm run update-yt-dlp` — the newest yt-dlp, on any system (Windows: `update-yt-dlp.cmd` too)
- `npm run clean` — removes what test runs leave behind: their temp files, Playwright's
  `test-results/`, `playwright-report/` and leftover browser profiles (`-- --dry-run` lists them).
  Never `data/`, `dist/`, the player's cache or a Save to folder; run it when no tests are running

## Local setup (Windows, macOS, Linux)

- No setup beyond `npm install` (Node 24 LTS; no Python on any system). `.env` is optional (`PORT`,
  `HOST`, `ALLOWED_HOSTS`, `HISTORY_FILE`, `SETTINGS_FILE`, `SOURCE_HEALTH_FILE`, `FFMPEG_BIN`,
  `PLAYER_CACHE_DIR`); shell variables override it. Delete `data/history.json` to clear the history.
- The API tests point `HISTORY_FILE`/`SETTINGS_FILE`/`SOURCE_HEALTH_FILE` at a temp folder, and the
  Playwright config starts its own server on port 5099 with a temp history, settings and health
  file, so tests never touch the real ones. A unit test that makes the app record a source-health
  event (a stubbed Spotify fetch, a route through `youtubeGuard`, a SoundCloud search or look-up)
  sets `SOURCE_HEALTH_FILE` too, or hands the code a stand-in health store.
- `npm install` needs `YOUTUBE_DL_SKIP_PYTHON_CHECK=1` in the environment on a system without Python
  3.9+: youtube-dl-exec's installer demands it though the app doesn't use Python (`yt-dlp.exe` on
  Windows; `scripts/yt-dlp.mjs` installs the standalone build on macOS/Linux afterwards). Don't use
  `npm rebuild youtube-dl-exec` on macOS/Linux — it brings back the Python yt-dlp until
  `node scripts/yt-dlp.mjs` runs again; `npm run update-yt-dlp` updates it in place.
- In PowerShell, `npm` may be blocked by the script execution policy — use `npm.cmd` (or `cmd.exe`).
- If `npm install` skips dev dependencies, `NODE_ENV=production` is set in that shell — unset it.
- This PC: Node 24.19, npm 12.2 (blocks install scripts not in `allowScripts`), Git 2.55. npm 10
  rewrote `package-lock.json` without the `libc` fields — never use it on this repo. winget's
  msstore source fails with a certificate error here: use `--source winget`. Git's installer stops
  while anything from Git's folder runs (Git Bash, even a `sleep`).

## Conventions and gotchas

- Keep everything cross-platform: set env vars in npm scripts with `cross-env`, never a bare
  `VAR=value` prefix; no `reusePort` in `listen()` (fails with ENOTSUP on Windows).
- Downloads stream yt-dlp stdout → ffmpeg stdin → response: `bestaudio` (best free stream — on
  YouTube usually Opus ~130 kbps, on SoundCloud MP3 or Opus; no Premium/cookies) → 320k CBR MP3,
  LAME `-q 2`. CBR is deliberate: a streamed VBR file has no seek header, so players show the wrong
  duration. The MP3's ID3v2.3 tag (with the cover) is the app's own (`id3v2Tag()`; ffmpeg runs with
  `-id3v2_version 0` and writes none — its mp3 muxer has no `-write_id3v2`): ffmpeg writes a tag
  with a picture by seeking back to fix its size, which a stream can't — the tag said size 0. A
  streamed .m4a can't hold a cover (its header goes out before any picture), so it has none.
- A download (or save) owns two child processes, started by `startAudioPipeline()` in `audio.ts`,
  which swallows EPIPE on `ffmpeg.stdin` and kills yt-dlp once ffmpeg is done. The routes watch `res`
  "close" from the very start and call `stop()` on cancel. Unhandled stream errors or a missed kill
  mean a crashed server or processes left running forever, so re-test cancel paths after edits.
- `?format=original` (the "Original audio" toggle) skips re-encoding: ffmpeg `-c:a copy` into `.opus`
  (Ogg) for Opus, fragmented `.m4a` for AAC, `.mp3` for MP3 (SoundCloud's), `.mka` otherwise. The metadata pass uses the same
  `bestaudio` selector and the stream is pinned to its `format_id`, so container and codec match.
  The format enum and `buildDownloadUrl()` live in `shared/routes.ts`.
- Covers: a download never waits more than `COVER_WAIT_MS` for its cover, nor fails without one.
  Only fixed hosts are fetched (see `server/cover.ts`); the Spotify cover URL is checked against them.
- History changes (`DELETE /api/downloads[/:id]`, `POST /api/downloads/restore`) are allowed from any
  device using the app, from its own page only (`sameOriginOnly()` in `local-only.ts`): the history
  is shared like the downloads. Removing never touches files. Restore re-ids an entry whose id was
  reused meanwhile (ids are max+1, so they restart after Clear).
- The history search has no API: the page filters what `/api/downloads` returns. Keep that endpoint
  cheap (it's polled while a download runs) — the request log truncates JSON bodies to 200 chars.
- A download is added to the history only after it fully succeeds (both processes exit 0 and the
  response `finish`es) — never on cancel or failure. The page polls `/api/downloads` until it appears.
- Headers go out with the first chunk of audio, so failures before any audio become a `502`; don't
  write to `res` before the pipeline produces output.
- Download names: always `safeFileName()` + `res.attachment()` (ASCII `filename` plus UTF-8
  `filename*`), so accents and non-Latin titles survive. Linux Chromium with no UTF-8 locale
  (`LANG` unset) can't use non-ASCII file names — run such browsers with `LANG=C.UTF-8`.
- Search spawns yt-dlp directly (no shell) with the query after `--` (`ytsearch12:`/`scsearch12:`);
  keep it that way so search text can't become a command or a yt-dlp option. Results carry their own
  title/thumbnail, so picking one needs no `/api/video/info` call. Only canonical links reach yt-dlp
  for a download or save: `audioLinkOf()` rebuilds a YouTube video's from its id and a SoundCloud
  track's from its number, and turns anything else down with a `400` (look-alike hosts,
  credentials, http:, sets, users' pages, odd encodings — `soundcloud.test.ts` lists them).
- A download with `spotifyId` is tagged with it — ID3 `TXXX:spotify_id` (MP3), `SPOTIFY_ID` (.opus/.mka),
  or the song's link as the comment of an .m4a (the ipod muxer drops custom keys; `use_metadata_tags`
  breaks the standard ones) — and with Spotify's title/artists (`spotifySongTags()`, ≤5 s, else
  YouTube's). That tag is how the playlist panel recognises the app's own files after a rename.
- `music-metadata` is ESM-only and describes `parseFile` only under the "node" exports condition, which
  TypeScript's `bundler` resolution ignores: `library.ts` loads it with `import()` and types it by hand.
  Regexes with the `u` flag (`\p{L}`) must be built with `new RegExp(...)`: tsc refuses the literal at
  this project's default ES5 target.
- Never slow the app down (the owner's rule, Oct 11, 2026): no cooldowns, queues or concurrency caps
  of our own — parallel work runs one per CPU core (`cpuCores()`, `mapAtOnce()`), never capped by a
  number we picked — and pacing only to a service's published limit (YouTube and SoundCloud publish
  none). When a source refuses or fails, switch to the next source for that data at once; wait only
  when there's no other source, and then on its own, honouring `Retry-After`. Cache answers that
  don't change; results say which source they came from (`source`), errors say what to do. Test
  against stand-ins, never the live services. What stays is what holds nothing back: the timeouts
  that end a hung process or request, `retryWhenBusy()` for Windows' brief file locks, and one
  writer per JSON file (history, settings, health report).
- "Download all" works on as many songs at once as the app's computer has CPU cores (the page gets
  `cpuCores` from `/api/settings`; it may be on a phone), and never downloads a match that isn't the
  same length as the Spotify song (a song whose length Spotify's fallback didn't give is "check"):
  unattended picks must be near-certain. A save YouTube refuses switches that song to SoundCloud
  alone, once, at once. Stop or a folder problem aborts every song in flight (their pipelines are
  killed and `.part` files deleted). `youtube-limits.ts` has the 10-minute cache, the refusal memory
  that makes searches hedge, the background yt-dlp self-update (at most once an hour: `yt-dlp -U`
  asks GitHub's API, which allows 60 unauthenticated requests an hour), and
  `data/source-health.json` says how the sources have been answering. A new yt-dlp call to YouTube
  goes through `youtubeGuard.run()`; a new route that can hit YouTube answers `YouTubeRefused` with
  `sendRefused()`, at once. `docs/sources.md` is the register to update when a source or fallback
  changes.
- Spotify: only a validated kind (track/playlist/album) and 22-character id go into the embed URL we
  fetch, and only a validated code into a short link's (no user-controlled URLs are ever fetched).
  If Spotify links break, check the embed page's `__NEXT_DATA__` shape first (`parseEmbedPage()`,
  `parsePlaylistPage()`); the cloud workspace can't reach Spotify. No sign-in on purpose: since Feb
  2026 Spotify's Web API Development Mode needs the app owner to have Premium, and the app must stay
  free — so only public playlists. Past a playlist's first 100 songs the app pages
  `api.spotify.com/v1/playlists/<validated id>/tracks` with the embed page's anonymous pass (the
  owner's choice: an app's own key can't read other people's playlists since Feb 2026); keep that
  pass server-side, and any failure falls back to the first 100. With no other source for those
  songs, the app waits on its own (the owner's decisions of Oct 12, 2026): a 429 is remembered until
  its Retry-After and the open panel asks again then by itself; a failure without one, a minute later.
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
- The dev server sends files by their path (`/@fs/<path>`) to any device that can reach it, so
  `vite.config.ts`'s `server.fs` allows only `client/`, `shared/` and `node_modules/` (Vite's
  pre-bundled packages are in `node_modules/.vite`) and denies dotfiles — never `data/`. Its deny
  list replaces Vite's defaults, so it repeats them. `server/vite.ts` spreads `viteConfig.server`
  into its own options: never replace it. A new folder the page loads files from goes in `allow`
  (`tests/unit/dev-server.test.ts` checks).

## Definition of done

- `npm run verify` passes. Show its last lines in your summary.
- A change to a route, a pipeline (yt-dlp, ffmpeg), a file the app writes or a Windows script comes
  with a unit test that runs without the network — the player's tests show how to make songs with
  ffmpeg instead of downloading them. If the change can only be checked against YouTube or Spotify,
  run `tests/api` or the browser tests too and say which ones you ran.
- Core flows (`docs/core-flows.md`): every flow names a test at each level — unit (one module, no
  network), integration (several parts through the real routes or pipeline, outside services
  played by stand-ins) and UI (a real browser driving the running app, on stand-ins). A change to
  a core flow updates its tests at all three levels in the same change; a new feature adds its
  flow and all three tests before it's done. Closing a gap lowers `Gaps allowed`; it never goes up.
  Tests against live services stay separate (`tests/api`'s YouTube/SoundCloud/Spotify tests).
- Docs match the code: a new file, route, command or environment variable goes in this file's Layout,
  Commands or Local setup, and anything a user sees goes in `README.md` / `docs/run/README.md`.
- Never skip or delete a test, loosen a check, or add an `eslint-disable` / `@ts-expect-error` to get
  green without asking the user first.

## Workflow

- Commit to `main` after each completed milestone (a feature, fix or cleanup that is done and
  tested) without asking first, then push to `origin/main`. Keep each commit to one milestone with a
  descriptive message; don't commit half-finished work. Each push rebuilds the `install` branch that
  PCs update from (the workflow doesn't run the tests), so only push what passes `npm run verify`.
