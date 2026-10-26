---
paths:
  - "server/**"
  - "shared/**"
  - "client/src/hooks/use-download-all.ts"
  - "scripts/yt-dlp.mjs"
  - "docs/sources.md"
  - "tests/unit/{youtube-limits,source-health,search,soundcloud,cpu-cores,audio-routes}.test.ts"
  - "tests/unit/{spotify,spotify-routes,youtube-playlist,yt-dlp-script,lyrics,name-noise,song-details,download-all,download-details}.test.ts"
  - "tests/api/**"
---

# Outside sources: YouTube, SoundCloud, Spotify (through yt-dlp and fetch)

- Never slow the app down (the owner's rule, Oct 11, 2026): no cooldowns, queues or concurrency caps
  of our own — parallel work runs one per CPU core (`cpuCores()`, `mapAtOnce()`), never capped by a
  number we picked — and pacing only to a service's published limit (YouTube and SoundCloud publish
  none). When a source refuses or fails, switch to the next source for that data at once; wait only
  when there's no other source, and then on its own, honouring `Retry-After`. Cache answers that
  don't change; results say which source they came from (`source`), errors say what to do. Test
  against stand-ins, never the live services. What stays is what holds nothing back: the timeouts
  that end a hung process or request, `retryWhenBusy()` for Windows' brief file locks, and one
  writer per JSON file (history, settings, health report).
- A new yt-dlp call to YouTube goes through `youtubeGuard.run()`; a new route that can hit YouTube
  answers `YouTubeRefused` with `sendRefused()`, at once. `youtube-limits.ts` has the 10-minute
  cache, the refusal memory that makes searches hedge, and the background yt-dlp self-update (at
  most once an hour: `yt-dlp -U` asks GitHub's API, which allows 60 unauthenticated requests an
  hour); `data/source-health.json` says how the sources have been answering.
- YouTube sign-in is opt-in only (owner, 2026-10-26): `attempt(signIn)` gets a browser only after
  a bot check with `youtubeSignIn: "firefox"` set, or within 10 minutes of a signed-in call that
  worked (`signInNow()`). Pass `signIn` on to yt-dlp (`signInFlags()`/`signInArgs()`, before any
  `--`) and to the audio stream (`AudioInfo.signIn`); never sign in otherwise.
- `docs/sources.md` is the register to update when a source or fallback changes.
- Search spawns yt-dlp directly (no shell) with the query after `--` (`ytsearch12:`/`scsearch12:`);
  keep it that way so search text can't become a command or a yt-dlp option. Results carry their own
  title/thumbnail, so picking one needs no `/api/video/info` call.
- Only canonical links reach yt-dlp for a download or save: `audioLinkOf()` rebuilds a YouTube
  video's from its id and a SoundCloud track's from its number, and turns anything else down with a
  `400` (look-alike hosts, credentials, http:, sets, users' pages, odd encodings —
  `soundcloud.test.ts` lists them).
- yt-dlp needs a JavaScript runtime for YouTube; we pass `--js-runtimes node` via
  `YT_DLP_BASE_FLAGS`.
- If extraction suddenly breaks, update yt-dlp before debugging code: `npm run update-yt-dlp`.
- A unit test that makes the app record a source-health event (a stubbed Spotify fetch, a route
  through `youtubeGuard`, a SoundCloud search or look-up) points `SOURCE_HEALTH_FILE` at a temp
  file too, or hands the code a stand-in health store, so tests never touch the real report.
