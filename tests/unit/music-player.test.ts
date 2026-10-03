import { describe, expect, it } from "vitest";
import {
  AUDIO_FILE_ACCEPT,
  deviceTrack,
  filterTracks,
  folderSongCoverUrl,
  folderSongFlacUrl,
  folderSongUrl,
  folderTrack,
  isAudioFile,
  nextPosition,
  previousPosition,
  shuffledOrder,
  sortTracks,
  type PlayerTrack,
} from "../../client/src/lib/music";

const folderSong = (title: string, extra: Partial<Parameters<typeof folderTrack>[0]> = {}) =>
  folderTrack({
    id: `id-${title}`.padEnd(22, "x").slice(0, 22),
    path: `${title}.mp3`,
    title,
    artist: null,
    album: null,
    duration: null,
    addedAt: "2026-10-01T10:00:00.000Z",
    size: 1000,
    ...extra,
  });

describe("folder songs", () => {
  it("become player songs that play from the app", () => {
    const track = folderSong("Bohemian Rhapsody", {
      id: "AAAAAAAAAAAAAAAAAAAAAA",
      path: "Queen\\Bohemian Rhapsody.opus",
      artist: "Queen",
      duration: 354,
    });
    expect(track).toMatchObject({
      key: "folder:AAAAAAAAAAAAAAAAAAAAAA",
      source: "folder",
      title: "Bohemian Rhapsody",
      artist: "Queen",
      fileName: "Queen\\Bohemian Rhapsody.opus",
      addedAt: Date.UTC(2026, 9, 1, 10),
      check: 'audio/ogg; codecs="opus"',
    });
    expect(folderSongUrl("AAAAAAAAAAAAAAAAAAAAAA")).toBe("/api/music/AAAAAAAAAAAAAAAAAAAAAA");
    expect(folderSongFlacUrl("AAAAAAAAAAAAAAAAAAAAAA")).toBe(
      "/api/music/AAAAAAAAAAAAAAAAAAAAAA/flac",
    );
    expect(folderSongCoverUrl("AAAAAAAAAAAAAAAAAAAAAA")).toBe(
      "/api/music/AAAAAAAAAAAAAAAAAAAAAA/cover",
    );
  });
});

describe("songs picked on this device", () => {
  it("are named after their file until their tags are read", () => {
    const file = new File(["x"], "01 Get Lucky.m4a", { lastModified: 1234 });
    expect(deviceTrack(file)).toMatchObject({
      source: "device",
      title: "01 Get Lucky",
      artist: null,
      tagsRead: false,
      fileName: "01 Get Lucky.m4a",
      addedAt: 1234,
      check: 'audio/mp4; codecs="mp4a.40.2"',
    });
    // The same file picked twice is the same song.
    expect(deviceTrack(file).key).toBe(deviceTrack(file).key);
  });

  it("are audio files, by their kind or their name", () => {
    expect(isAudioFile(new File([], "song.opus"))).toBe(true);
    expect(isAudioFile(new File([], "voice memo", { type: "audio/x-caf" }))).toBe(true);
    expect(isAudioFile(new File([], "cover.jpg", { type: "image/jpeg" }))).toBe(false);
    expect(deviceTrack(new File([], "voice memo", { type: "audio/x-caf" })).check).toBe(
      "audio/x-caf",
    );
    expect(AUDIO_FILE_ACCEPT.split(",")).toEqual(
      expect.arrayContaining(["audio/*", ".mp3", ".opus", ".flac", ".wma"]),
    );
  });
});

describe("sortTracks and filterTracks", () => {
  const tracks: PlayerTrack[] = [
    folderSong("Billie Jean", {
      artist: "Michael Jackson",
      album: "Thriller",
      addedAt: "2026-09-01T00:00:00Z",
    }),
    folderSong("Africa", { artist: "TOTO", album: "Toto IV", addedAt: "2026-10-01T00:00:00Z" }),
    folderSong("Beat It", {
      artist: "Michael Jackson",
      album: "Thriller",
      addedAt: "2026-08-01T00:00:00Z",
    }),
    folderSong("untitled memo", { addedAt: "2026-07-01T00:00:00Z" }),
  ];
  const titles = (list: PlayerTrack[]) => list.map((t) => t.title);

  it("orders newest first, by title, or by artist then album then title", () => {
    expect(titles(sortTracks(tracks, "added"))).toEqual([
      "Africa",
      "Billie Jean",
      "Beat It",
      "untitled memo",
    ]);
    expect(titles(sortTracks(tracks, "title"))).toEqual([
      "Africa",
      "Beat It",
      "Billie Jean",
      "untitled memo",
    ]);
    // Songs with no artist go last.
    expect(titles(sortTracks(tracks, "artist"))).toEqual([
      "Beat It",
      "Billie Jean",
      "Africa",
      "untitled memo",
    ]);
    expect(titles(tracks)).toEqual(["Billie Jean", "Africa", "Beat It", "untitled memo"]);
  });

  it("finds songs by every word typed, in the title, artist, album or file name", () => {
    expect(titles(filterTracks(tracks, "jackson thril"))).toEqual(["Billie Jean", "Beat It"]);
    expect(titles(filterTracks(tracks, "toto"))).toEqual(["Africa"]);
    expect(titles(filterTracks(tracks, "MEMO.mp3"))).toEqual(["untitled memo"]);
    expect(titles(filterTracks(tracks, "  "))).toHaveLength(4);
    expect(filterTracks(tracks, "nothing like this")).toEqual([]);
  });
});

describe("what plays next", () => {
  it("shuffles every song once, starting with the one asked for", () => {
    let seed = 1;
    const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const order = shuffledOrder(10, 7, random);
    expect(order[0]).toBe(7);
    expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(order).not.toEqual([7, 0, 1, 2, 3, 4, 5, 6, 8, 9]);
    expect(shuffledOrder(0, 0)).toEqual([]);
  });

  it("moves on, repeats, or stops at the end", () => {
    expect(nextPosition(0, 3, "off")).toBe(1);
    expect(nextPosition(2, 3, "off")).toBeNull();
    expect(nextPosition(2, 3, "all")).toBe(0);
    // Repeat one plays the song again when it ends, but Next still moves on.
    expect(nextPosition(1, 3, "one")).toBe(1);
    expect(nextPosition(1, 3, "one", { skip: true })).toBe(2);
    expect(nextPosition(2, 3, "one", { skip: true })).toBe(0);
    expect(nextPosition(0, 0, "all")).toBeNull();
  });

  it("goes back a song, or round to the last one when repeating", () => {
    expect(previousPosition(2, 3, "off")).toBe(1);
    expect(previousPosition(0, 3, "off")).toBe(0);
    expect(previousPosition(0, 3, "all")).toBe(2);
  });
});
