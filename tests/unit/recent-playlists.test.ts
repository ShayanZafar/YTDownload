import { describe, expect, it } from "vitest";
import {
  MAX_RECENT_PLAYLISTS,
  forgetPlaylist,
  parseRecentPlaylists,
  recentPlaylistOf,
  rememberPlaylist,
  type RecentPlaylist,
} from "../../client/src/lib/recent-playlists";
import type { SpotifyPlaylist } from "../../shared/schema";

const ID = "37i9dQZF1DXcBWIGoYBM5M";

const playlist = (extra: Partial<SpotifyPlaylist> = {}): SpotifyPlaylist => ({
  source: "spotify",
  kind: "playlist",
  id: ID,
  url: `https://open.spotify.com/playlist/${ID}`,
  name: "Today's Top Hits",
  by: "Spotify",
  image: "https://i.scdn.co/image/cover",
  tracks: [
    {
      id: "4uLU6hMCjMI75M1A2tKUQC",
      url: "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC",
      title: "Song",
      artists: "Artist",
      duration: 200,
      explicit: false,
    },
  ],
  maybeMore: false,
  ...extra,
});

const entry = (name: string, extra: Partial<RecentPlaylist> = {}): RecentPlaylist => ({
  link: `https://open.spotify.com/playlist/${name.padEnd(22, "x")}`,
  source: "spotify",
  kind: "playlist",
  id: name.padEnd(22, "x"),
  name,
  by: null,
  image: null,
  songs: 10,
  ...extra,
});

describe("recent playlists", () => {
  it("remembers what the panel showed, with the link it was opened with", () => {
    const link = `https://open.spotify.com/playlist/${ID}?si=abc`;
    expect(recentPlaylistOf(link, playlist())).toEqual({
      link,
      source: "spotify",
      kind: "playlist",
      id: ID,
      name: "Today's Top Hits",
      by: "Spotify",
      image: "https://i.scdn.co/image/cover",
      songs: 1,
    });
  });

  it("puts the newest first, each playlist once, and keeps only so many", () => {
    const one = entry("one");
    const two = entry("two");
    expect(rememberPlaylist([one], two)).toEqual([two, one]);
    // The same playlist by another link (or renamed since) moves to the front.
    const again = { ...one, link: `${one.link}?si=x`, name: "One (renamed)" };
    expect(rememberPlaylist([two, one], again)).toEqual([again, two]);
    // An album and a playlist, or Spotify and YouTube, are different even with the same id.
    const album = { ...one, kind: "album" as const };
    expect(rememberPlaylist([one], album)).toEqual([album, one]);
    const many = Array.from({ length: 20 }, (_, i) => entry(`list${i}`));
    const kept = many.reduce((list, e) => rememberPlaylist(list, e), [] as RecentPlaylist[]);
    expect(kept).toHaveLength(MAX_RECENT_PLAYLISTS);
    expect(kept[0].name).toBe("list19");
  });

  it("forgets a playlist by its link", () => {
    const one = entry("one");
    const two = entry("two");
    expect(forgetPlaylist([one, two], one.link)).toEqual([two]);
    expect(forgetPlaylist([one, two], "https://example.com")).toEqual([one, two]);
  });

  it("reads back what was stored, leaving out anything that doesn't look right", () => {
    const one = entry("one");
    const youtube = entry("PLyt", {
      source: "youtube",
      link: "https://www.youtube.com/playlist?list=PLyt",
    });
    expect(parseRecentPlaylists(JSON.stringify([one, { name: "broken" }, youtube, 5]))).toEqual([
      one,
      youtube,
    ]);
    expect(parseRecentPlaylists(null)).toEqual([]);
    expect(parseRecentPlaylists("not json")).toEqual([]);
    expect(parseRecentPlaylists('{"link":"x"}')).toEqual([]);
    expect(parseRecentPlaylists(JSON.stringify([{ ...one, source: "deezer" }]))).toEqual([]);
  });
});
