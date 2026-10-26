---
paths:
  - "server/{music,lyrics,trash,trim,catalogues,song-details,details-log,not-found,housekeeping}.ts"
  - "server/routes/{music,trim,song-details,housekeeping}.ts"
  - "shared/{audio-types,name-noise}.ts"
  - "client/src/App.tsx"
  - "client/src/hooks/{use-player,use-player-shortcuts}.tsx"
  - "client/src/hooks/{use-folder-music,use-device-music,use-lyrics}.ts"
  - "client/src/components/{player-bar,up-next,lyrics-panel,music-library,layout,video-preview,delete-song-dialog,trim-song,fill-in-details,sanitize-names,rename-song-dialog,housekeeping}.tsx"
  - "client/src/lib/{music,device-music,lyrics,player-keys,remembered-player,trim,song-details,housekeeping,at-once}.ts"
  - "client/src/hooks/use-batch-run.ts"
  - "tests/unit/{music,music-player,player-keys,remembered-player,lyrics,trash,trim,trim-routes,song-details,song-details-routes,details-log,housekeeping,housekeeping-routes}.test.ts"
  - "tests/api/music.e2e.test.ts"
  - "tests/browser/{player,playlist,trim,song-details,sanitize-names,housekeeping}.spec.ts"
---

# The music player

- Songs play untouched (the browser decodes the file, like VLC). Start a song inside the click that
  asked for it — `player.play()` calls `audio.play()` synchronously; phones refuse `play()` outside
  a tap, so don't move it into an effect — and keep the one `<audio>` element, which may then move
  on by itself.
- The Save to folder's songs are local-only (`/api/music…` behind `localOnly()`) and asked for by
  id, never by path. Songs picked on another device never reach the server.
- A folder song the browser can't play (`canPlayType()` says "", or it fails to load) is converted
  to FLAC; re-test skipping during a conversion after edits (ffmpeg must stop, no `.part` left).
- Playwright's WebKit on Windows plays media through Media Foundation: opening a song blocks the
  page for several seconds (give such clicks a long timeout), it can't play blob: URLs, and it plays
  WMA but not Ogg/Opus or AIFF — `player.spec.ts` asks the browser instead of assuming.
- Delete from folder moves the file to the system's bin (`server/trash.ts`), never deleting for good
  unless the person said so after a `409 noBin`; tests use `TRASH_DIR`, never the real bin. Take the
  song out of the queue (`discard()`) before the request, so the file isn't open while it moves.
- Trimming changes the user's file: the original is copied to the backup folder before ffmpeg runs,
  the result is swapped in only once complete, and Undo refuses a song changed since. The player must
  `letGo()` of a song before it's trimmed or put back (Windows won't replace an open file).
- Fill in details writes into the person's own files: only tags a song lacks, never over one it has,
  the audio copied with `-c copy`, and only after `rewriteProblem()` finds the copy has every tag
  the file had. Writing goes over the file in place (it keeps its creation date) with its times put
  back, so it stays put in "Recently added". The song playing is never changed.
- Renames never add "(1)"/"(2)" (owner, Oct 26, 2026): a taken name is refused, for the person to
  delete one copy. Housekeeping only lists; nothing goes until the person ticks and confirms, to
  the bin, and a `.part` a save is writing is never listed. Its quality bar defaults to 128 kbps.
