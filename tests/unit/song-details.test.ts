import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { FFMPEG_PATH } from "../../server/audio";
import {
  CatalogueError,
  deezerDetails,
  deezerSongs,
  isCatalogueCoverUrl,
  itunesSongs,
  lookUpSong,
  lookUpSongNoted,
  pickMatch,
  resetCatalogues,
  CATALOGUE_LIMITS,
  type CatalogueSong,
} from "../../server/catalogues";
import { readId3Frames, withFramesFrom } from "../../server/id3-frames";
import { findAudioFiles, parseFile, type AudioFile } from "../../server/library";
import {
  canWriteDetails,
  detailsArgs,
  detailsFromName,
  lookUpDetails,
  muxerFor,
  parseProbe,
  rewriteProblem,
  writeSongDetails,
} from "../../server/song-details";
import { genresOf } from "../../shared/audio-types";
import {
  NO_VALUE,
  facetCounts,
  filterByFacets,
  filterTracks,
  folderTrack,
} from "../../client/src/lib/music";
import { detailLabels, eachAtOnce } from "../../client/src/lib/song-details";

// Fill in details: the music catalogues' answers (iTunes and Deezer, played
// by stand-ins — no network), and writing what a song lacks into real files
// ffmpeg makes, keeping everything they had.

const COVER_URL = "https://is1-ssl.mzstatic.com/image/thumb/Music/v4/aa/bb/cc/source/600x600bb.jpg";

/** An iTunes search answer with these songs. */
const itunesAnswer = (...results: Record<string, unknown>[]) => ({
  resultCount: results.length,
  results: results.map((r) => ({ wrapperType: "track", kind: "song", ...r })),
});

const SINE_SONG = {
  trackName: "Test Tone",
  artistName: "Sine Wave",
  collectionName: "Pure Tones",
  primaryGenreName: "Electronic",
  releaseDate: "1999-04-01T07:00:00Z",
  trackNumber: 3,
  trackTimeMillis: 3000,
  artworkUrl100: COVER_URL.replace("600x600bb", "100x100bb"),
};

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

describe("the catalogues' answers", () => {
  it("read iTunes' songs: album without “- Single”, genre, year, track, a 600×600 cover", () => {
    const [song, single] = itunesSongs(
      itunesAnswer(SINE_SONG, {
        ...SINE_SONG,
        collectionName: "Test Tone - Single",
        collectionArtistName: "Various Artists",
      }),
    );
    expect(song).toEqual({
      title: "Test Tone",
      artist: "Sine Wave",
      album: "Pure Tones",
      genre: "Electronic",
      year: 1999,
      track: 3,
      duration: 3,
      coverUrl: COVER_URL,
      compilation: false,
      single: false,
    });
    expect(single).toMatchObject({ album: "Test Tone", single: true, compilation: true });
    expect(
      itunesSongs({ results: [{ kind: "music-video", trackName: "x", artistName: "y" }] }),
    ).toEqual([]);
    expect(itunesSongs("nonsense")).toEqual([]);
  });

  it("read Deezer's songs, and the genre, year and track from its song and album", () => {
    const cover = `https://cdn-images.dzcdn.net/images/cover/${"a".repeat(32)}/1000x1000-000000-80-0-0.jpg`;
    expect(
      deezerSongs({
        data: [
          {
            id: 42,
            title: "Test Tone",
            duration: 3,
            artist: { name: "Sine Wave" },
            album: { id: 7, title: "Pure Tones", cover_xl: cover },
          },
          { id: 43, title: "No artist" },
        ],
      }),
    ).toEqual([
      {
        id: 42,
        albumId: 7,
        title: "Test Tone",
        artist: "Sine Wave",
        album: "Pure Tones",
        duration: 3,
        coverUrl: cover,
      },
    ]);
    expect(
      deezerDetails(
        { track_position: 3, release_date: "2001-01-01" },
        {
          genres: { data: [{ name: "Electro" }] },
          release_date: "1999-04-01",
          record_type: "album",
        },
      ),
    ).toEqual({ track: 3, year: 1999, genre: "Electro", compilation: false, single: false });
  });

  it("only offer covers from the catalogues' own image hosts", () => {
    expect(isCatalogueCoverUrl(COVER_URL)).toBe(true);
    expect(
      isCatalogueCoverUrl(
        `https://e-cdns-images.dzcdn.net/images/cover/${"0".repeat(32)}/1000x1000-000000-80-0-0.jpg`,
      ),
    ).toBe(true);
    for (const url of [
      "https://evil.example/image/thumb/a/600x600bb.jpg",
      "http://is1-ssl.mzstatic.com/image/thumb/a/600x600bb.jpg",
      "https://is1-ssl.mzstatic.com.evil.example/image/thumb/a/600x600bb.jpg",
      "https://is1-ssl.mzstatic.com/image/thumb/../../x/600x600bb.jpg",
      "https://is1-ssl.mzstatic.com/image/thumb/a/600x600bb.jpg?x=1",
    ]) {
      expect(isCatalogueCoverUrl(url), url).toBe(false);
    }
  });
});

describe("pickMatch", () => {
  const song = (extra: Partial<CatalogueSong>): CatalogueSong => ({
    title: "Test Tone",
    artist: "Sine Wave",
    ...extra,
  });

  it("takes only the same title by the same artist", () => {
    const search = { track: "Test Tone", artist: "Sine Wave" };
    expect(pickMatch([song({ artist: "Square Wave" }), song({ title: "Other" })], search)).toBe(
      undefined,
    );
    const cover = song({ artist: "Sine Wave & Friends", album: "Covered" });
    expect(pickMatch([cover], search)).toBe(cover);
    // "(Official Video)" and "feat." don't make it another song.
    expect(
      pickMatch([song({})], { track: "Test Tone (Official Video)", artist: "Sine Wave feat. X" }),
    ).toBeDefined();
  });

  it("prefers the same length, then the artist's own album over a compilation or single", () => {
    const search = { track: "Test Tone", artist: "Sine Wave" };
    const compilation = song({ album: "Hits", compilation: true, duration: 180 });
    const single = song({ album: "Single", single: true, duration: 180 });
    const album = song({ album: "Album", duration: 180 });
    const live = song({ album: "Live", duration: 240 });
    expect(pickMatch([live, compilation, single, album], search, 180)).toBe(album);
    expect(pickMatch([live, compilation], search, 180)).toBe(compilation);
    expect(pickMatch([live], search, 180)).toBe(live);
  });

  it("takes a title that differs only in brackets when it's the same length, the same title first", () => {
    const search = { track: "Test Tone (long version)", artist: "Sine Wave" };
    const remaster = song({ title: "Test Tone (Long Version; 2002 Remaster)", duration: 181 });
    expect(pickMatch([remaster], search, 180)).toBe(remaster);
    expect(pickMatch([remaster], search, 240)).toBe(undefined);
    expect(pickMatch([remaster], search)).toBe(undefined);
    const exact = song({ title: "Test Tone (Long Version)", duration: 240 });
    expect(pickMatch([remaster, exact], search, 180)).toBe(exact);
    // A year or a copy's number in the file's name is no part of the title.
    expect(pickMatch([song({})], { track: "Test Tone (1998)", artist: "Sine Wave" })).toBeDefined();
    expect(pickMatch([song({})], { track: "Test Tone HQ (1)", artist: "Sine Wave" })).toBeDefined();
  });

  it("takes an artist spelt a letter out, not another artist", () => {
    const ozzy = song({ title: "Shot In The Dark", artist: "Ozzy Osbourne" });
    expect(pickMatch([ozzy], { track: "Shot in the Dark", artist: "Ozzy Osborne" })).toBe(ozzy);
    const tone = song({ artist: "Sine Wavy" });
    expect(pickMatch([tone], { track: "Test Tone", artist: "Sine Wave" })).toBe(tone);
    expect(pickMatch([song({ artist: "Abba" })], { track: "Test Tone", artist: "Abby" })).toBe(
      undefined,
    );
    expect(pickMatch([tone], { track: "Test Tone", artist: "Sun Wake" })).toBe(undefined);
  });

  it("without an artist, takes only a song the same length", () => {
    const search = { track: "Test Tone", artist: "" };
    expect(pickMatch([song({ duration: 200 })], search, 180)).toBe(undefined);
    expect(pickMatch([song({ duration: 200 })], search)).toBe(undefined);
    expect(pickMatch([song({ duration: 181 })], search, 180)).toBeDefined();
  });
});

describe("lookUpSong", () => {
  beforeEach(() => resetCatalogues());
  afterEach(() => vi.unstubAllGlobals());

  it("asks iTunes first, with just the title and artist", async () => {
    const fetch = vi.fn(async (_url: string) => json(itunesAnswer(SINE_SONG)));
    vi.stubGlobal("fetch", fetch);
    const match = await lookUpSong({ title: "Test Tone", artist: "Sine Wave", duration: 3 });
    expect(match).toMatchObject({ source: "itunes", song: { genre: "Electronic", track: 3 } });
    const url = new URL(fetch.mock.calls[0][0]);
    expect(url.origin + url.pathname).toBe("https://itunes.apple.com/search");
    expect(url.searchParams.get("term")).toBe("Sine Wave Test Tone");
    // Asked again: from memory.
    await lookUpSong({ title: "Test Tone", artist: "Sine Wave", duration: 3 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("switches to Deezer at once when iTunes refuses, and skips iTunes until its time is up", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      asked.push(new URL(url).host + new URL(url).pathname);
      if (url.startsWith("https://itunes.apple.com/")) return new Response("", { status: 403 });
      if (url.includes("/search?")) {
        return json({
          data: [{ id: 42, title: "Test Tone", artist: { name: "Sine Wave" }, album: { id: 7 } }],
        });
      }
      if (url.endsWith("/track/42")) return json({ track_position: 5 });
      if (url.endsWith("/album/7")) return json({ genres: { data: [{ name: "Electro" }] } });
      return new Response("", { status: 404 });
    });
    const first = await lookUpSong({ title: "Test Tone", artist: "Sine Wave" });
    expect(first).toMatchObject({ source: "deezer", song: { genre: "Electro", track: 5 } });
    const second = await lookUpSong({ title: "Another Tone", artist: "Sine Wave" });
    expect(second).toBe(null); // Deezer only knows Test Tone
    expect(asked.filter((a) => a.startsWith("itunes"))).toHaveLength(1);
  });

  it("asks Deezer for a song iTunes doesn't have", async () => {
    vi.stubGlobal("fetch", async (url: string) =>
      url.startsWith("https://itunes.apple.com/")
        ? json(itunesAnswer())
        : url.includes("/search?")
          ? json({ data: [{ id: 1, title: "Test Tone", artist: { name: "Sine Wave" } }] })
          : json({}),
    );
    expect(await lookUpSong({ title: "Test Tone", artist: "Sine Wave" })).toMatchObject({
      source: "deezer",
    });
  });

  it("asks Deezer again without the brackets when they find nothing", async () => {
    const searched: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.startsWith("https://itunes.apple.com/")) return json(itunesAnswer());
      if (!url.includes("/search?")) return json({});
      const q = new URL(url).searchParams.get("q")!;
      searched.push(q);
      return json({
        data: q.includes("(")
          ? []
          : [
              {
                id: 1,
                title: "Test Tone (Extended)",
                artist: { name: "Sine Wave" },
                duration: 300,
              },
            ],
      });
    });
    const match = await lookUpSong({
      title: "Sine Wave - Test Tone (extended version)",
      duration: 301,
    });
    expect(searched).toEqual(["Sine Wave Test Tone (extended version)", "Sine Wave Test Tone"]);
    expect(match).toMatchObject({ source: "deezer", song: { title: "Test Tone (Extended)" } });
  });

  it("says why a song wasn't found: each search, its closest answer, a catalogue that was busy", async () => {
    let itunesBusy = true;
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.startsWith("https://itunes.apple.com/")) {
        if (itunesBusy) return new Response("", { status: 403 });
        return json(itunesAnswer({ ...SINE_SONG, trackName: "Test Tone (Live)" }));
      }
      return json({ data: [{ id: 1, title: "Test Tone", artist: { name: "Someone Else" } }] });
    });
    const busy = await lookUpSongNoted({ title: "Sine Wave - Test Tone", artist: "SineWaveVEVO" });
    expect(busy).toEqual({
      match: null,
      notes: [
        "iTunes was busy, so it wasn't asked",
        "Deezer, “Sine Wave Test Tone”: 1 answer; closest “Test Tone” by Someone Else: a different artist",
        "Deezer, “SineWave Sine Wave - Test Tone”: 1 answer, none with that title or artist (first: “Test Tone” by Someone Else)",
      ],
    });
    // With iTunes answering: its closest answer, and why it wasn't taken.
    resetCatalogues();
    itunesBusy = false;
    const again = await lookUpSongNoted({ title: "Test Tone", artist: "Sine Wave" });
    expect(again.notes[0]).toBe(
      "iTunes, “Sine Wave Test Tone”: 1 answer; closest “Test Tone (Live)” by Sine Wave: a different version, and the song's length isn't known",
    );
  });

  it("asks each catalogue no faster than its published limit, waiting only when there's no other", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
    try {
      const asked = { itunes: 0, deezer: 0 };
      vi.stubGlobal("fetch", async (url: string) => {
        if (url.startsWith("https://itunes.apple.com/")) {
          asked.itunes++;
          return json(itunesAnswer());
        }
        asked.deezer++;
        return json({ data: [] });
      });
      const songs = Array.from({ length: 60 }, (_, i) =>
        lookUpSongNoted({ title: `Tone ${i}`, artist: "Sine Wave" }),
      );
      await vi.advanceTimersByTimeAsync(0);
      // iTunes' 20 a minute, then Deezer's 50 in 5 seconds; the rest wait for Deezer.
      expect(asked).toEqual({ itunes: 20, deezer: 50 });
      await vi.advanceTimersByTimeAsync(CATALOGUE_LIMITS.deezer.perMs);
      const answers = await Promise.all(songs);
      expect(asked).toEqual({ itunes: 20, deezer: 60 });
      expect(answers[59].notes[0]).toBe("iTunes was busy, so it wasn't asked");
      expect(answers.every((answer) => answer.match === null)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says when neither catalogue can be reached", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    await expect(lookUpSong({ title: "Test Tone", artist: "Sine Wave" })).rejects.toThrow(
      CatalogueError,
    );
  });
});

describe("genres", () => {
  it("are each tag once, a “Rock; Pop” tag counting as two", () => {
    expect(genresOf(["Rock; Pop", "rock", " Hip-Hop/Rap ", ""])).toEqual([
      "Rock",
      "Pop",
      "Hip-Hop/Rap",
    ]);
    expect(genresOf(undefined)).toEqual([]);
  });

  const song = (title: string, genres: string[], extra: { artist?: string; year?: number } = {}) =>
    folderTrack({
      id: `id-${title}`.padEnd(22, "x").slice(0, 22),
      path: `${title}.mp3`,
      title,
      artist: extra.artist ?? null,
      album: null,
      genres,
      year: extra.year ?? null,
      duration: null,
      addedAt: "2026-10-01T10:00:00.000Z",
      size: 1000,
    });
  const songs = [
    song("A", ["Rock"], { artist: "Band", year: 1999 }),
    song("B", ["rock", "Pop"], { artist: "Band, Singer", year: 2004 }),
    song("C", ["Jazz"], { artist: "Trio", year: 1999 }),
    song("D", []),
    song("E", ["Rock"], { artist: "Singer" }),
  ];

  it("are counted, the most common first, named as most songs spell them", () => {
    expect(facetCounts(songs, "genre")).toEqual({
      values: [
        { value: "Rock", count: 3 },
        { value: "Jazz", count: 1 },
        { value: "Pop", count: 1 },
      ],
      none: 1,
    });
  });

  it("filter the songs, any spelling, or the songs without one", () => {
    const titles = (filters: Parameters<typeof filterByFacets>[1]) =>
      filterByFacets(songs, filters).map((t) => t.title);
    expect(titles({ genre: "ROCK" })).toEqual(["A", "B", "E"]);
    expect(titles({ genre: NO_VALUE })).toEqual(["D"]);
    expect(titles({})).toHaveLength(5);
    expect(filterTracks(songs, "jaz").map((t) => t.title)).toEqual(["C"]);
  });
});

describe("the other filters", () => {
  const song = (title: string, extra: { artist?: string; album?: string; year?: number }) =>
    folderTrack({
      id: `id-${title}`.padEnd(22, "x").slice(0, 22),
      path: `${title}.mp3`,
      title,
      artist: extra.artist ?? null,
      album: extra.album ?? null,
      genres: [],
      year: extra.year ?? null,
      duration: null,
      addedAt: "2026-10-01T10:00:00.000Z",
      size: 1000,
    });
  const songs = [
    song("A", { artist: "Band", album: "First", year: 1999 }),
    song("B", { artist: "Band, Singer", album: "Second", year: 2004 }),
    song("C", { artist: "Trio", album: "First", year: 1999 }),
    song("D", {}),
  ];

  it("count artists A–Z (each of a song's artists), albums A–Z and years newest first", () => {
    expect(facetCounts(songs, "artist").values.map((v) => `${v.value} ${v.count}`)).toEqual([
      "Band 2",
      "Singer 1",
      "Trio 1",
    ]);
    expect(facetCounts(songs, "album").values.map((v) => v.value)).toEqual(["First", "Second"]);
    expect(facetCounts(songs, "year")).toEqual({
      values: [
        { value: "2004", count: 1 },
        { value: "1999", count: 2 },
      ],
      none: 1,
    });
  });

  it("work together, and the year can be typed in the filter box", () => {
    const titles = (filters: Parameters<typeof filterByFacets>[1]) =>
      filterByFacets(songs, filters).map((t) => t.title);
    expect(titles({ artist: "singer" })).toEqual(["B"]);
    expect(titles({ album: "First", year: "1999" })).toEqual(["A", "C"]);
    expect(titles({ album: "First", artist: "Trio" })).toEqual(["C"]);
    expect(titles({ year: NO_VALUE })).toEqual(["D"]);
    expect(filterTracks(songs, "2004").map((t) => t.title)).toEqual(["B"]);
  });
});

describe("the review", () => {
  it("lists what was found", () => {
    expect(
      detailLabels({ genre: "Rock", album: "Album", year: 1999, track: 3, coverUrl: COVER_URL }),
    ).toEqual(["Genre: Rock", "Album: Album", "1999", "Track 3", "Cover"]);
  });

  it("works on that many songs at once, and starts no more once stopped", async () => {
    let running = 0;
    let most = 0;
    const done: number[] = [];
    const stop = new AbortController();
    await eachAtOnce(
      [1, 2, 3, 4, 5, 6, 7, 8],
      async (n) => {
        most = Math.max(most, ++running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running--;
        done.push(n);
        if (n === 4) stop.abort();
      },
      3,
      stop.signal,
    );
    expect(most).toBe(3);
    expect(done.length).toBeLessThan(8);
  });
});

// --- Writing into real files ----------------------------------------------------------

let dir: string;
let jpeg: Buffer;

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_PATH!, ["-hide_banner", "-loglevel", "error", "-y", ...args], {
      windowsHide: true,
    });
    let err = "";
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg: ${err}`))));
  });
}

const tone = (file: string, codecArgs: string[]) =>
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=3", ...codecArgs, file]);

/** The file as the folder scan finds it. */
async function scanned(name: string): Promise<AudioFile> {
  const { files } = await findAudioFiles(dir);
  return files.find((file) => file.relative === name)!;
}

/** Every tag id the file has, by type. */
async function tagIds(name: string) {
  const { native } = await parseFile(path.join(dir, name), { skipCovers: true });
  return Object.fromEntries(
    Object.entries(native).map(([type, tags]) => [type, tags.map((t) => t.id)]),
  );
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-details-test-"));
  const picture = path.join(dir, "cover.jpg.src");
  await ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=64x64",
    "-frames:v",
    "1",
    "-f",
    "mjpeg",
    picture,
  ]);
  jpeg = await fs.readFile(picture);
  // An MP3 the way the app saves them, with its Spotify song.
  await tone(path.join(dir, "Sine Wave - Test Tone.mp3"), [
    ...["-c:a", "libmp3lame", "-b:a", "128k", "-id3v2_version", "3"],
    ...["-metadata", "title=Test Tone", "-metadata", "artist=Sine Wave"],
    ...["-metadata", "spotify_id=0123456789abcdefghijkl"],
  ]);
  await tone(path.join(dir, "Tone.m4a"), [
    ...["-c:a", "aac", "-metadata", "title=Test Tone", "-metadata", "artist=Sine Wave"],
    ...["-metadata", "comment=https://open.spotify.com/track/0123456789abcdefghijkl"],
  ]);
  await tone(path.join(dir, "Tone.flac"), ["-c:a", "flac", "-metadata", "title=Test Tone"]);
  await tone(path.join(dir, "Tone.opus"), [
    ...["-c:a", "libopus", "-metadata", "title=Test Tone", "-metadata", "genre=Ambient"],
  ]);
  await tone(path.join(dir, "Old.wma"), ["-c:a", "wmav2"]);
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("writeSongDetails", () => {
  beforeEach(() => {
    resetCatalogues();
    // The cover's address answers with a picture; nothing else is reachable.
    vi.stubGlobal("fetch", async (url: string) =>
      url === COVER_URL
        ? new Response(jpeg, { headers: { "content-type": "image/jpeg" } })
        : json(itunesAnswer(SINE_SONG)),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const details = {
    title: "Wrong Title",
    genre: "Electronic",
    album: "Pure Tones",
    year: 1999,
    track: 3,
    coverUrl: COVER_URL,
  };

  it("adds only what an MP3 lacks, keeping its tags, audio and dates", async () => {
    const name = "Sine Wave - Test Tone.mp3";
    const file = await scanned(name);
    const before = await fs.stat(file.absolute);
    const audioBefore = await parseFile(file.absolute, { duration: true });

    expect(await writeSongDetails(file, details)).toEqual([
      "album",
      "genre",
      "year",
      "track",
      "cover",
    ]);

    const after = await fs.stat(file.absolute);
    // To the millisecond (file systems keep finer times than a number of seconds can carry).
    expect(Math.abs(after.mtimeMs - before.mtimeMs)).toBeLessThan(1);
    if (before.birthtimeMs) expect(after.birthtimeMs).toBe(before.birthtimeMs);
    const { common, format } = await parseFile(file.absolute, { duration: true });
    expect(common).toMatchObject({
      title: "Test Tone", // kept: it had one
      artist: "Sine Wave",
      album: "Pure Tones",
      genre: ["Electronic"],
      year: 1999,
      track: { no: 3 },
    });
    expect(common.picture?.[0].format).toBe("image/jpeg");
    expect(format.duration).toBeCloseTo(audioBefore.format.duration!, 1);
    expect((await tagIds(name))["ID3v2.3"]).toContain("TXXX:spotify_id");

    // Everything's there now: nothing more to add.
    expect(await writeSongDetails(await scanned(name), details)).toEqual([]);
  });

  it("keeps the frames ffmpeg can't copy, like an MP3's web address (WOAS)", async () => {
    const name = "Sine Wave - With Address.mp3";
    await tone(path.join(dir, "plain.src"), [
      ...["-c:a", "libmp3lame", "-b:a", "128k", "-id3v2_version", "3", "-f", "mp3"],
      ...["-metadata", "title=With Address", "-metadata", "artist=Sine Wave"],
    ]);
    const address = Buffer.from("https://example.com/with-address", "latin1");
    const woas = Buffer.concat([Buffer.from("WOAS"), Buffer.alloc(6), address]);
    woas.writeUInt32BE(address.length, 4);
    const tagOnly = Buffer.concat([
      Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, woas.length]),
      woas,
    ]);
    const mp3 = withFramesFrom(tagOnly, await fs.readFile(path.join(dir, "plain.src")), ["WOAS"]);
    await fs.writeFile(path.join(dir, name), mp3!);
    expect((await tagIds(name))["ID3v2.3"]).toContain("WOAS");

    expect(await writeSongDetails(await scanned(name), details)).toContain("genre");
    const ids = (await tagIds(name))["ID3v2.3"];
    expect(ids).toEqual(expect.arrayContaining(["WOAS", "TCON", "TIT2"]));
    const frames = readId3Frames(await fs.readFile(path.join(dir, name)))!.frames;
    expect(frames.find((frame) => frame.id === "WOAS")!.bytes.subarray(10)).toEqual(address);
  });

  it("writes into .m4a, .flac and .opus files too, keeping an Ogg file's tags", async () => {
    for (const name of ["Tone.m4a", "Tone.flac", "Tone.opus"]) {
      const added = await writeSongDetails(await scanned(name), details);
      expect(added, name).toContain("cover");
      const { common } = await parseFile(path.join(dir, name));
      expect(common.picture, name).toHaveLength(1);
      expect(common.album, name).toBe("Pure Tones");
    }
    // The .opus had a genre: it stays.
    const opus = await parseFile(path.join(dir, "Tone.opus"));
    expect(opus.common.genre).toEqual(["Ambient"]);
    expect((await parseFile(path.join(dir, "Tone.m4a"))).common.comment?.[0]).toMatchObject({
      text: "https://open.spotify.com/track/0123456789abcdefghijkl",
    });
  });

  it("keeps an Ogg file's cover when adding other details", async () => {
    // Its cover went in above; it still has no artist.
    const file = await scanned("Tone.opus");
    expect(await writeSongDetails(file, { artist: "Sine Wave", genre: "Rock" })).toEqual([
      "artist",
    ]);
    const { common } = await parseFile(file.absolute);
    expect(common).toMatchObject({ artist: "Sine Wave", genre: ["Ambient"] });
    expect(common.picture).toHaveLength(1);
  });

  it("won't write into a kind of file that can't hold tags", async () => {
    expect(canWriteDetails("Old.wma")).toBe(false);
    await expect(writeSongDetails(await scanned("Old.wma"), details)).rejects.toThrow(
      /can't write tags into \.wma files/,
    );
    expect(await lookUpDetails(await scanned("Old.wma"))).toMatchObject({
      writable: false,
      found: null,
    });
  });

  it("tells what's wrong with a file named .mp3 that isn't one, leaving it as it was", async () => {
    // An M4A someone renamed: copied as an MP3, ffmpeg would refuse ("Invalid argument").
    await fs.copyFile(path.join(dir, "Tone.m4a"), path.join(dir, "Renamed.mp3"));
    const before = await fs.readFile(path.join(dir, "Renamed.mp3"));
    const lookup = await lookUpDetails(await scanned("Renamed.mp3"));
    expect(lookup).toMatchObject({ writable: false, found: null });
    expect(lookup.problem).toMatch(
      /really an M4A .* \(AAC audio\) named \.mp3: rename it to end in \.m4a/,
    );
    await expect(writeSongDetails(await scanned("Renamed.mp3"), details)).rejects.toThrow(
      /left as it was: it's really an M4A/,
    );
    expect(await fs.readFile(path.join(dir, "Renamed.mp3"))).toEqual(before);
    // A real MP3 has no problem.
    expect((await lookUpDetails(await scanned("Sine Wave - Test Tone.mp3"))).problem).toBeNull();
    await fs.rm(path.join(dir, "Renamed.mp3"));
  });

  it("knows each kind of file by what's in it, not its name", () => {
    expect(
      parseProbe(
        "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'x.mp3':\n  Duration: 00:00:03.02\n  Stream #0:0[0x1](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz\n",
      ),
    ).toEqual({ container: "mov,mp4,m4a,3gp,3g2,mj2", codec: "aac" });
    expect(muxerFor(".mp3", { container: "mp3", codec: "mp3" })).toEqual({ muxer: "mp3" });
    expect(muxerFor(".m4a", { container: "mov,mp4,m4a,3gp,3g2,mj2", codec: "alac" })).toEqual({
      muxer: "ipod",
    });
    expect(muxerFor(".ogg", { container: "ogg", codec: "opus" })).toEqual({ muxer: "ogg" });
    expect(muxerFor(".mp3", { container: "ogg", codec: "opus" })).toEqual({
      problem: expect.stringContaining("rename it to end in .opus"),
    });
    expect(muxerFor(".mp3", { container: "mp3", codec: "mp2" })).toEqual({
      problem:
        "it's really MP2 audio in a file ffmpeg calls “mp3”, though it's named .mp3, and the app can't add tags to that",
    });
    expect(muxerFor(".opus", { container: "ogg", codec: "vorbis" })).toEqual({
      problem: expect.stringContaining("rename it to end in .ogg"),
    });
    expect(muxerFor(".flac", {})).toEqual({ problem: expect.stringContaining("couldn't tell") });
  });

  it("leaves the song as it was if the copy lost a tag, the audio changed or a detail is missing", () => {
    const meta = (ids: string[], extra: Record<string, unknown> = {}, duration = 180) =>
      ({
        format: { codec: "MPEG 1 Layer 3", numberOfChannels: 2, duration },
        common: { genre: ["Rock"], ...extra },
        native: { "ID3v2.3": ids.map((id) => ({ id, value: "x" })) },
      }) as unknown as Parameters<typeof rewriteProblem>[0];
    const before = meta(["TIT2", "TXXX:spotify_id", "TSSE"]);
    expect(rewriteProblem(before, meta(["TIT2", "TXXX:spotify_id", "TCON"]), ["genre"])).toBe(
      undefined,
    );
    expect(rewriteProblem(before, meta(["TIT2", "TCON"]), ["genre"])).toMatch(/lose.*spotify_id/);
    expect(rewriteProblem(before, meta(["TIT2", "TXXX:spotify_id"], {}, 120), [])).toMatch(
      /different length/,
    );
    expect(
      rewriteProblem(before, meta(["TIT2", "TXXX:spotify_id"], { genre: undefined }), ["genre"]),
    ).toMatch(/genre didn't go in/);
  });

  it("copies the streams as they are, with the new tags on top", () => {
    const args = detailsArgs({
      input: "in.mp3",
      output: "out.mp3",
      ext: ".mp3",
      metadata: "tags.txt",
      cover: "cover.jpg",
      id3: { version: 3, v1: true },
    });
    expect(args.join(" ")).toContain(
      "-i in.mp3 -i cover.jpg -f ffmetadata -i tags.txt -map 0:a -map 0:v? -map 1:v -map_metadata 0 -map_metadata 2 -c copy -disposition:v:0 attached_pic -id3v2_version 3 -write_id3v1 1 -f mp3 -y out.mp3",
    );
  });
});

describe("lookUpDetails", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("says what a song lacks and what the catalogue has for just that", async () => {
    resetCatalogues();
    const name = "Bare.mp3";
    await tone(path.join(dir, name), ["-c:a", "libmp3lame", "-b:a", "128k"]);
    await fs.rename(path.join(dir, name), path.join(dir, "Sine Wave - Test Tone (Part 2).mp3"));
    vi.stubGlobal("fetch", async (url: string) =>
      json(
        itunesAnswer({
          ...SINE_SONG,
          trackName: new URL(url).searchParams.get("term")?.includes("(Part 2)")
            ? "Test Tone (Part 2)"
            : "Test Tone",
        }),
      ),
    );
    const lookup = await lookUpDetails(await scanned("Sine Wave - Test Tone (Part 2).mp3"));
    expect(lookup).toMatchObject({
      missing: ["title", "artist", "album", "genre", "year", "track", "cover"],
      writable: true,
      source: "itunes",
      found: {
        title: "Test Tone (Part 2)",
        artist: "Sine Wave",
        genre: "Electronic",
        coverUrl: COVER_URL,
      },
    });
  });

  it("takes the title and artist from an “Artist - Song” name no catalogue has, for a song without them", async () => {
    resetCatalogues();
    await tone(path.join(dir, "Bare.mp3"), ["-c:a", "libmp3lame", "-b:a", "128k"]);
    await fs.rename(path.join(dir, "Bare.mp3"), path.join(dir, "Sine Wave - Rare Tone HQ.mp3"));
    vi.stubGlobal("fetch", async (url: string) =>
      url.startsWith("https://itunes.apple.com/") ? json(itunesAnswer()) : json({ data: [] }),
    );
    const lookup = await lookUpDetails(await scanned("Sine Wave - Rare Tone HQ.mp3"));
    expect(lookup).toMatchObject({
      source: "name",
      match: null,
      found: { title: "Rare Tone", artist: "Sine Wave" },
    });
    expect(lookup.notes.length).toBeGreaterThan(0);
    // Not for a name without two halves, or a song with a title or artist already.
    expect(detailsFromName("Rare Tone.mp3", ["title", "artist"])).toEqual({});
    expect(detailsFromName("A - B.mp3", ["album", "genre"])).toEqual({});
    expect(
      detailsFromName("Sub/2Pac - Hit 'Em Up (Official Video).mp3", ["title", "artist"]),
    ).toEqual({ artist: "2Pac", title: "Hit 'Em Up" });
  });
});
