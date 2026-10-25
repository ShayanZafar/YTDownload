import { describe, expect, it } from "vitest";
import {
  AUDIO_FILE_ACCEPT,
  EMPTY_QUEUE,
  currentOf,
  deviceTrack,
  filterTracks,
  folderSongCoverUrl,
  folderSongFlacUrl,
  folderSongUrl,
  folderTrack,
  isAudioFile,
  nextPosition,
  playlistQueue,
  previousPosition,
  queueUntilCurrent,
  queueWith,
  queueWithout,
  queueWithoutSong,
  seekRanOffTheEnd,
  shuffledOrder,
  sortTracks,
  upNext,
  type PlayerTrack,
  type Queue,
} from "../../client/src/lib/music";

const folderSong = (title: string, extra: Partial<Parameters<typeof folderTrack>[0]> = {}) =>
  folderTrack({
    id: `id-${title}`.padEnd(22, "x").slice(0, 22),
    path: `${title}.mp3`,
    title,
    artist: null,
    album: null,
    genres: [],
    year: null,
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

  it("doesn't take a seek past where a cut-short file stops for the song ending", () => {
    // A 7:50 song whose file stops at 0:44: asked for 3:55, the browser lands at the end.
    expect(seekRanOffTheEnd(235, 470, 470)).toBe(true);
    expect(seekRanOffTheEnd(235, 469.8, 470)).toBe(true);
    // A seek that got where it was asked (near enough), or one to the very end.
    expect(seekRanOffTheEnd(235, 235, 470)).toBe(false);
    expect(seekRanOffTheEnd(235, 233.9, 470)).toBe(false);
    expect(seekRanOffTheEnd(469.5, 470, 470)).toBe(false);
    expect(seekRanOffTheEnd(470, 470, 470)).toBe(false);
    // No length known yet.
    expect(seekRanOffTheEnd(10, 0, NaN)).toBe(false);
    expect(seekRanOffTheEnd(10, Infinity, Infinity)).toBe(false);
  });
});

describe("playlistQueue", () => {
  it("plays a playlist's songs that are in the folder, in the playlist's order, each once", () => {
    const one = folderSong("One");
    const two = folderSong("Two", { path: "Artist\\Two.opus" });
    const three = folderSong("Three");
    const songs = [{ id: "s2" }, { id: "missing" }, { id: "s1" }, { id: "s2" }, { id: "gone" }];
    const found = {
      s1: { file: "One.mp3" },
      s2: { file: "Artist\\Two.opus" },
      gone: { file: "Deleted since.mp3" },
    };
    expect(playlistQueue(songs, found, [one, two, three])).toEqual([two, one]);
    expect(playlistQueue(songs, {}, [one, two, three])).toEqual([]);
  });
});

describe("the queue", () => {
  const [a, b, c, d, e] = ["A", "B", "C", "D", "E"].map((title) => folderSong(title));
  /** The titles in play order, the current one in brackets. */
  const playOrder = (q: Queue) =>
    q.order
      .map((i, p) => (p === q.position ? `[${q.tracks[i].title}]` : q.tracks[i].title))
      .join(" ");
  const inOrder: Queue = { tracks: [a, b, c], order: [0, 1, 2], position: 1 };
  // Shuffled: B, C, A — B is playing.
  const shuffled: Queue = { tracks: [a, b, c], order: [1, 2, 0], position: 0 };

  it("lists the songs after the current one, with their places in the play order", () => {
    expect(currentOf(inOrder)).toBe(b);
    expect(upNext(inOrder)).toEqual([{ track: c, position: 2 }]);
    expect(upNext(shuffled).map(({ track, position }) => [track.title, position])).toEqual([
      ["C", 1],
      ["A", 2],
    ]);
    expect(upNext(EMPTY_QUEUE)).toEqual([]);
    expect(currentOf(EMPTY_QUEUE)).toBeUndefined();
  });

  it("puts songs right after the current one, in the order given", () => {
    const q = queueWith(inOrder, [d, e], "next");
    expect(playOrder(q)).toBe("A [B] D E C");
    // Shuffle off stays in this order: the songs are listed where they play.
    expect(q.order).toEqual([0, 1, 2, 3, 4]);
    expect(playOrder(queueWith(shuffled, [d], "next"))).toBe("[B] D C A");
  });

  it("adds songs at the end", () => {
    expect(playOrder(queueWith(inOrder, [d, e], "last"))).toBe("A [B] C D E");
    expect(playOrder(queueWith(shuffled, [d], "last"))).toBe("[B] C A D");
  });

  it("moves a song that's in the queue already instead of adding it twice", () => {
    expect(playOrder(queueWith(inOrder, [a], "next"))).toBe("[B] A C");
    expect(playOrder(queueWith(inOrder, [c], "next"))).toBe("A [B] C");
    expect(playOrder(queueWith(queueWith(inOrder, [d], "next"), [c], "next"))).toBe("A [B] C D");
    expect(playOrder(queueWith(shuffled, [c], "last"))).toBe("[B] A C");
    // The current song stays where it is.
    expect(queueWith(inOrder, [b], "next")).toEqual(inOrder);
    const q = queueWith(inOrder, [a, d, a], "last");
    expect(q.tracks).toHaveLength(4);
    expect(playOrder(q)).toBe("[B] C D A");
  });

  it("takes a song out, but never the current one", () => {
    expect(playOrder(queueWithout(inOrder, 2))).toBe("A [B]");
    const earlier = queueWithout(inOrder, 0);
    expect(playOrder(earlier)).toBe("[B] C");
    expect(currentOf(earlier)).toBe(b);
    expect(playOrder(queueWithout(shuffled, 1))).toBe("[B] A");
    expect(queueWithout(inOrder, 1)).toEqual(inOrder);
    expect(queueWithout(inOrder, 7)).toEqual(inOrder);
  });

  it("drops a song deleted from the folder, the next one taking over if it was playing", () => {
    // Not the current one: just out of the queue.
    expect(queueWithoutSong(inOrder, c.key)).toEqual({
      queue: queueWithout(inOrder, 2),
      current: "same",
    });
    const before = queueWithoutSong(inOrder, a.key);
    expect([playOrder(before.queue), before.current]).toEqual(["[B] C", "same"]);
    // The current one: the song after it plays, in play order.
    const playing = queueWithoutSong(inOrder, b.key);
    expect([playOrder(playing.queue), playing.current]).toEqual(["A [C]", "next"]);
    const inShuffle = queueWithoutSong(shuffled, b.key);
    expect([playOrder(inShuffle.queue), inShuffle.current]).toEqual(["[C] A", "next"]);
    // The last one: the one before it, then.
    const last = queueWithoutSong({ ...inOrder, position: 2 }, c.key);
    expect([playOrder(last.queue), last.current]).toEqual(["A [B]", "previous"]);
    // The only one: nothing's left.
    const only: Queue = { tracks: [d], order: [0], position: 0 };
    expect(queueWithoutSong(only, d.key)).toEqual({ queue: EMPTY_QUEUE, current: "none" });
    // Not in the queue at all: unchanged.
    expect(queueWithoutSong(inOrder, e.key)).toEqual({ queue: inOrder, current: "same" });
    expect(queueWithoutSong(EMPTY_QUEUE, e.key)).toEqual({ queue: EMPTY_QUEUE, current: "same" });
  });

  it("clears what's after the current song", () => {
    expect(playOrder(queueUntilCurrent(inOrder))).toBe("A [B]");
    expect(playOrder(queueUntilCurrent(shuffled))).toBe("[B]");
    expect(queueUntilCurrent(shuffled).tracks).toEqual([b]);
  });

  it("starts a queue with nothing in it", () => {
    const q = queueWith(EMPTY_QUEUE, [d, e], "next");
    expect(playOrder(q)).toBe("[D] E");
    expect(playOrder(queueWith(EMPTY_QUEUE, [d, e], "last"))).toBe("[D] E");
  });
});
