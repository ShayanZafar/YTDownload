import { describe, it, expect } from "vitest";
import {
  SpotifyError,
  cleanTrackTitle,
  parseEmbedPage,
  parseSpotifyLink,
  spotifyLinkError,
  spotifySearchQuery,
} from "../../server/spotify";
import { rankResults, type RawSearchEntry } from "../../server/search";

const ID = "4u7EnebtmKWzUH433cf5Qv"; // Queen – Bohemian Rhapsody (Remastered 2011)

describe("parseSpotifyLink", () => {
  it("reads song links in all their shapes", () => {
    for (const link of [
      `https://open.spotify.com/track/${ID}`,
      `https://open.spotify.com/track/${ID}?si=9f0c1d2e3a4b5c6d`,
      `https://open.spotify.com/intl-de/track/${ID}`,
      `https://open.spotify.com/embed/track/${ID}?utm_source=oembed`,
      `open.spotify.com/track/${ID}`,
      `  spotify:track:${ID} `,
    ]) {
      expect(parseSpotifyLink(link), link).toEqual({ kind: "track", id: ID });
    }
  });

  it("recognises other Spotify pages so it can explain they aren't songs", () => {
    expect(parseSpotifyLink("https://open.spotify.com/album/4m2880jivSbbyEGAKfITCa")).toEqual({
      kind: "other",
      type: "album",
    });
    expect(parseSpotifyLink("spotify:playlist:37i9dQZF1DXcBWIGoYBM5M")).toEqual({
      kind: "other",
      type: "playlist",
    });
    expect(parseSpotifyLink("https://spotify.link/AbCdEfGh")).toEqual({
      kind: "other",
      type: "short link",
    });
    // A track link with a broken id isn't a song we can look up either.
    expect(parseSpotifyLink("https://open.spotify.com/track/abc")).toMatchObject({
      kind: "other",
    });
  });

  it("ignores everything that isn't a Spotify link", () => {
    for (const text of [
      "spotify wrapped top song",
      "https://www.youtube.com/watch?v=jNQXAC9IVRw",
      "https://example.com/track/4u7EnebtmKWzUH433cf5Qv",
      "https://open.spotify.com.evil.example/track/4u7EnebtmKWzUH433cf5Qv",
      "queen bohemian rhapsody",
    ]) {
      expect(parseSpotifyLink(text), text).toBeUndefined();
    }
  });
});

describe("spotifyLinkError", () => {
  it("says what kind of link it was", () => {
    expect(spotifyLinkError({ kind: "other", type: "album" })).toMatch(/spotify album/i);
    expect(spotifyLinkError({ kind: "other", type: "show" })).toMatch(/podcast/i);
    expect(spotifyLinkError({ kind: "other", type: "short link" })).toMatch(/open\.spotify\.com/);
  });
});

// A trimmed-down Spotify embed page: the real one has the same shape plus
// player settings we don't read.
const embedPage = (pageProps: unknown) =>
  `<!DOCTYPE html><html><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
    { props: { pageProps }, page: "/track/[id]" },
  )}</script></body></html>`;

const trackEntity = {
  type: "track",
  name: "Bohemian Rhapsody - Remastered 2011",
  id: ID,
  artists: [{ name: "Queen", uri: "spotify:artist:1dfeR4HaWDbWqFHLkxsg1d" }],
  duration: 354320,
  visualIdentity: {
    image: [
      { url: "https://image-cdn-ak.spotifycdn.com/image/300", maxHeight: 300, maxWidth: 300 },
      { url: "https://image-cdn-ak.spotifycdn.com/image/64", maxHeight: 64, maxWidth: 64 },
      { url: "https://image-cdn-ak.spotifycdn.com/image/640", maxHeight: 640, maxWidth: 640 },
    ],
  },
};

describe("parseEmbedPage", () => {
  it("reads the song's title, artists, length and cover", () => {
    const html = embedPage({ state: { data: { entity: trackEntity } } });
    expect(parseEmbedPage(html, ID)).toEqual({
      id: ID,
      url: `https://open.spotify.com/track/${ID}`,
      title: "Bohemian Rhapsody - Remastered 2011",
      artists: ["Queen"],
      duration: 354,
      thumbnail: "https://image-cdn-ak.spotifycdn.com/image/640",
    });
  });

  it("copes with missing artists, length and cover", () => {
    const html = embedPage({ state: { data: { entity: { type: "track", name: "Song" } } } });
    expect(parseEmbedPage(html, ID)).toMatchObject({
      artists: [],
      duration: null,
      thumbnail: null,
    });
  });

  it("reports a song that doesn't exist as 404", () => {
    const html = embedPage({ status: 404, title: "Page not found" });
    expect(() => parseEmbedPage(html, ID)).toThrow(SpotifyError);
    try {
      parseEmbedPage(html, ID);
    } catch (err) {
      expect((err as SpotifyError).status).toBe(404);
    }
  });

  it("fails clearly if Spotify changes its page", () => {
    for (const html of [
      "<html>no data here</html>",
      '<script id="__NEXT_DATA__" type="application/json">{broken</script>',
      embedPage({ state: { data: { entity: { type: "album", name: "Random Access Memories" } } } }),
    ]) {
      expect(() => parseEmbedPage(html, ID)).toThrow(/spotify/i);
    }
  });
});

describe("cleanTrackTitle", () => {
  it("drops release notes and featured artists", () => {
    expect(cleanTrackTitle("Bohemian Rhapsody - Remastered 2011")).toBe("Bohemian Rhapsody");
    expect(cleanTrackTitle("Here Comes The Sun - 2019 Mix")).toBe("Here Comes The Sun - 2019 Mix");
    expect(cleanTrackTitle("Get Lucky (feat. Pharrell Williams and Nile Rodgers)")).toBe(
      "Get Lucky",
    );
    expect(cleanTrackTitle("Get Lucky (feat. Pharrell Williams) - Radio Edit")).toBe("Get Lucky");
    expect(cleanTrackTitle("Stay (with Justin Bieber)")).toBe("Stay");
    expect(cleanTrackTitle("Heroes - 2017 Remaster")).toBe("Heroes");
    expect(cleanTrackTitle("Yesterday - Remastered 2009")).toBe("Yesterday");
  });

  it("keeps notes that mean a different recording", () => {
    expect(cleanTrackTitle("Creep - Acoustic")).toBe("Creep - Acoustic");
    expect(cleanTrackTitle("Hotel California - Live")).toBe("Hotel California - Live");
  });
});

describe("spotifySearchQuery", () => {
  it("searches for the main artist and the song", () => {
    expect(
      spotifySearchQuery({
        title: "Get Lucky (feat. Pharrell Williams and Nile Rodgers)",
        artists: ["Daft Punk", "Pharrell Williams", "Nile Rodgers"],
      }),
    ).toBe("Daft Punk Get Lucky audio");
    expect(spotifySearchQuery({ title: "Song", artists: [] })).toBe("Song audio");
  });
});

describe("rankResults with a known length (from Spotify)", () => {
  const entry = (id: string, fields: Partial<RawSearchEntry>): RawSearchEntry => ({
    id,
    channel_is_verified: false,
    ...fields,
  });
  // "Daft Punk Get Lucky" on YouTube: the official upload is the 4-minute radio
  // edit, but the Spotify link was the 6:09 album version.
  const entries = [
    entry("5NV6Rdv1a3I", {
      title: "Daft Punk - Get Lucky (Official Audio) ft. Pharrell Williams, Nile Rodgers",
      channel: "Daft Punk",
      channel_is_verified: true,
      duration: 249,
    }),
    entry("5glDAaCaazc", {
      title: "Daft Punk - Get Lucky (Lyrics)",
      channel: "7clouds",
      duration: 246,
    }),
    entry("DvE7O3bLQgE", {
      title: "Daft Punk - Get Lucky (Feat. Pharrell Williams)",
      channel: "EXPO STORY",
      duration: 369,
    }),
    entry("hhhhhhhhhh1", { title: "Get Lucky", channel: "Daft Punk - Topic", duration: 370 }),
    entry("hhhhhhhhhh2", { title: "Some other 6 minute video", channel: "X", duration: 369 }),
  ];

  it("puts uploads of the same length first, official ones before others", () => {
    const ids = rankResults("Daft Punk Get Lucky", entries, { targetDuration: 370 }).map(
      (r) => r.id,
    );
    expect(ids.slice(0, 3)).toEqual(["hhhhhhhhhh1", "DvE7O3bLQgE", "5NV6Rdv1a3I"]);
    // Matching the length alone isn't enough — it has to be the song.
    expect(ids.at(-1)).toBe("hhhhhhhhhh2");
  });

  it("ranks as usual when the length is unknown", () => {
    const ids = rankResults("Daft Punk Get Lucky", entries, { targetDuration: null }).map(
      (r) => r.id,
    );
    expect(ids.slice(0, 2)).toEqual(["5NV6Rdv1a3I", "hhhhhhhhhh1"]);
  });
});
