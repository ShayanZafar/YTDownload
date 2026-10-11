import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LyricsError,
  cleanArtist,
  cleanSongTitle,
  findLyrics,
  parseLrc,
  pickLyrics,
  searchesFor,
} from "../../server/lyrics";
import { LYRICS_LEAD_SECONDS, currentLine } from "../../client/src/lib/lyrics";
import { lyricsQuery } from "../../client/src/hooks/use-lyrics";

describe("parseLrc", () => {
  it("reads each line's time, in order, repeating a line that has several", () => {
    const lrc = [
      "[ar: Made-up Band]",
      "[00:18.73] Paper boats along the gutter",
      "[00:22.80]Counting streetlights on the way home",
      "[01:05.1][02:10.25]Hum it back to me",
      "[00:43.00]",
      "not a lyric line",
    ].join("\r\n");
    expect(parseLrc(lrc)).toEqual([
      { time: 18.73, text: "Paper boats along the gutter" },
      { time: 22.8, text: "Counting streetlights on the way home" },
      { time: 43, text: "" },
      { time: 65.1, text: "Hum it back to me" },
      { time: 130.25, text: "Hum it back to me" },
    ]);
  });

  it("finds nothing in plain text", () => {
    expect(parseLrc("Just words\nand more words")).toEqual([]);
  });
});

describe("what's asked for", () => {
  it("cleans a YouTube video's title and channel", () => {
    expect(cleanSongTitle("Rick Astley - Never Gonna Give You Up (Official Music Video)")).toBe(
      "Rick Astley - Never Gonna Give You Up",
    );
    expect(cleanSongTitle("Song [Official Audio] (feat. Someone) (Lyrics)")).toBe("Song");
    expect(cleanSongTitle("Bohemian Rhapsody - Remastered 2011")).toBe("Bohemian Rhapsody");
    expect(cleanSongTitle("Live Forever (Live)")).toBe("Live Forever (Live)");
    expect(cleanArtist("RickAstleyVEVO")).toBe("RickAstley");
    expect(cleanArtist("Daft Punk - Topic")).toBe("Daft Punk");
    expect(cleanArtist("Daft Punk, Pharrell Williams")).toBe("Daft Punk");
    expect(cleanArtist("Calvin Harris feat. Rihanna")).toBe("Calvin Harris");
  });

  it("tries a title's two halves as artist and song, then the title with the artist", () => {
    expect(
      searchesFor({
        title: "Rick Astley - Never Gonna Give You Up (Official Video)",
        artist: "RickAstleyVEVO",
      }),
    ).toEqual([
      { artist: "Rick Astley", track: "Never Gonna Give You Up" },
      { track: "Rick Astley - Never Gonna Give You Up", artist: "RickAstley" },
    ]);
    expect(searchesFor({ title: "Queen – Bohemian Rhapsody (Official Video Remastered)" })).toEqual(
      [{ artist: "Queen", track: "Bohemian Rhapsody" }],
    );
    expect(searchesFor({ title: "Get Lucky", artist: "Daft Punk, Pharrell Williams" })).toEqual([
      { track: "Get Lucky", artist: "Daft Punk" },
    ]);
    expect(searchesFor({ title: "Untitled track" })).toEqual([
      { track: "Untitled track", artist: "" },
    ]);
  });
});

describe("pickLyrics", () => {
  const record = (over: Record<string, unknown>) => ({
    trackName: "Song",
    artistName: "Someone",
    duration: 200,
    instrumental: false,
    plainLyrics: "Words",
    syncedLyrics: null,
    ...over,
  });

  it("prefers synced lyrics of a recording the same length", () => {
    const lyrics = pickLyrics(
      [
        record({ duration: 260, syncedLyrics: "[00:01.00]Other version" }),
        record({ plainLyrics: "Plain only" }),
        record({ duration: 201, plainLyrics: "Line", syncedLyrics: "[00:01.00]Line" }),
      ],
      200,
    );
    expect(lyrics).toEqual({
      synced: [{ time: 1, text: "Line" }],
      plain: "Line",
      instrumental: false,
      track: "Song",
      artist: "Someone",
    });
  });

  it("takes plain lyrics when there are no synced ones, and any length when ours is unknown", () => {
    expect(pickLyrics([record({ duration: 999 })])?.plain).toBe("Words");
    expect(pickLyrics([record({ duration: 999 })], 200)).toBeNull();
  });

  it("says when a song has no words, and finds nothing in an empty or odd answer", () => {
    expect(pickLyrics([record({ plainLyrics: null, instrumental: true })], 200)?.instrumental).toBe(
      true,
    );
    expect(pickLyrics([])).toBeNull();
    expect(pickLyrics({ code: 404 })).toBeNull();
    expect(pickLyrics([record({ plainLyrics: "  ", syncedLyrics: "" })])).toBeNull();
  });
});

describe("findLyrics", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks LRCLIB's search by title and artist, and remembers the answer", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            {
              trackName: "Unique Song",
              artistName: "Band",
              duration: 180,
              plainLyrics: "La la",
              syncedLyrics: "[00:02.00]La la",
            },
          ]),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const song = { title: "Unique Song (Official Video)", artist: "Band", duration: 181 };
    expect((await findLyrics(song))?.synced).toEqual([{ time: 2, text: "La la" }]);
    expect(await findLyrics(song)).not.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    const url = new URL(String((fetch.mock.calls[0] as unknown[])[0]));
    expect(url.origin + url.pathname).toBe("https://lrclib.net/api/search");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      track_name: "Unique Song",
      artist_name: "Band",
    });
  });

  it("answers null when no search finds them, and fails clearly when LRCLIB can't be reached", async () => {
    vi.stubGlobal("fetch", async () => new Response("[]", { status: 200 }));
    expect(await findLyrics({ title: "A - B", artist: "C" })).toBeNull();
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    await expect(findLyrics({ title: "Another song" })).rejects.toBeInstanceOf(LyricsError);
    vi.stubGlobal("fetch", async () => new Response("busy", { status: 503 }));
    await expect(findLyrics({ title: "Third song" })).rejects.toThrow("HTTP 503");
  });
});

describe("the player's lyrics", () => {
  const lines = [
    { time: 5, text: "one" },
    { time: 10, text: "two" },
    { time: 10, text: "two again" },
    { time: 20, text: "three" },
  ];

  it("highlight the last line that has started, a moment early", () => {
    expect(currentLine(lines, 0)).toBe(-1);
    expect(currentLine(lines, 5 - LYRICS_LEAD_SECONDS)).toBe(0);
    expect(currentLine(lines, 9.5)).toBe(0);
    expect(currentLine(lines, 10)).toBe(2);
    expect(currentLine(lines, 600)).toBe(3);
    expect(currentLine([], 3)).toBe(-1);
  });

  it("are asked for by the song's title, artist and whole seconds", () => {
    expect(lyricsQuery({ title: "Song", artist: "Band", duration: 201.6 })).toEqual({
      title: "Song",
      artist: "Band",
      duration: "202",
    });
    expect(lyricsQuery({ title: "Song", artist: null, duration: null })).toEqual({ title: "Song" });
  });
});
