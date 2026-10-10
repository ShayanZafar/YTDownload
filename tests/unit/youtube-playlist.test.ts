import { describe, expect, it } from "vitest";
import {
  YOUTUBE_PLAYLIST_LIMIT,
  YouTubePlaylistError,
  parsePlaylistJson,
  playlistFailure,
  youtubePlaylistIdOf,
  ytDlpPlaylistArgs,
} from "../../server/youtube-playlist";

const LIST = "PLbpi6ZahtOH6Blw3RGYpWkSByi_T7Rygb";

// yt-dlp's --flat-playlist --dump-single-json for a playlist, cut down.
const flatPlaylist = (entries: unknown[], extra: Record<string, unknown> = {}) => ({
  _type: "playlist",
  id: LIST,
  title: "Road Trip",
  channel: "Moomoo",
  uploader: "Moomoo",
  playlist_count: entries.length,
  thumbnails: [
    { url: "https://i.ytimg.com/pl/small.jpg", width: 168 },
    { url: "https://i.ytimg.com/pl/medium.jpg", width: 336 },
    { url: "https://i.ytimg.com/pl/large.jpg", width: 480 },
  ],
  entries,
  ...extra,
});

const entry = (id: string, title: string, more: Record<string, unknown> = {}) => ({
  _type: "url",
  ie_key: "Youtube",
  id,
  url: `https://www.youtube.com/watch?v=${id}`,
  title,
  duration: 212.0,
  channel: "Queen Official",
  ...more,
});

describe("youtubePlaylistIdOf", () => {
  it("takes the playlist from its link, typed with or without https://", () => {
    expect(youtubePlaylistIdOf(`https://www.youtube.com/playlist?list=${LIST}`)).toBe(LIST);
    expect(youtubePlaylistIdOf(` youtube.com/playlist?list=${LIST}&si=x `)).toBe(LIST);
    expect(youtubePlaylistIdOf(`https://music.youtube.com/playlist?list=OLAK5uy_abc123`)).toBe(
      "OLAK5uy_abc123",
    );
  });

  it("explains links that aren't a playlist it can open", () => {
    for (const link of [
      "https://www.youtube.com/watch?v=jNQXAC9IVRw",
      "https://example.com/playlist?list=PL123",
      "daft punk",
    ]) {
      expect(() => youtubePlaylistIdOf(link), link).toThrow(/youtube playlist link/i);
    }
    expect(() => youtubePlaylistIdOf("https://www.youtube.com/playlist?list=WL")).toThrow(
      /only you can see/,
    );
    expect(() =>
      youtubePlaylistIdOf("https://www.youtube.com/playlist?list=RDjNQXAC9IVRw"),
    ).toThrow(/mix/);
  });
});

describe("ytDlpPlaylistArgs", () => {
  it("lists the playlist without opening each video, the address after --", () => {
    const args = ytDlpPlaylistArgs(LIST);
    expect(args).toContain("--flat-playlist");
    expect(args.slice(-2)).toEqual(["--", `https://www.youtube.com/playlist?list=${LIST}`]);
    expect(args[args.indexOf("--playlist-end") + 1]).toBe(String(YOUTUBE_PLAYLIST_LIMIT));
  });
});

describe("parsePlaylistJson", () => {
  it("lists the videos with their channel, length and thumbnail", () => {
    const playlist = parsePlaylistJson(
      flatPlaylist([
        entry("fJ9rUzIMcZQ", "Queen – Bohemian Rhapsody (Official Video Remastered)"),
        entry("HgzGwKwLmgM", "Queen - Don't Stop Me Now (Official Video)", {
          duration: null,
          channel: undefined,
          uploader: "Queen",
        }),
      ]),
      LIST,
    );
    expect(playlist).toEqual({
      source: "youtube",
      kind: "playlist",
      id: LIST,
      url: `https://www.youtube.com/playlist?list=${LIST}`,
      name: "Road Trip",
      by: "Moomoo",
      image: "https://i.ytimg.com/pl/medium.jpg",
      maybeMore: false,
      tracks: [
        {
          id: "fJ9rUzIMcZQ",
          url: "https://www.youtube.com/watch?v=fJ9rUzIMcZQ",
          title: "Queen – Bohemian Rhapsody (Official Video Remastered)",
          artists: "Queen Official",
          duration: 212,
          explicit: false,
          thumbnail: "https://i.ytimg.com/vi/fJ9rUzIMcZQ/hqdefault.jpg",
        },
        {
          id: "HgzGwKwLmgM",
          url: "https://www.youtube.com/watch?v=HgzGwKwLmgM",
          title: "Queen - Don't Stop Me Now (Official Video)",
          artists: "Queen",
          duration: null,
          explicit: false,
          thumbnail: "https://i.ytimg.com/vi/HgzGwKwLmgM/hqdefault.jpg",
        },
      ],
    });
  });

  it("leaves out private and deleted videos, and anything without an id", () => {
    const playlist = parsePlaylistJson(
      flatPlaylist([
        entry("aaaaaaaaaaa", "[Private video]", { duration: null, channel: null }),
        entry("bbbbbbbbbbb", "[Deleted video]"),
        entry("not-an-id", "Broken"),
        { title: "No id" },
        null,
        entry("ccccccccccc", "Still here"),
      ]),
      LIST,
    );
    expect(playlist.tracks.map((t) => t.id)).toEqual(["ccccccccccc"]);
  });

  it("says when there may be more videos than it lists", () => {
    const many = Array.from({ length: YOUTUBE_PLAYLIST_LIMIT }, (_, i) =>
      entry(`v${String(i).padStart(10, "0")}`, `Song ${i}`),
    );
    expect(parsePlaylistJson(flatPlaylist(many), LIST).maybeMore).toBe(true);
    expect(
      parsePlaylistJson(flatPlaylist([entry("ccccccccccc", "One")], { playlist_count: 600 }), LIST)
        .maybeMore,
    ).toBe(true);
  });

  it("calls a YouTube Music album an album, and copes with a bare answer", () => {
    expect(parsePlaylistJson(flatPlaylist([]), "OLAK5uy_abc123").kind).toBe("album");
    expect(parsePlaylistJson({}, LIST)).toMatchObject({
      name: "YouTube playlist",
      by: null,
      image: null,
      tracks: [],
    });
    // No picture of its own: its first video's.
    expect(
      parsePlaylistJson(flatPlaylist([entry("ccccccccccc", "One")], { thumbnails: [] }), LIST)
        .image,
    ).toBe("https://i.ytimg.com/vi/ccccccccccc/mqdefault.jpg");
  });
});

describe("playlistFailure", () => {
  it("says a private or missing playlist isn't shared", () => {
    for (const message of [
      "ERROR: [youtube:tab] PL123: The playlist does not exist.",
      "ERROR: [youtube:tab] PL123: This playlist is private",
    ]) {
      const err = playlistFailure(message);
      expect(err).toBeInstanceOf(YouTubePlaylistError);
      expect(err.status).toBe(404);
    }
  });

  it("passes other problems on, without yt-dlp's prefixes", () => {
    const err = playlistFailure("ERROR: [youtube:tab] Sign in to confirm you're not a bot");
    expect(err.status).toBe(502);
    expect(err.message).toBe(
      "Couldn't read the playlist from YouTube: Sign in to confirm you're not a bot",
    );
  });
});
