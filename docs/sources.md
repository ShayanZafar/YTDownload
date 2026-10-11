# The app's outside sources

Everything the app knows comes from two places it doesn't control: YouTube (through yt-dlp) and Spotify. This page is the register of those sources: what each is used for, what stands in when it fails, how the app copes when YouTube limits the computer, where their health is recorded, and what was considered instead. The code is in `server/youtube-limits.ts`, `server/yt-dlp-update.ts`, `server/source-health.ts` and `server/spotify.ts`.

## What comes from where

| Need                                                 | Primary source                                                               | Fallbacks, in order                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Audio** (search, video info, the download)         | YouTube, through yt-dlp (`youtube`)                                          | None that brings audio from elsewhere. When yt-dlp looks outdated the app updates it itself and tries once more (below); when YouTube is limiting the computer the app waits (below). A song YouTube refuses is marked **Check** in a playlist, to pick by hand.                                 |
| **Song details** from a Spotify song link            | Spotify's public embed page, `open.spotify.com/embed/track/<id>` (`spotify`) | Spotify's keyless oEmbed endpoint, `open.spotify.com/oembed?url=…` (`spotify-oembed`): it knows the song's title and cover, not its artists or length. Such a song is searched for by title alone, and **Download all** marks it **Check** rather than guess which upload is the same recording. |
| **Playlists**: a Spotify playlist's or album's songs | The embed page of the playlist or album, which lists its first 100 songs     | Past 100 songs, Spotify's Web API with the embed page's anonymous pass; if that fails, the first 100 stay (`maybeMore`). No oEmbed fallback: it knows nothing about a playlist's songs.                                                                                                          |
| **Playlists**: a YouTube playlist's videos           | YouTube, through yt-dlp's flat listing (`youtube`)                           | None.                                                                                                                                                                                                                                                                                            |

The embed page and the oEmbed endpoint are both Spotify's own, public and keyless, so the app never needs a Spotify account (and can't have one: see "Considered and rejected").

## When YouTube limits the computer

YouTube limits computers that ask too much — "HTTP Error 429: Too Many Requests", or "Sign in to confirm you're not a bot" — and yt-dlp stops understanding YouTube's pages every few weeks until it's updated. Every yt-dlp call that isn't an audio stream (a search, a video's details, a playlist listing, the look-up before a download) goes through one guard (`server/youtube-limits.ts`), which:

- **Answers repeats from a cache.** The same search, video or playlist asked for again within 10 minutes is answered without asking YouTube (200 entries at most; the least recently used go first).
- **Runs at most two yt-dlp calls at once.** Others wait their turn, in order. Bursts are what YouTube's checks look for; **Download all** was already one song at a time for the same reason.
- **Backs off for 10 minutes once YouTube has limited it.** The app answers `429` with how long to wait (`{ message, retryAfterSeconds, source: "youtube" }`, plus a `Retry-After` header) and runs no yt-dlp meanwhile — cached answers are still served. A download that YouTube refuses before any audio has been sent gets the same `429` instead of a `502`; one refused mid-stream is cut short as before. The page shows the message; **Download all** shows the song waiting, waits that long (Stop ends the wait; 15 minutes at most), tries the song once more, and if YouTube still won't have it, stops there — the songs it didn't get to are left as they were.
- **Updates yt-dlp itself.** The first time in an hour that a yt-dlp call fails in a way an outdated yt-dlp fails ("Requested format is not available", "Unable to extract…", a signature or `nsig` problem, or a bot check, which an old yt-dlp earns more easily), the app runs the repo's own updater (`node scripts/yt-dlp.mjs --update`, what `npm run update-yt-dlp` runs) with a two-minute limit, logs one line when it starts and one when it's done, and then tries the failed call once more — if whoever asked is still waiting. If the update can't run (no network, say), the app carries on with the yt-dlp it has.

## What "unreliable" means

Every attempt against a source is recorded: when, whether it worked, and for a failure whether the source said to slow down (`throttled`: HTTP 429), refused the computer (`blocked`: YouTube's bot check, or an HTTP 403 from Spotify) or anything else (`error`), with its last error line. A video that's private or removed is YouTube answering properly, so it counts as a success.

A source is **unreliable** when it has been asked at least 5 times in the last 24 hours and under half of those attempts worked. The report's top-level `unreliable` is true when some job can't be done: its primary source is unreliable and so is every fallback for it — or it has no fallback (audio has none, so an unreliable YouTube makes it true). The `summary` names the unreliable sources with their counts and last error, or says "All sources healthy."

## Where health is recorded

- `data/source-health.json` (or wherever `SOURCE_HEALTH_FILE` points; it sits next to the history and settings and is git-ignored), rewritten at most every few seconds through a temp file and rename, like the history.
- `GET /api/health/sources` — the same report, for any device (nothing in it is about this computer: no paths, no secrets).

```json
{
  "updatedAt": "2026-10-11T12:00:00.000Z",
  "unreliable": false,
  "summary": "All sources healthy.",
  "sources": {
    "youtube": {
      "role": "primary",
      "for": "audio",
      "ok": 18,
      "failed": 2,
      "throttled": 2,
      "lastOk": "2026-10-11T11:58:02.000Z",
      "lastError": "HTTP Error 429: Too Many Requests"
    },
    "spotify": {
      "role": "primary",
      "for": "song details",
      "ok": 4,
      "failed": 0,
      "throttled": 0,
      "lastOk": "2026-10-11T11:40:00.000Z",
      "lastError": null
    },
    "spotify-oembed": {
      "role": "fallback",
      "for": "song details",
      "ok": 0,
      "failed": 0,
      "throttled": 0,
      "lastOk": null,
      "lastError": null
    }
  }
}
```

The events behind it live in memory only (the newest 500 of the last 24 hours), so a restart starts the count afresh.

## Considered and rejected

- **Invidious or Piped public instances** as a second source of audio: they fetch from YouTube themselves, so they're throttled and blocked the same way — more often, since many people share each instance — and they come and go. Not reliable enough to be a fallback for anything.
- **YouTube cookies or a sign-in** to get past the bot check: not by design. Giving the app a YouTube login puts that account at risk, and the app must stay usable without any account.
- **The YouTube Data API** for search and video details: needs a key, a Google project and a quota, and gives no audio anyway. The app stays keyless.
- **Spotify's Web API with the app's own key** for song details: since February 2026 a development-mode app can only read its owner's own data, and its owner would need Premium. The embed page and oEmbed endpoint are public and need nothing.
- **A second music catalogue** (MusicBrainz, say) for song details: another dependency for a job Spotify's two public endpoints already cover between them.

A SoundCloud fallback for audio was left open: the places to add one are where the app decides YouTube refused a song — `searchYouTube()` throwing `YouTubeLimited` in `server/search.ts`, and `downloadSong()` in `client/src/hooks/use-download-all.ts`, where a song ends up **Check** or waits out a 429 — with results carrying a `source` field the way a Spotify song carries `source: "spotify-oembed"`.
