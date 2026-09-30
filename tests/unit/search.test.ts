import { describe, it, expect } from "vitest";
import {
  MAX_RESULTS,
  isOfficial,
  normalize,
  queryCoverage,
  rankResults,
  ytDlpSearchArgs,
  type RawSearchEntry,
} from "../../server/search";

// Shaped like real `ytsearch` results for "daft punk get lucky" (ids made up).
const entry = (id: string, fields: Partial<RawSearchEntry>): RawSearchEntry => ({
  id,
  duration: 248,
  channel_is_verified: false,
  live_status: null,
  ...fields,
});

describe("normalize", () => {
  it("lowercases and drops accents and punctuation", () => {
    expect(normalize("Beyoncé - Halo!")).toBe("beyonce halo");
    expect(normalize("  AC/DC — Back In Black (Official Video) ")).toBe(
      "ac dc back in black official video",
    );
  });
});

describe("isOfficial", () => {
  it("accepts YouTube's auto-generated Topic channels and VEVO", () => {
    expect(isOfficial({ title: "Get Lucky", channel: "Daft Punk - Topic" })).toBe(true);
    expect(isOfficial({ title: "Halo", channel: "BeyonceVEVO" })).toBe(true);
  });

  it("accepts the artist's own verified channel", () => {
    expect(
      isOfficial({
        title: "Daft Punk - Get Lucky (Official Audio) ft. Pharrell Williams, Nile Rodgers",
        channel: "Daft Punk",
        channel_is_verified: true,
      }),
    ).toBe(true);
    // "Official" / "Music" in the channel name don't have to be in the title.
    expect(
      isOfficial({
        title: "Adele - Hello (Official Music Video)",
        channel: "Adele Official",
        channel_is_verified: true,
      }),
    ).toBe(true);
  });

  it("rejects verified channels posting someone else's song", () => {
    expect(
      isOfficial({
        title: "Daft Punk - Get Lucky (Lyrics) ft. Pharrell Williams",
        channel: "7clouds",
        channel_is_verified: true,
      }),
    ).toBe(false);
  });

  it("rejects verified TV and media channels that put their name elsewhere in the title", () => {
    expect(
      isOfficial(
        {
          title: "Anna McLuckie performs 'Get Lucky' by Daft Punk | The Voice UK - BBC",
          channel: "BBC",
          channel_is_verified: true,
        },
        "get lucky",
      ),
    ).toBe(false);
  });

  it("accepts a verified channel named in the search", () => {
    const upload = {
      title: "Bohemian Rhapsody",
      channel: "Queen Official",
      channel_is_verified: true,
    };
    expect(isOfficial(upload, "queen bohemian rhapsody")).toBe(true);
    expect(isOfficial(upload, "bohemian rhapsody")).toBe(false);
  });

  it("rejects unverified channels, even with the artist's name", () => {
    expect(isOfficial({ title: "Daft Punk - Get Lucky", channel: "Daft Punk" })).toBe(false);
  });

  it("falls back to the uploader when there's no channel name", () => {
    expect(isOfficial({ title: "Get Lucky", uploader: "Daft Punk - Topic" })).toBe(true);
    expect(isOfficial({ title: "Get Lucky" })).toBe(false);
  });
});

describe("rankResults", () => {
  const entries: RawSearchEntry[] = [
    entry("aaaaaaaaaa1", {
      title: "Daft Punk - Get Lucky (Lyrics) ft. Pharrell Williams",
      channel: "7clouds",
      channel_is_verified: true,
    }),
    entry("aaaaaaaaaa2", {
      title: "Daft Punk - Get Lucky (Live at the Grammys)",
      channel: "Daft Punk",
      channel_is_verified: true,
    }),
    entry("aaaaaaaaaa3", {
      title: "Daft Punk - Get Lucky (Official Audio) ft. Pharrell Williams, Nile Rodgers",
      channel: "Daft Punk",
      channel_is_verified: true,
      duration: 369.4,
    }),
    entry("aaaaaaaaaa4", { title: "Get Lucky (cover)", channel: "Some Band" }),
    entry("aaaaaaaaaa5", { title: "Get Lucky", channel: "Daft Punk - Topic" }),
  ];

  it("puts official uploads first and keeps YouTube's order otherwise", () => {
    const ids = rankResults("daft punk get lucky", entries).map((r) => r.id);
    expect(ids).toEqual([
      "aaaaaaaaaa3",
      "aaaaaaaaaa5",
      "aaaaaaaaaa1",
      "aaaaaaaaaa2",
      "aaaaaaaaaa4",
    ]);
  });

  it("moves live/cover versions down, even from the artist's channel", () => {
    const ids = rankResults("daft punk get lucky", entries).map((r) => r.id);
    expect(ids.indexOf("aaaaaaaaaa2")).toBeGreaterThan(ids.indexOf("aaaaaaaaaa1"));
  });

  it("doesn't demote a version the search asks for", () => {
    const ids = rankResults("daft punk get lucky live", entries).map((r) => r.id);
    expect(ids[0]).toBe("aaaaaaaaaa2");
  });

  it("doesn't move up an official upload of a different song", () => {
    const ids = rankResults("me at the zoo", [
      entry("ffffffffff1", { title: "Me at the zoo", channel: "jawed" }),
      entry("ffffffffff2", { title: "Zoo", channel: "Some Band - Topic" }),
    ]).map((r) => r.id);
    expect(ids).toEqual(["ffffffffff1", "ffffffffff2"]);
  });

  it("treats performances and concerts as live versions", () => {
    const entries = [
      entry("gggggggggg1", { title: "Blinding Lights (Time100 Live Performance)", channel: "A" }),
      entry("gggggggggg2", { title: "Blinding Lights", channel: "The Weeknd - Topic" }),
    ];
    expect(rankResults("blinding lights", entries).map((r) => r.id)).toEqual([
      "gggggggggg2",
      "gggggggggg1",
    ]);
    // Asking for "live" keeps performances where YouTube put them.
    expect(rankResults("blinding lights live", entries)[0].id).toBe("gggggggggg1");
  });

  it("only matches whole words ('live' isn't in 'alive' or 'oliver')", () => {
    const [first] = rankResults("x", [
      entry("bbbbbbbbbb1", { title: "Pearl Jam - Alive", channel: "PearlJamVEVO" }),
    ]);
    expect(first.official).toBe(true);
    const ids = rankResults("x", [
      entry("bbbbbbbbbb2", { title: "Song (Live)", channel: "A" }),
      entry("bbbbbbbbbb3", { title: "Oliver Tree - Life Goes On", channel: "B" }),
    ]).map((r) => r.id);
    expect(ids).toEqual(["bbbbbbbbbb3", "bbbbbbbbbb2"]);
  });

  it("builds the watch URL, thumbnail and rounded duration", () => {
    const result = rankResults("daft punk get lucky", entries).find((r) => r.id === "aaaaaaaaaa3");
    expect(result).toEqual({
      id: "aaaaaaaaaa3",
      url: "https://www.youtube.com/watch?v=aaaaaaaaaa3",
      title: "Daft Punk - Get Lucky (Official Audio) ft. Pharrell Williams, Nile Rodgers",
      channel: "Daft Punk",
      duration: 369,
      thumbnail: "https://i.ytimg.com/vi/aaaaaaaaaa3/hqdefault.jpg",
      official: true,
    });
  });

  it("skips live streams, bad ids and duplicates", () => {
    const results = rankResults("x", [
      entry("cccccccccc1", { title: "24/7 radio", live_status: "is_live" }),
      entry("cccccccccc2", { title: "Premiere", live_status: "is_upcoming" }),
      entry("UCxxxxxxxxxxxxxxxxxxxxxx", { title: "A channel, not a video" }),
      entry("", { title: "No id" }),
      entry("cccccccccc3", { title: "Past stream", live_status: "was_live" }),
      entry("cccccccccc3", { title: "Past stream again" }),
    ]);
    expect(results.map((r) => r.id)).toEqual(["cccccccccc3"]);
  });

  it("copes with missing fields", () => {
    const [result] = rankResults("x", [{ id: "dddddddddd1" }]);
    expect(result).toMatchObject({
      title: "Untitled",
      channel: "",
      duration: null,
      official: false,
    });
  });

  it(`returns at most ${MAX_RESULTS} results`, () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      entry(`eeeeeeeee${String(i).padStart(2, "0")}`, { title: `Song ${i}`, channel: "A" }),
    );
    expect(rankResults("song", many)).toHaveLength(MAX_RESULTS);
    expect(rankResults("song", many, 3)).toHaveLength(3);
  });
});

describe("queryCoverage", () => {
  it("counts search words found in the title or channel, ignoring filler words", () => {
    const topic = { title: "Get Lucky", channel: "Daft Punk - Topic" };
    expect(queryCoverage("daft punk get lucky", topic)).toBe(1);
    expect(queryCoverage("Daft Punk – Get Lucky (Official Audio)", topic)).toBe(1);
    expect(
      queryCoverage("progression ocean green", { title: "Ocean Green", channel: "X - Topic" }),
    ).toBeCloseTo(2 / 3);
  });

  it("is 1 when there's nothing to compare", () => {
    expect(queryCoverage("official lyrics", { title: "Anything" })).toBe(1);
    expect(queryCoverage("紅蓮華", { title: "LiSA - 紅蓮華" })).toBe(1);
  });
});

// Shaped like real search results seen on YouTube (Sept 2026).
describe("rankResults with real-world results", () => {
  it("puts the searched-for artist above other artists' songs with the same name", () => {
    const ids = rankResults("progression ocean green", [
      entry("7pZWCfUSKeg", { title: "Ocean Green", channel: "Oracle and the Mountain - Topic" }),
      entry("UlGbWp9KCck", { title: "Green Ocean (Original Mix)", channel: "Release - Topic" }),
      entry("ZW9IMtSVLek", { title: "Progression - Ocean Green", channel: "persezyra" }),
      entry("9DII4peQE7I", {
        title: "Progression - Ocean Green (2004)",
        channel: "Trance Classics",
      }),
    ]).map((r) => r.id);
    expect(ids).toEqual(["ZW9IMtSVLek", "9DII4peQE7I", "7pZWCfUSKeg", "UlGbWp9KCck"]);
  });

  it("recognises the artist's channel from the search, and skips flashmobs", () => {
    const results = rankResults("queen bohemian rhapsody", [
      entry("fJ9rUzIMcZQ", {
        title: "Queen - Bohemian Rhapsody (Official Video Remastered)",
        channel: "Queen Official",
        channel_is_verified: true,
      }),
      entry("Guqb5AzSb_U", {
        title: "Gaveta Produções | The Most INSANE Bohemian Rhapsody Flashmob you will Ever See",
        channel: "Gaveta Produções",
        channel_is_verified: true,
      }),
      entry("5zLnaNY58j8", {
        title: "Queen - Bohemian Rhapsody (Lyrics)",
        channel: "7clouds Rock",
      }),
      entry("XHrdsx8izBs", {
        title: "Bohemian Rhapsody",
        channel: "Queen Official",
        channel_is_verified: true,
      }),
    ]);
    expect(results.map((r) => r.id)).toEqual([
      "fJ9rUzIMcZQ",
      "XHrdsx8izBs",
      "5zLnaNY58j8",
      "Guqb5AzSb_U",
    ]);
    expect(results.find((r) => r.id === "XHrdsx8izBs")?.official).toBe(true);
  });
});

describe("ytDlpSearchArgs", () => {
  it("lists search results without opening each video", () => {
    const args = ytDlpSearchArgs("daft punk get lucky");
    expect(args).toContain("--flat-playlist");
    expect(args).toContain("--dump-single-json");
    expect(args.at(-1)).toMatch(/^ytsearch\d+:daft punk get lucky$/);
  });

  it("ends the options before the query, so it can't be read as a flag", () => {
    const args = ytDlpSearchArgs("--exec calc");
    expect(args.at(-2)).toBe("--");
    expect(args.at(-1)).toMatch(/^ytsearch\d+:--exec calc$/);
  });
});
