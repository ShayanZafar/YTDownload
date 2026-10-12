---
paths:
  - "server/audio*.ts"
  - "server/routes.ts"
  - "server/save.ts"
  - "server/tags.ts"
  - "server/cover.ts"
  - "shared/{routes,filename,spotify-names}.ts"
  - "client/src/components/{preview-card,renameable-title}.tsx"
  - "client/src/hooks/use-download-format.ts"
  - "tests/unit/{audio,audio-routes,cover-art,filename}.test.ts"
  - "tests/api/{video,soundcloud}.e2e.test.ts"
  - "tests/utils/*.ts"
  - "tests/browser/download.spec.ts"
---

# Downloads: the audio pipeline (yt-dlp → ffmpeg)

- Downloads stream yt-dlp stdout → ffmpeg stdin → response: `bestaudio` (best free stream — on
  YouTube usually Opus ~130 kbps, on SoundCloud MP3 or Opus; no Premium/cookies) → 320k CBR MP3,
  LAME `-q 2`. CBR is deliberate: a streamed VBR file has no seek header, so players show the wrong
  duration.
- The MP3's ID3v2.3 tag (with the cover) is the app's own (`id3v2Tag()`; ffmpeg runs with
  `-id3v2_version 0` and writes none — its mp3 muxer has no `-write_id3v2`): ffmpeg writes a tag
  with a picture by seeking back to fix its size, which a stream can't — the tag said size 0. A
  streamed .m4a can't hold a cover (its header goes out before any picture), so it has none.
- A download (or save) owns two child processes, started by `startAudioPipeline()` in `audio.ts`,
  which swallows EPIPE on `ffmpeg.stdin` and kills yt-dlp once ffmpeg is done. The routes watch
  `res` "close" from the very start and call `stop()` on cancel. Unhandled stream errors or a missed
  kill mean a crashed server or processes left running forever, so re-test cancel paths after edits.
- Headers go out with the first chunk of audio, so failures before any audio become a `502`; don't
  write to `res` before the pipeline produces output.
- A download is added to the history only after it fully succeeds (both processes exit 0 and the
  response `finish`es) — never on cancel or failure. The page polls `/api/downloads` until it
  appears.
- `?format=original` (the "Original audio" toggle) skips re-encoding: ffmpeg `-c:a copy` into
  `.opus` (Ogg) for Opus, fragmented `.m4a` for AAC, `.mp3` for MP3 (SoundCloud's), `.mka`
  otherwise. The metadata pass uses the same `bestaudio` selector and the stream is pinned to its
  `format_id`, so container and codec match. The format enum and `buildDownloadUrl()` live in
  `shared/routes.ts`.
- Covers: a download never waits more than `COVER_WAIT_MS` for its cover, nor fails without one.
  Only fixed hosts are fetched (see `server/cover.ts`); the Spotify cover URL is checked against
  them.
- Download names: always `safeFileName()` + `res.attachment()` (ASCII `filename` plus UTF-8
  `filename*`), so accents and non-Latin titles survive. Linux Chromium with no UTF-8 locale
  (`LANG` unset) can't use non-ASCII file names — run such browsers with `LANG=C.UTF-8`.
- A download with `spotifyId` is tagged with it — ID3 `TXXX:spotify_id` (MP3), `SPOTIFY_ID`
  (.opus/.mka), or the song's link as the comment of an .m4a (the ipod muxer drops custom keys;
  `use_metadata_tags` breaks the standard ones) — and with Spotify's title/artists
  (`spotifySongTags()`, ≤5 s, else YouTube's). That tag is how the playlist panel recognises the
  app's own files after a rename.
