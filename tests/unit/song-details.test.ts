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
  pickVersion,
  musicBrainzArtistGenre,
  genreOfArtistNamed,
  resetCatalogues,
  CATALOGUE_LIMITS,
  type CatalogueSong,
  bareTitle,
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
  probeFile,
  rewriteProblem,
  writeSongDetails,
} from "../../server/song-details";
import { genresOf } from "../../shared/audio-types";
import {
  NO_VALUE,
  facetChoicesOf,
  facetCounts,
  filterByFacets,
  matchChoices,
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

  it("takes a name that holds the artist and title with no dash between them", () => {
    const earth = song({ title: "Earth Song", artist: "Michael Jackson" });
    const bad = song({ title: "Bad (2012 Remaster)", artist: "Michael Jackson" });
    expect(pickMatch([earth], { track: "Michael Jackson Earth Song", artist: "" })).toBe(earth);
    expect(pickMatch([earth], { track: "Earth Song Michael Jackson", artist: "" })).toBe(earth);
    expect(pickMatch([bad], { track: "Michael Jackson Bad", artist: "" })).toBe(bad);
    // Not just some of the words.
    expect(pickMatch([earth], { track: "Michael Jackson Earth Song Live", artist: "" })).toBe(
      undefined,
    );
  });

  it("compares whole artist names: one of a duo isn't someone else of that first name", () => {
    const menace = song({ title: "Menace", artist: "Fred Lark Brown" });
    expect(pickMatch([menace], { track: "Menace", artist: "Fred & Ginger" })).toBe(undefined);
    const wailers = song({ title: "Heathen", artist: "Bob Marley & The Wailers" });
    expect(pickMatch([wailers], { track: "Heathen", artist: "Bob Marley" })).toBe(wailers);
    const sayx3 = song({ title: "Say Say Say", artist: "Paul McCartney" });
    expect(
      pickMatch([sayx3], { track: "Say Say Say", artist: "Michael Jackson & Paul McCartney" }),
    ).toBe(sayx3);
    // The same but for spaces and punctuation.
    const bells = song({ title: "Hells Bells", artist: "AC/DC" });
    expect(pickMatch([bells], { track: "Hells Bells", artist: "ACDC" })).toBe(bells);
  });

  it("takes a title with a featured artist after it, or its words in another order", () => {
    const despacito = song({ title: "Despacito", artist: "Luis Fonsi" });
    expect(
      pickMatch([despacito], { track: "Despacito ft. Daddy Yankee", artist: "Luis Fonsi" }),
    ).toBe(despacito);
    const requiem = song({ title: "Requiem For A Dream (Paul Oakenfold Remix)", artist: "Leama" });
    expect(
      pickMatch([requiem], {
        track: "Requiem for a Dream Remix (Paul Oakenfold)",
        artist: "Leama",
      }),
    ).toBe(requiem);
  });

  it("takes a version named after a dash or with a year when it's the same length", () => {
    const heathen = song({ title: "Heathen (Live at Ahoy)", artist: "Bob Marley", duration: 300 });
    expect(pickMatch([heathen], { track: "Heathen - Live 1978", artist: "Bob Marley" }, 301)).toBe(
      heathen,
    );
    expect(pickMatch([heathen], { track: "Heathen - Live 1978", artist: "Bob Marley" }, 200)).toBe(
      undefined,
    );
    expect(bareTitle("Mindfields original")).toBe("Mindfields");
    expect(bareTitle("By Myself - (Hybrid Theory)")).toBe("By Myself");
    expect(bareTitle("Close To Me - T.O.S. - Exclusive")).toBe("Close To Me");
    expect(bareTitle("Rhythm Of The Night (Extended Version) HD 1993")).toBe("Rhythm Of The Night");
    // A title that's only a year stays.
    expect(bareTitle("1999")).toBe("1999");
  });

  it("takes a dash-less name whose other words are one of the song's artists", () => {
    const sayx3 = song({ title: "Say Say Say", artist: "Paul McCartney" });
    expect(
      pickMatch([sayx3], { track: "Michael Jackson & Paul McCartney Say Say Say", artist: "" }),
    ).toBe(sayx3);
    const souls = song({ title: "Beneath, Between, Beyond", artist: "Static-X" });
    expect(
      pickMatch([souls], { track: "Static-X Beneath, Between, Beyond (Song)", artist: "" }),
    ).toBe(souls);
  });

  it("takes a title spelt a little differently, but never another number", () => {
    const sober = song({ title: "Call Me When You're Sober", artist: "Evanescence" });
    expect(pickMatch([sober], { track: "Call Me When Your Sober", artist: "Evanescence" })).toBe(
      sober,
    );
    const kyur = song({ title: "Kyur4 th Ich", artist: "LINKIN PARK" });
    expect(pickMatch([kyur], { track: "Kyur 4 Th Ich", artist: "Linkin Park" })).toBe(kyur);
    const two = song({ title: "Test Tone Part 2" });
    expect(pickMatch([two], { track: "Test Tone Part 1", artist: "Sine Wave" })).toBe(undefined);
    expect(
      pickMatch([song({ title: "Toast Tune" })], { track: "Test Tone", artist: "Sine Wave" }),
    ).toBe(undefined);
  });

  it("takes a title with a year or “original” after it, a Remix for a Mix, and notes the same recording has", () => {
    const heaven = song({ title: "Heaven (Lange Remix)", artist: "Agenda" });
    expect(pickMatch([heaven], { track: "Heaven Lange Remix 1999", artist: "Agenda" })).toBe(
      heaven,
    );
    expect(pickMatch([heaven], { track: "Heaven (Lange Mix)", artist: "Agenda" })).toBe(heaven);
    const angel = song({ title: "Angel (Original Mix)", artist: "Jezper Söderlund" });
    expect(pickMatch([angel], { track: "Angel (Original)", artist: "Jezper Söderlund" })).toBe(
      angel,
    );
    const name = song({ title: "My Name (feat. Eminem & Nate Dogg) [Amended]", artist: "Xzibit" });
    expect(pickMatch([name], { track: "My Name ft. Eminem & Nate Dogg", artist: "Xzibit" })).toBe(
      name,
    );
    // A year that's the title's own still has to be there.
    const party = song({ title: "Party Like It's 1999", artist: "Prince" });
    expect(pickMatch([party], { track: "Party Like It's 1999", artist: "Prince" })).toBe(party);
  });

  it("takes an artist named with or without “and” or “the”", () => {
    const know = song({ title: "Do You Know", artist: "Black And White" });
    expect(pickMatch([know], { track: "Do You Know", artist: "Black White" })).toBe(know);
    const warning = song({ title: "Warning", artist: "The Notorious B.I.G." });
    expect(pickMatch([warning], { track: "Warning", artist: "Notorious B.I.G." })).toBe(warning);
  });

  it("takes a film's name for the artist when the song is on its album", () => {
    const bandhan = song({
      title: "Pairon Mein Bandhan Hai",
      artist: "Anand Bakshi",
      album: "Mohabbatein (Original Motion Picture Soundtrack)",
    });
    expect(pickMatch([bandhan], { track: "Pairon Mein Bandhan Hai", artist: "Mohabbatein" })).toBe(
      bandhan,
    );
    // Not an album that only starts with the name, nor a tribute's cover; the artist's own first.
    const starts = song({ title: "Bohemian Rhapsody", artist: "Someone", album: "Queen Tribute" });
    expect(pickMatch([starts], { track: "Bohemian Rhapsody", artist: "Queen" })).toBe(undefined);
    const tribute = song({
      title: "Bohemian Rhapsody",
      artist: "Someone",
      album: "Queen (A Tribute)",
    });
    expect(pickMatch([tribute], { track: "Bohemian Rhapsody", artist: "Queen" })).toBe(undefined);
    const own = song({
      title: "Bohemian Rhapsody",
      artist: "Queen",
      album: "A Night at the Opera",
    });
    const named = song({ title: "Bohemian Rhapsody", artist: "Someone", album: "Queen" });
    expect(pickMatch([named, own], { track: "Bohemian Rhapsody", artist: "Queen" })).toBe(own);
  });

  it("takes a dash-less name whose words are the title's and an artist's, in any order", () => {
    const sammi = song({
      title: "Sammi Meri Waar (Coke Studio Season 8)",
      artist: "Quratulain Balouch & Umair Jaswal",
    });
    expect(
      pickMatch([sammi], {
        track: "Coke Studio Season 8 Sammi Meri Waar Umair Jaswal & Quratulain Balouch",
        artist: "",
      }),
    ).toBe(sammi);
    const cream = song({ title: "Cream (Paul Van Dyk Remix)", artist: "Blank & Jones" });
    expect(pickMatch([cream], { track: "Blank Jones Cream Paul van Dyk Remix", artist: "" })).toBe(
      cream,
    );
  });

  it("without an artist, takes only a song the same length", () => {
    const search = { track: "Test Tone", artist: "" };
    expect(pickMatch([song({ duration: 200 })], search, 180)).toBe(undefined);
    expect(pickMatch([song({ duration: 200 })], search)).toBe(undefined);
    expect(pickMatch([song({ duration: 181 })], search, 180)).toBeDefined();
  });
});

describe("pickVersion", () => {
  it("finds another version of the song by its artist, one with a genre first", () => {
    const search = { track: "Breathe (In The Air) (Extended)", artist: "Pink Floyd" };
    const plain = { title: "Breathe (In the Air)", artist: "Pink Floyd" };
    const withGenre = { title: "Breathe", artist: "Pink Floyd", genre: "Rock" };
    expect(pickVersion([plain, withGenre], search)).toBe(withGenre);
    expect(pickVersion([plain], search)).toBe(plain);
    // The other way round too; never another artist's, nor a name with no artist.
    expect(pickVersion([plain], { track: "Pink Floyd", artist: "Breathe (Extended)" })).toBe(plain);
    expect(pickVersion([{ ...plain, artist: "Someone Else" }], search)).toBe(undefined);
    expect(pickVersion([plain], { track: "Pink Floyd Breathe", artist: "" })).toBe(undefined);
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
      if (url.startsWith("https://itunes.apple.com/")) {
        return new Response("", { status: 403, headers: { "retry-after": "3600" } });
      }
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

  it("asks MusicBrainz, one a second, for a song iTunes and Deezer don't have", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.startsWith("https://itunes.apple.com/")) return json(itunesAnswer());
      if (!url.startsWith("https://musicbrainz.org/")) return json({ data: [] });
      asked.push(new URL(url).searchParams.get("query")!);
      // MusicBrainz asks each app to say who it is.
      expect(new Headers(init?.headers).get("user-agent")).toMatch(/^YTDownload\//);
      return json(
        url.includes("Pipeline")
          ? {
              recordings: [
                {
                  title: "Pipeline",
                  length: 556280,
                  "first-release-date": "1999",
                  "artist-credit": [{ name: "Man With No Name" }],
                  tags: [{ name: "psy-trance", count: 2 }],
                  releases: [
                    {
                      title: "Goa-Visions",
                      date: "1999",
                      "release-group": {
                        "primary-type": "Album",
                        "secondary-types": ["Compilation"],
                      },
                      media: [{ track: [{ number: "4" }] }],
                    },
                    {
                      title: "Interstate Highway",
                      status: "Official",
                      date: "2003-07-14",
                      "release-group": { "primary-type": "Album" },
                      media: [{ track: [{ number: "9" }] }],
                    },
                  ],
                },
              ],
            }
          : { recordings: [] },
      );
    });
    const started = Date.now();
    const [found, missed] = await Promise.all([
      lookUpSongNoted({ title: "Man With No Name - Pipeline", duration: 556 }),
      lookUpSongNoted({ title: "Sine Wave - Nowhere Tone" }),
    ]);
    expect(found.match).toEqual({
      source: "musicbrainz",
      song: expect.objectContaining({
        title: "Pipeline",
        artist: "Man With No Name",
        album: "Interstate Highway", // its own album, not the compilation
        genre: "Psy-Trance",
        year: 1999,
        track: 9,
      }),
    });
    expect(missed).toMatchObject({ match: null, noneHasIt: true });
    expect(asked.sort()).toEqual([
      'recording:"Nowhere Tone" AND artist:"Sine Wave"',
      'recording:"Pipeline" AND artist:"Man With No Name"',
      // The halves the other way round: "Song - Artist".
      'recording:"Sine Wave" AND artist:"Nowhere Tone"',
    ]);
    // The second waited its turn.
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it("asks the next catalogue when one has the song but none of the details it needs", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.startsWith("https://itunes.apple.com/")) {
        return json(itunesAnswer({ ...SINE_SONG, primaryGenreName: undefined }));
      }
      if (url.includes("/search?")) {
        return json({
          data: [{ id: 1, title: "Test Tone", artist: { name: "Sine Wave" }, album: { id: 7 } }],
        });
      }
      return json(url.endsWith("/album/7") ? { genres: { data: [{ name: "Electro" }] } } : {});
    });
    // iTunes has the song, but no genre: Deezer is asked, and has it.
    const genre = await lookUpSongNoted({ title: "Test Tone", artist: "Sine Wave" }, ["genre"]);
    expect(genre.match).toMatchObject({ source: "deezer", song: { genre: "Electro" } });
    // Asked for its album, iTunes' answer does.
    const album = await lookUpSongNoted({ title: "Test Tone", artist: "Sine Wave" }, ["album"]);
    expect(album.match).toMatchObject({ source: "itunes", song: { album: "Pure Tones" } });
  });

  it("uses the catalogue with the most of what a song lacks, the earlier one on a tie", async () => {
    let deezerGenre = true;
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.startsWith("https://itunes.apple.com/")) {
        return json(itunesAnswer({ ...SINE_SONG, primaryGenreName: undefined }));
      }
      if (url.includes("/search?")) {
        return json({
          data: [
            {
              id: 1,
              title: "Test Tone",
              artist: { name: "Sine Wave" },
              album: { id: 7, title: "Deezer Tones" },
            },
          ],
        });
      }
      if (url.endsWith("/album/7")) {
        return json(deezerGenre ? { genres: { data: [{ name: "Electro" }] } } : {});
      }
      return json({});
    });
    // iTunes has the album but no genre; Deezer has both.
    const both = await lookUpSongNoted({ title: "Test Tone", artist: "Sine Wave" }, [
      "genre",
      "album",
    ]);
    expect(both.match).toMatchObject({
      source: "deezer",
      song: { genre: "Electro", album: "Deezer Tones" },
    });
    // Each has just the album: iTunes, the first asked.
    resetCatalogues();
    deezerGenre = false;
    const tie = await lookUpSongNoted({ title: "Test Tone", artist: "Sine Wave" }, [
      "genre",
      "album",
    ]);
    expect(tie.match).toMatchObject({ source: "itunes", song: { album: "Pure Tones" } });
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
        // Busy for an hour: longer than its own limit's minute, so not waited for.
        if (itunesBusy)
          return new Response("", { status: 403, headers: { "retry-after": "3600" } });
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
        "Deezer, “SineWave Sine Wave - Test Tone”: 2 answers, none with that title or artist (first: “Test Tone” by Someone Else)",
        "MusicBrainz, “Sine Wave Test Tone”: nothing came back",
        "MusicBrainz, “SineWave Sine Wave - Test Tone”: nothing came back",
      ],
      // iTunes wasn't asked: it may have the song.
      noneHasIt: false,
    });
    // With iTunes answering: its closest answer, and why it wasn't taken (its genre
    // would be another version's, but the album is what's wanted).
    resetCatalogues();
    itunesBusy = false;
    const again = await lookUpSongNoted({ title: "Test Tone", artist: "Sine Wave" }, ["album"]);
    expect(again.notes[0]).toBe(
      "iTunes, “Sine Wave Test Tone”: 1 answer; closest “Test Tone (Live)” by Sine Wave: a different version, and the song's length isn't known",
    );
  });

  it("asks each catalogue no faster than its published limit, waiting for one only a moment once another has answered", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
    try {
      const asked = { itunes: 0, deezer: 0, musicbrainz: 0 };
      vi.stubGlobal("fetch", async (url: string) => {
        if (url.startsWith("https://itunes.apple.com/")) {
          asked.itunes++;
          return json(itunesAnswer());
        }
        if (url.startsWith("https://musicbrainz.org/")) {
          asked.musicbrainz++;
          return json({ recordings: [] });
        }
        asked.deezer++;
        return json({ data: [] });
      });
      const songs = Array.from({ length: 60 }, (_, i) =>
        lookUpSongNoted({ title: `Tone ${i}`, artist: "Sine Wave" }),
      );
      await vi.advanceTimersByTimeAsync(0);
      // iTunes' 20 a minute, then Deezer's 50 in 5 seconds; the rest wait for Deezer.
      // MusicBrainz, for the songs neither has, one a second.
      expect(asked).toEqual({ itunes: 20, deezer: 50, musicbrainz: 1 });
      // A minute later every song has its answer: none waited out iTunes' minute.
      await vi.advanceTimersByTimeAsync(CATALOGUE_LIMITS.musicbrainz.perMs * 60);
      const answers = await Promise.all(songs);
      expect(asked).toMatchObject({ deezer: 60, musicbrainz: 60 });
      expect(asked.itunes).toBeLessThan(60);
      const skipped = answers.filter((answer) =>
        answer.notes.includes("iTunes was busy, so it wasn't asked"),
      );
      expect(skipped).toHaveLength(60 - asked.itunes);
      // Not marked Not found: iTunes may have them, and the next run asks it.
      expect(skipped.every((answer) => answer.noneHasIt === false)).toBe(true);
      expect(answers.every((answer) => answer.match === null)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("doesn't wait out a catalogue that refused once the others have answered", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
    try {
      let itunes = 0;
      vi.stubGlobal("fetch", async (url: string) => {
        if (url.startsWith("https://itunes.apple.com/")) {
          itunes++;
          return new Response("", { status: 403 }); // no Retry-After: its own minute
        }
        return json(url.startsWith("https://musicbrainz.org/") ? { recordings: [] } : { data: [] });
      });
      const answer = lookUpSongNoted({ title: "Test Tone", artist: "Sine Wave" });
      // Deezer and MusicBrainz answer within seconds, well inside iTunes' minute.
      await vi.advanceTimersByTimeAsync(CATALOGUE_LIMITS.musicbrainz.perMs * 5);
      expect(await answer).toMatchObject({
        match: null,
        noneHasIt: false,
        notes: expect.arrayContaining(["iTunes was busy, so it wasn't asked"]),
      });
      expect(itunes).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("finds a “Song - Artist” name the other way round", async () => {
    const searched: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.startsWith("https://itunes.apple.com/")) return json(itunesAnswer());
      if (url.startsWith("https://musicbrainz.org/")) return json({ recordings: [] });
      if (!url.includes("/search?")) return json({});
      searched.push(new URL(url).searchParams.get("q")!);
      return json({
        data: [
          { id: 1, title: "Rebellion (feat. Daron Malakian)", artist: { name: "Linkin Park" } },
        ],
      });
    });
    const match = await lookUpSong({ title: "Rebellion - Linkin Park (feat. Daron Malakian)" });
    expect(match).toMatchObject({ source: "deezer", song: { artist: "Linkin Park" } });
    expect(searched).toEqual(["Rebellion Linkin Park"]);
  });

  it("finds a “Song - Artist (Album)” name, the album in brackets after the artist", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.startsWith("https://itunes.apple.com/")) return json(itunesAnswer());
      if (url.startsWith("https://musicbrainz.org/")) return json({ recordings: [] });
      if (!url.includes("/search?")) return json({});
      return json({ data: [{ id: 1, title: "My December", artist: { name: "Linkin Park" } }] });
    });
    const match = await lookUpSong({ title: "My December - Linkin Park (Hybrid Theory)" });
    expect(match).toMatchObject({ source: "deezer", song: { artist: "Linkin Park" } });
  });

  it("asks Deezer again without what versions add when its answers aren't the song", async () => {
    const searched: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.startsWith("https://itunes.apple.com/")) return json(itunesAnswer());
      if (!url.includes("/search?")) return json({});
      const q = new URL(url).searchParams.get("q")!;
      searched.push(q);
      return json({
        data: q.includes("Remastered")
          ? [{ id: 1, title: "Vou Festejar", artist: { name: "Sambabook" } }]
          : [{ id: 2, title: "Kiss From A Rose", artist: { name: "Seal" }, duration: 288 }],
      });
    });
    const match = await lookUpSong({
      title: "Seal - Kiss From A Rose - Remastered study",
      duration: 289,
    });
    expect(searched).toEqual(["Seal Kiss From A Rose - Remastered study", "Seal Kiss From A Rose"]);
    expect(match).toMatchObject({ source: "deezer", song: { title: "Kiss From A Rose" } });
  });

  it("takes another version's genre, and nothing else, when no catalogue has the song", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.startsWith("https://itunes.apple.com/")) {
        return json(
          itunesAnswer({
            ...SINE_SONG,
            trackName: "Breathe (In the Air)",
            artistName: "Pink Floyd",
            primaryGenreName: "Rock",
            trackTimeMillis: 169_000,
          }),
        );
      }
      return json(url.startsWith("https://musicbrainz.org/") ? { recordings: [] } : { data: [] });
    });
    const song = { title: "Pink Floyd - Breathe (In The Air) (Extended)", duration: 319 };
    const genre = await lookUpSongNoted(song, ["genre", "album", "year"]);
    expect(genre.match).toEqual({
      source: "itunes",
      otherVersion: true,
      song: { title: "Breathe (In the Air)", artist: "Pink Floyd", genre: "Rock" },
    });
    // Not when the genre isn't wanted: then no catalogue has it.
    expect((await lookUpSongNoted(song, ["album"])).match).toBe(null);
  });

  it("gives a song MusicBrainz has without a genre its artist's", async () => {
    const asked: string[] = [];
    const artist = "0383dadf-2a4e-4d10-a46a-e9e041da8eb3";
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.startsWith("https://itunes.apple.com/")) return json(itunesAnswer());
      if (!url.startsWith("https://musicbrainz.org/")) return json({ data: [] });
      asked.push(new URL(url).pathname);
      if (url.includes(`/artist/${artist}`)) {
        return json({
          genres: [
            { name: "trance", count: 3 },
            { name: "house", count: 1 },
          ],
        });
      }
      return json({
        recordings: [
          {
            title: "Pulse",
            "artist-credit": [{ name: "Darren Tate", artist: { id: artist } }],
            releases: [{ title: "Pulse", date: "2001" }],
          },
        ],
      });
    });
    const answer = await lookUpSongNoted({ title: "Darren Tate - Pulse" }, ["genre"]);
    expect(answer.match).toMatchObject({
      source: "musicbrainz",
      song: { title: "Pulse", genre: "Trance", genreOf: "artist" },
    });
    expect(answer.match?.song).not.toHaveProperty("artistId");
    expect(asked).toEqual(["/ws/2/recording", `/ws/2/artist/${artist}`]);
    expect(musicBrainzArtistGenre({ tags: [{ name: "psy-trance", count: 1 }] })).toBe("Psy-Trance");
    expect(musicBrainzArtistGenre({})).toBe(undefined);
  });

  it("finds the genre iTunes files an artist under, else MusicBrainz's, passing over a busy one", async () => {
    const asked: string[] = [];
    const artist = "0383dadf-2a4e-4d10-a46a-e9e041da8eb3";
    let itunesBusy = false;
    vi.stubGlobal("fetch", async (url: string) => {
      const { hostname, pathname, searchParams } = new URL(url);
      asked.push(`${hostname}${pathname}`);
      if (hostname === "itunes.apple.com") {
        if (itunesBusy) return new Response("", { status: 403 });
        expect(searchParams.get("entity")).toBe("musicArtist");
        return json({
          results: [
            { wrapperType: "artist", artistName: "Darren Styles", primaryGenreName: "Dance" },
            { wrapperType: "artist", artistName: "Darren Tate", primaryGenreName: "Electronic" },
          ],
        });
      }
      if (pathname === `/ws/2/artist/${artist}`) {
        return json({ genres: [{ name: "trance", count: 4 }] });
      }
      expect(searchParams.get("query")).toBe('artist:"Darren Tate"');
      return json({
        artists: [
          { id: "11111111-2222-3333-4444-555555555555", name: "Darren Styles", score: 100 },
          { id: artist, name: "Darren Tate", score: 100 },
        ],
      });
    });
    expect(await genreOfArtistNamed("Darren Tate")).toEqual({
      genre: "Electronic",
      source: "itunes",
    });
    // Asked again: from memory.
    expect(await genreOfArtistNamed("darren tate")).toEqual({
      genre: "Electronic",
      source: "itunes",
    });
    expect(asked).toEqual(["itunes.apple.com/search"]);

    resetCatalogues();
    asked.length = 0;
    itunesBusy = true;
    expect(await genreOfArtistNamed("Darren Tate")).toEqual({
      genre: "Trance",
      source: "musicbrainz",
    });
    expect(asked).toEqual([
      "itunes.apple.com/search",
      "musicbrainz.org/ws/2/artist",
      `musicbrainz.org/ws/2/artist/${artist}`,
    ]);
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

  it("narrow to what's typed: any case, accents or dashes, names starting with it first", () => {
    const choices = facetChoicesOf("artist", facetCounts(songs, "artist"));
    expect(choices.map((c) => c.text)).toEqual([
      "Band (2)",
      "Singer (1)",
      "Trio (1)",
      "No artist (1)",
    ]);
    const texts = (typed: string) => matchChoices(choices, typed).map((c) => c.text);
    expect(texts("")).toHaveLength(4);
    expect(texts("SIN")).toEqual(["Singer (1)"]);
    expect(texts("no a")).toEqual(["No artist (1)"]);
    expect(texts("zzz")).toEqual([]);
    const genres = [
      { value: "Synth-Pop", text: "Synth-Pop (4)", count: 4 },
      { value: "Hip-Hop/Rap", text: "Hip-Hop/Rap (3)", count: 3 },
      { value: "Pop", text: "Pop (2)", count: 2 },
      { value: "Électronique", text: "Électronique (1)", count: 1 },
    ];
    // "Pop" and the word "Pop" in "Synth-Pop" before "Hip-Hop", which only has it inside a word.
    expect(matchChoices(genres, "pop").map((c) => c.value)).toEqual(["Synth-Pop", "Pop"]);
    expect(matchChoices(genres, "op").map((c) => c.value)).toEqual([
      "Synth-Pop",
      "Hip-Hop/Rap",
      "Pop",
    ]);
    expect(matchChoices(genres, "hiphop").map((c) => c.value)).toEqual(["Hip-Hop/Rap"]);
    expect(matchChoices(genres, "electro").map((c) => c.value)).toEqual(["Électronique"]);
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
  process.env.DETAILS_NOT_FOUND_FILE = path.join(dir, "details-not-found.json");
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
  delete process.env.DETAILS_NOT_FOUND_FILE;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("probeFile", () => {
  it("says what a file really holds, whatever its name, and nothing for a missing one", async () => {
    await tone(path.join(dir, "really-m4a.mp3"), ["-c:a", "aac", "-f", "ipod"]);
    expect(await probeFile(path.join(dir, "really-m4a.mp3"))).toMatchObject({ codec: "aac" });
    expect((await probeFile(path.join(dir, "really-m4a.mp3"))).container).toMatch(/mp4|m4a/);
    expect(await probeFile(path.join(dir, "no-such-song.mp3"))).toEqual({});
  });
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
    // Written over in place: the same file, not a new one in its place.
    expect(after.ino).toBe(before.ino);
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

  it("adds only the genre of another version of the song, and says so", async () => {
    resetCatalogues();
    await tone(path.join(dir, "Bare.mp3"), ["-c:a", "libmp3lame", "-b:a", "128k"]);
    await fs.rename(
      path.join(dir, "Bare.mp3"),
      path.join(dir, "Sine Wave - Test Tone (Extended).mp3"),
    );
    vi.stubGlobal("fetch", async (url: string) =>
      url.startsWith("https://itunes.apple.com/")
        ? json(itunesAnswer({ ...SINE_SONG, trackTimeMillis: 200_000 }))
        : json(url.startsWith("https://musicbrainz.org/") ? { recordings: [] } : { data: [] }),
    );
    const lookup = await lookUpDetails(await scanned("Sine Wave - Test Tone (Extended).mp3"));
    expect(lookup).toMatchObject({
      source: "itunes",
      found: { genre: "Electronic" },
      match: {
        title: "Test Tone",
        artist: "Sine Wave",
        note: "another version of it, for its genre only",
      },
      notFound: false,
    });
    // Not its title, artist, album, year, track or cover: those are the other version's.
    expect(Object.keys(lookup.found!)).toEqual(["genre"]);
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
