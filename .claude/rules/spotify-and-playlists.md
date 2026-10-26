---
paths:
  - "server/{spotify,spotify-sign-in,youtube-playlist,library,playlist-file}.ts"
  - "server/routes/{spotify,search}.ts"
  - "shared/spotify-names.ts"
  - "client/src/components/{spotify-playlist,recent-playlists,spotify-account}.tsx"
  - "client/src/hooks/{use-download-all,use-songs-in-folder,use-ask-again-at,use-youtube,use-spotify-account}.ts"
  - "client/src/lib/{playlist-more,spotify-account}.ts"
  - "tests/unit/{spotify,spotify-routes,spotify-sign-in,download-all,playlist-more,youtube-playlist}.test.ts"
  - "tests/browser/{playlist,spotify-sign-in}.spec.ts"
  - "docs/specs/spotify-playlist-past-100.md"
---

# Spotify, playlists and Download all

- Spotify: only a validated kind (track/playlist/album) and 22-character id go into the embed URL
  we fetch, and only a validated code into a short link's (no user-controlled URLs are ever
  fetched). If Spotify links break, check the embed page's `__NEXT_DATA__` shape first
  (`parseEmbedPage()`, `parsePlaylistPage()`); the cloud workspace can't reach Spotify.
- Sign-in is optional (the owner's choice, Oct 26, 2026): with their own Spotify app's Client ID
  (PKCE, no secret; its owner needs Premium) the playlists you made or collaborate on list whole;
  everything else must keep working signed out. Never ask for more than the two playlist-read
  scopes, never send the passes to the page, keep every sign-in route behind `localOnly()` (the
  callback: `isLocalRequest()` plus its one-time `state`), and fall back to the embed page on any
  failure. The redirect URI is `http://127.0.0.1:<port>/…` (Spotify refuses `localhost`). Don't get
  around Spotify's limits through its private web-player API.
- Past a playlist's first 100 songs the app pages
  `api.spotify.com/v1/playlists/<validated id>/tracks` with the embed page's anonymous pass (the
  owner's choice: an app's own key can't read other people's playlists since Feb 2026); keep that
  pass server-side, and any failure falls back to the first 100. With no other source for those
  songs, the app waits on its own (the owner's decisions of Oct 12, 2026): a 429 is remembered
  until its Retry-After (`webApiRefusal`) and the open panel asks again then by itself; a failure
  without one, a minute later.
- "Download all" works on as many songs at once as the app's computer has CPU cores (the page gets
  `cpuCores` from `/api/settings`; it may be on a phone), and never downloads a match that isn't the
  same length as the Spotify song (a song whose length Spotify's fallback didn't give is "check"):
  unattended picks must be near-certain. A save YouTube refuses switches that song to SoundCloud
  alone, once, at once. Stop or a folder problem aborts every song in flight (their pipelines are
  killed and `.part` files deleted).
