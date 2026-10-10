import { afterEach, describe, it, expect, vi } from "vitest";
import {
  PLAYLIST_EMBED_LIMIT,
  SpotifyError,
  cleanTrackTitle,
  parseEmbedPage,
  parsePlaylistPage,
  parseSpotifyLink,
  playlistLinkError,
  readSpotifyLink,
  resolveShortLink,
  spotifyLinkError,
  spotifySearchQuery,
  unusableLinkError,
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

  it("reads playlist and album links, whose songs can be listed", () => {
    expect(parseSpotifyLink("https://open.spotify.com/album/4m2880jivSbbyEGAKfITCa")).toEqual({
      kind: "album",
      id: "4m2880jivSbbyEGAKfITCa",
    });
    expect(parseSpotifyLink("spotify:playlist:37i9dQZF1DXcBWIGoYBM5M")).toEqual({
      kind: "playlist",
      id: "37i9dQZF1DXcBWIGoYBM5M",
    });
    expect(
      parseSpotifyLink("https://open.spotify.com/intl-fr/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc"),
    ).toEqual({ kind: "playlist", id: "37i9dQZF1DXcBWIGoYBM5M" });
  });

  it("recognises other Spotify pages so it can explain they aren't songs", () => {
    expect(parseSpotifyLink("https://open.spotify.com/artist/1dfeR4HaWDbWqFHLkxsg1d")).toEqual({
      kind: "other",
      type: "artist",
    });
    expect(parseSpotifyLink("https://open.spotify.com/playlist/tooShort")).toEqual({
      kind: "other",
      type: "playlist",
    });
    // Another app's short link (spotify.link's service hosts those too).
    expect(parseSpotifyLink("https://someapp.app.link/AbCdEfGh")).toEqual({
      kind: "other",
      type: "short link",
    });
    // A track link with a broken id isn't a song we can look up either.
    expect(parseSpotifyLink("https://open.spotify.com/track/abc")).toMatchObject({
      kind: "other",
    });
  });

  it("reads spotify.link short links, to be opened by resolveShortLink()", () => {
    for (const link of [
      "https://spotify.link/AbCdEfGh",
      "spotify.link/AbCdEfGh/",
      "http://spotify.link/AbCdEfGh?_p=x",
    ]) {
      expect(parseSpotifyLink(link), link).toEqual({
        kind: "short",
        host: "spotify.link",
        code: "AbCdEfGh",
      });
    }
    expect(parseSpotifyLink("https://spotify.app.link/x9Y_z-1?_p=c")).toEqual({
      kind: "short",
      host: "spotify.app.link",
      code: "x9Y_z-1",
    });
    // A code we wouldn't put in an address isn't opened.
    expect(parseSpotifyLink("https://spotify.link/a/b")).toEqual({
      kind: "other",
      type: "short link",
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
    expect(spotifyLinkError({ kind: "other", type: "artist" })).toMatch(/spotify artist/i);
    expect(spotifyLinkError({ kind: "other", type: "show" })).toMatch(/podcast/i);
    expect(spotifyLinkError({ kind: "other", type: "short link" })).toMatch(/open\.spotify\.com/);
  });

  it("points a playlist or album to the playlist panel", () => {
    expect(spotifyLinkError({ kind: "album", id: "4m2880jivSbbyEGAKfITCa" })).toMatch(
      /spotify album.*spotify playlist/i,
    );
  });
});

describe("unusableLinkError", () => {
  it("says which links work", () => {
    expect(unusableLinkError({ kind: "other", type: "artist" })).toMatch(
      /spotify artist.*song, playlist or album/i,
    );
    expect(unusableLinkError({ kind: "other", type: "short link" })).toMatch(/open\.spotify\.com/);
  });
});

describe("playlistLinkError", () => {
  it("explains what to paste instead", () => {
    expect(playlistLinkError({ kind: "track", id: ID })).toMatch(/song, not a playlist/i);
    expect(playlistLinkError({ kind: "other", type: "artist" })).toMatch(
      /spotify artist.*playlist or album link/i,
    );
    expect(playlistLinkError({ kind: "other", type: "short link" })).toMatch(/open\.spotify\.com/);
    expect(playlistLinkError(undefined)).toMatch(/copy link to playlist/i);
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

// The songs as a playlist's embed page lists them (trimmed down).
const item = (
  id: string,
  title: string,
  subtitle: string,
  duration: number,
  isExplicit = false,
) => ({
  uri: `spotify:track:${id}`,
  uid: `uid-${id}`,
  title,
  subtitle,
  isExplicit,
  duration,
  isPlayable: true,
  entityType: "track",
});

const playlistEntity = {
  type: "playlist",
  name: "Road Trip",
  id: "37i9dQZF1DXcBWIGoYBM5M",
  subtitle: "Moomoo",
  visualIdentity: {
    image: [
      { url: "https://image-cdn-fa.spotifycdn.com/image/64", maxHeight: 64, maxWidth: 64 },
      { url: "https://image-cdn-fa.spotifycdn.com/image/640", maxHeight: 640, maxWidth: 640 },
      { url: "https://image-cdn-fa.spotifycdn.com/image/300", maxHeight: 300, maxWidth: 300 },
    ],
  },
  trackList: [
    item(ID, "Bohemian Rhapsody - Remastered 2011", "Queen", 354320),
    // A podcast episode and a local file: no song to find on YouTube.
    { uri: "spotify:episode:4rOoJ6Egrf8K2IrywzwOMk", title: "Episode 12", entityType: "episode" },
    { uri: "spotify:local:::Home+Recording:215", title: "Home Recording" },
    item(
      "2Foc5Q5nqNiosCNqttzHof",
      "Get Lucky",
      "Daft Punk, Pharrell Williams, Nile Rodgers",
      369626,
      true,
    ),
  ],
};

describe("parsePlaylistPage", () => {
  const PLAYLIST = "37i9dQZF1DXcBWIGoYBM5M";

  it("lists the songs with their artists, length and whether they're explicit", () => {
    const html = embedPage({ state: { data: { entity: playlistEntity } } });
    expect(parsePlaylistPage(html, "playlist", PLAYLIST)).toEqual({
      kind: "playlist",
      id: PLAYLIST,
      url: `https://open.spotify.com/playlist/${PLAYLIST}`,
      name: "Road Trip",
      by: "Moomoo",
      image: "https://image-cdn-fa.spotifycdn.com/image/300",
      tracks: [
        {
          id: ID,
          url: `https://open.spotify.com/track/${ID}`,
          title: "Bohemian Rhapsody - Remastered 2011",
          artists: "Queen",
          duration: 354,
          explicit: false,
        },
        {
          id: "2Foc5Q5nqNiosCNqttzHof",
          url: "https://open.spotify.com/track/2Foc5Q5nqNiosCNqttzHof",
          title: "Get Lucky",
          artists: "Daft Punk, Pharrell Williams, Nile Rodgers",
          duration: 370,
          explicit: true,
        },
      ],
      maybeMore: false,
    });
  });

  it("says when a playlist may have more songs than Spotify shares", () => {
    const full = {
      ...playlistEntity,
      trackList: Array.from({ length: PLAYLIST_EMBED_LIMIT }, (_, i) =>
        item(
          `${String(i).padStart(2, "0")}Foc5Q5nqNiosCNqttzHo`.slice(0, 22),
          `Song ${i}`,
          "Band",
          200_000,
        ),
      ),
    };
    const parsed = parsePlaylistPage(
      embedPage({ state: { data: { entity: full } } }),
      "playlist",
      PLAYLIST,
    );
    expect(parsed.tracks).toHaveLength(PLAYLIST_EMBED_LIMIT);
    expect(parsed.maybeMore).toBe(true);
  });

  it("reads albums the same way", () => {
    const album = {
      type: "album",
      name: "Random Access Memories",
      subtitle: "Daft Punk",
      trackList: [item("0dEIca2nhcxDUV8C5QkPYb", "Give Life Back to Music", "Daft Punk", 275386)],
    };
    const parsed = parsePlaylistPage(
      embedPage({ state: { data: { entity: album } } }),
      "album",
      "4m2880jivSbbyEGAKfITCa",
    );
    expect(parsed).toMatchObject({
      kind: "album",
      name: "Random Access Memories",
      by: "Daft Punk",
      image: null,
      maybeMore: false,
      tracks: [{ title: "Give Life Back to Music", duration: 275 }],
    });
  });

  it("explains a private or missing playlist, and a page it can't read", () => {
    const missing = embedPage({ status: 404, title: "Page not found" });
    expect(() => parsePlaylistPage(missing, "playlist", PLAYLIST)).toThrow(/private/);
    try {
      parsePlaylistPage(missing, "playlist", PLAYLIST);
    } catch (err) {
      expect((err as SpotifyError).status).toBe(404);
    }
    // An album page answering for a playlist, or no data at all.
    for (const html of [
      embedPage({ state: { data: { entity: { type: "album", name: "Random Access Memories" } } } }),
      "<html>no data here</html>",
    ]) {
      expect(() => parsePlaylistPage(html, "playlist", PLAYLIST)).toThrow(
        /couldn't read the playlist/i,
      );
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

describe("resolveShortLink", () => {
  const short = { kind: "short", host: "spotify.link", code: "AbCdEfGh" } as const;
  const answer = (status: number, init: { location?: string; body?: string } = {}) =>
    new Response(init.body ?? null, {
      status,
      headers: init.location ? { location: init.location } : {},
    });
  const stubFetch = (...responses: Response[]) => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => {
      const next = responses.shift();
      if (!next) throw new Error("no more answers");
      return next;
    });
    vi.stubGlobal("fetch", fetch);
    return fetch;
  };
  afterEach(() => vi.unstubAllGlobals());

  it("follows the redirect to the song, playlist or album", async () => {
    const fetch = stubFetch(
      answer(307, { location: `https://open.spotify.com/track/${ID}?si=abc&context=x` }),
    );
    await expect(resolveShortLink(short)).resolves.toEqual({ kind: "track", id: ID });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe("https://spotify.link/AbCdEfGh");
    expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
  });

  it("goes through Spotify's other short-link host, and reads a page that redirects by script", async () => {
    const fetch = stubFetch(
      answer(302, { location: "https://spotify.app.link/AbCdEfGh?_p=c11" }),
      answer(200, {
        body: '<html><script>window.location = "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=1"</script></html>',
      }),
    );
    await expect(resolveShortLink(short)).resolves.toEqual({
      kind: "playlist",
      id: "37i9dQZF1DXcBWIGoYBM5M",
    });
    expect(fetch.mock.calls[1][0]).toBe("https://spotify.app.link/AbCdEfGh");
  });

  it("never fetches a redirect to anywhere else", async () => {
    const fetch = stubFetch(answer(302, { location: "https://evil.example/track/x" }));
    await expect(resolveShortLink(short)).rejects.toMatchObject({ status: 502 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("says when the link leads nowhere, or Spotify can't be reached", async () => {
    stubFetch(answer(404));
    await expect(resolveShortLink(short)).rejects.toMatchObject({ status: 404 });
    stubFetch(answer(200, { body: "<html>nothing here</html>" }));
    await expect(resolveShortLink(short)).rejects.toBeInstanceOf(SpotifyError);
    stubFetch(answer(503));
    await expect(resolveShortLink(short)).rejects.toThrow(/HTTP 503/);
    stubFetch();
    await expect(resolveShortLink(short)).rejects.toThrow(/couldn't reach spotify/i);
  });

  it("gives up on a loop of short links", async () => {
    const loop = () => answer(302, { location: "https://spotify.link/AbCdEfGh" });
    const fetch = stubFetch(loop(), loop(), loop(), loop());
    await expect(resolveShortLink(short)).rejects.toThrow(/too many/);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("is what readSpotifyLink() does with a short link, and only with one", async () => {
    stubFetch(answer(307, { location: "https://open.spotify.com/album/4m2880jivSbbyEGAKfITCa" }));
    await expect(readSpotifyLink("https://spotify.link/AbCdEfGh")).resolves.toEqual({
      kind: "album",
      id: "4m2880jivSbbyEGAKfITCa",
    });
    const fetch = stubFetch();
    await expect(readSpotifyLink(`https://open.spotify.com/track/${ID}`)).resolves.toEqual({
      kind: "track",
      id: ID,
    });
    await expect(readSpotifyLink("daft punk")).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
});
