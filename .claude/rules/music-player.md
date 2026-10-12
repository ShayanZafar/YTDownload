---
paths:
  - "server/{music,lyrics}.ts"
  - "shared/audio-types.ts"
  - "client/src/App.tsx"
  - "client/src/hooks/{use-player,use-player-shortcuts}.tsx"
  - "client/src/hooks/{use-folder-music,use-device-music,use-lyrics}.ts"
  - "client/src/components/{player-bar,up-next,lyrics-panel,music-library,layout,video-preview}.tsx"
  - "client/src/lib/{music,device-music,lyrics,player-keys,remembered-player}.ts"
  - "tests/unit/{music,music-player,player-keys,remembered-player,lyrics}.test.ts"
  - "tests/api/music.e2e.test.ts"
  - "tests/browser/{player,playlist}.spec.ts"
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
