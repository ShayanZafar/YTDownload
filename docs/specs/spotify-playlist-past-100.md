# Spec: a Spotify playlist's songs past 100, when Spotify refuses

Status: **approved and built** (2026-10-12). The owner answered yes to both questions below; they're recorded in `docs/decisions.md`.

## The problem

Opening a playlist of more than 100 songs takes the first 100 from the embed page, then asks
Spotify's Web API for the rest (`fetchMorePlaylistSongs()` in `server/spotify.ts`). Today Spotify
answers that with **429 `QUOTA_EXCEEDED`, `Retry-After: 54901`** (about 15 hours), for a fresh
anonymous pass too, so the refusal holds for the whole Web API route from this computer, not for one
pass. The app then:

1. shows the 100 songs with a note blaming the wrong cause: "Spotify shared only the first 100
   songs of this playlist (it does that for its own playlists…)". The owner's own playlist
   ("Trance Legends", by Shayan) got that note.
2. never tries again by itself: the rest appear only if the playlist is opened again after the
   refusal ends, and nothing says when that is.
3. asks Spotify again on every open while the refusal holds, a request certain to fail.
4. hides the refusals in source health: they're counted under `spotify` with the embed page's
   successes, so the report says "All sources healthy".

The owner's rule (never slow the app down, `.claude/rules/outside-sources.md`): when there's no other source, wait on your own,
honouring `Retry-After`, so nobody has to restart anything. Songs past 100 have no other source.

## What changes

### Server

- `fetchMorePlaylistSongs()` reports **why** it stopped, not just `complete: false`:
  - `refused`: a 429. `retryAt` = now + `Retry-After` (seconds or an HTTP date); a 429 without one
    counts as `failed`.
  - `failed`: 5xx, 401/403, a timeout or no connection. `retryAt` = now + 60 s.
  - `spotify-own`: a 404 (Spotify's own playlists, as today).
  - `limit`: cut at `SPOTIFY_PLAYLIST_MAX_SONGS` (1,000).
  - A page that fails after earlier pages succeeded keeps those songs, as today, and reports
    the reason for the page that failed.
- A refusal is **remembered** in memory until `retryAt` (one for the whole Web API route, since
  the quota isn't per pass). While it holds, a playlist opens with its 100 songs and the same
  `refused` reason and `retryAt`, **without asking Spotify**. After `retryAt` the next open asks
  again. Nothing waits or holds a request: the answer is immediate either way.
- The answer gains an optional field next to `maybeMore` (which stays, and YouTube keeps using):
  `more: { reason: "refused" | "failed" | "spotify-own" | "limit", retryAt?: string }`, where
  `retryAt` is an ISO time. `maybeMore: true` without `more` is the embed page listing 100 and
  carrying no pass, so the app can't tell why.
- **Source health:** the Web API calls are recorded as their own source, `spotify-web-api`
  ("Spotify Web API", role `primary`, for "playlist songs past 100", no fallback), not under
  `spotify`. The report gains `refusedUntil` per source.

### Page (the playlist panel)

- The note under the list says the real reason:
  - `refused`: "Spotify isn't sharing more of this playlist right now (too many requests from
    this computer). The app asks again by itself at about 5:10 AM, and the rest appear here then."
    (local time, with "tomorrow" when it's past midnight; the song count instead of "more" when
    some pages came through)
  - `failed`: "Couldn't get the rest of this playlist from Spotify (HTTP 503). The app tries again
    in a minute."
  - `spotify-own` and `limit`: today's notes.
  - `maybeMore` without `more`: "Spotify shared only the first 100 songs of this playlist." (no
    guessed cause)
- **The rest fills in by itself:** while the panel shows a playlist whose answer has a `retryAt`,
  the page asks again at that time. A tab asleep then (a laptop closed overnight) asks as soon as
  it's visible again. When more songs arrive, the list grows in place:
  - the filter text, the view (All / Not in folder), scroll position, ticks and a running Download
    stay as they were;
  - the In folder check runs for the new songs;
  - new missing songs are ticked by the default rule (ticked, unless one is marked "check"), but
    after **Tick all** or **Untick all** they follow that choice;
  - a running Download doesn't take on the new songs; it saves what was ticked when it started.
- Closing the panel or opening another playlist cancels the timer.

### Docs

`docs/sources.md` (the new source and the 429 behaviour), the `server/spotify.ts` and
`server/source-health.ts` entries in TECHNICAL.md's File-by-file reference, README's playlist section (the list can fill in later).

## Acceptance criteria

1. A 429 with `Retry-After` on the page after the first 100 gives the 100 songs,
   `more.reason: "refused"` and a `retryAt` that `Retry-After` sets (seconds and HTTP-date forms).
2. While a refusal holds, opening any playlist of more than 100 songs makes no Web API request and
   answers at once with the 100 songs, `refused` and the same `retryAt`.
3. After `retryAt`, the next open asks Spotify again; a success lists every song (`maybeMore: false`).
4. A 5xx, timeout or 429 without `Retry-After` gives `failed` with `retryAt` 60 s on; a 404 gives
   `spotify-own`; 1,000 songs gives `limit`.
5. Songs from pages that succeeded before a refused or failed page are kept.
6. Source health records the Web API calls under `spotify-web-api` (throttled for a 429), with
   `refusedUntil`; the embed page's calls stay under `spotify`.
7. The panel's note names the reason and, for `refused`/`failed`, when the app tries again; it
   never blames Spotify's own playlists unless Spotify answered 404.
8. With the panel open, at `retryAt` the page asks again by itself and the new songs appear, with
   the filter, view, ticks and an ongoing Download unchanged.
9. After Untick all, songs that arrive later are unticked.
10. `npm run verify` passes, and the core flow "Open a Spotify or YouTube playlist" gets an
    integration test, closing its gap (Gaps allowed 6 → 5).

## Test cases

**Unit** (`tests/unit/spotify.test.ts`, stubbed `fetch`, fake clock; `SOURCE_HEALTH_FILE` set)

- 429 + `Retry-After: 54901` after the embed page → 100 songs, `refused`, `retryAt` = now + 54901 s.
- `Retry-After` as an HTTP date → `retryAt` is that date.
- A second playlist opened within the window → no request to `api.spotify.com`, same answer.
- Clock moved past `retryAt` → asks again; 250 songs, `maybeMore: false`, no `more`.
- First Web API page OK, a later page 429 → the songs before it, `refused`.
- 503 / timeout / 429 without `Retry-After` → `failed`, `retryAt` = now + 60 s.
- 404 → `spotify-own`; 1,000+ songs → `limit`.
- `tests/unit/source-health.test.ts`: `spotify-web-api` is a primary with no fallback;
  `refusedUntil` is in the report.

**Integration** (new `tests/unit/spotify-routes.test.ts`: the real Express routes, Spotify played
by a stand-in `fetch`)

- `GET /api/spotify/playlist?link=…` with the stand-in answering 429 → 200, 100 songs,
  `more.reason: "refused"`, `retryAt`; a second request makes no Web API call.
- The stand-in answering every page → all songs, `maybeMore: false`.

**UI** (`tests/browser/playlist.spec.ts`, `page.route` stand-ins)

- First answer: 100 songs, `refused`, `retryAt` 2 s on → the note says the app asks again at that
  time. Type a filter, tick-change a song; the second answer (150 songs) arrives by itself → 150
  songs listed, filter and tick kept, note gone.
- After **Untick all**, the songs that arrive are unticked.
- `failed` → the note says it tries again in a minute.

## Out of scope

- A source for songs past 100 other than Spotify's Web API. The owner's rule is to search only when
  a need's primary and every fallback are unreliable, and to bring candidates rather than build
  one. Once this lands, source health will show whether `spotify-web-api` is unreliable.
- Keeping the refusal across a server restart: after one, the first open asks Spotify once and
  remembers the answer again.
- The Spotify panel drawing every row again on each change (with 1,000 songs, during a Download's
  progress). That's separate debt (#23), the same fix as Your music's rows.

## Questions for the owner

1. **Retry after a failure without `Retry-After`:** proposed 60 s, by itself, while the panel is
   open. Alternative: only when the playlist is opened again.
2. **Counting a long refusal as unreliable:** today `unreliable` needs 5 attempts in 24 h. With
   refusals remembered, a 15-hour refusal means about 2 attempts a day, so it never shows as
   unreliable. Proposed: a primary with no fallback that is refused for more than an hour counts as
   unreliable, so the session-start hook prompts the search for another source.

No new packages.
