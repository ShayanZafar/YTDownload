import { afterAll, afterEach, beforeAll, describe, it, expect, vi } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import {
  PLAYLIST_EMBED_LIMIT,
  PLAYLIST_MAX_SONGS,
  RETRY_FAILED_AFTER_MS,
  SpotifyError,
  cleanTrackTitle,
  fetchMyPlaylists,
  fetchOembedTrack,
  fetchSpotifyPlaylist,
  fetchSpotifyTrack,
  spotifyTrackCache,
  parseEmbedPage,
  parseOembed,
  parsePlaylistItemsPage,
  parseRetryAfter,
  parsePlaylistPage,
  readEmbedAccessToken,
  parseSpotifyLink,
  playlistLinkError,
  readSpotifyLink,
  resolveShortLink,
  spotifyLinkError,
  spotifySearchQuery,
  unusableLinkError,
  webApiRefusal,
} from "../../server/spotify";
import { rankResults, type RawSearchEntry } from "../../server/search";
import { sourceHealth } from "../../server/source-health";
import { cpuCores } from "../../server/cpu-cores";

const ID = "4u7EnebtmKWzUH433cf5Qv"; // Queen – Bohemian Rhapsody (Remastered 2011)

// Every request to Spotify is recorded for the source-health report, which
// is written to a file: a throwaway one here, never the app's own.
let healthDir: string;
beforeAll(async () => {
  healthDir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-spotify-"));
  process.env.SOURCE_HEALTH_FILE = path.join(healthDir, "source-health.json");
});
afterAll(async () => {
  await sourceHealth.flush().catch(() => {});
  delete process.env.SOURCE_HEALTH_FILE;
  await fs.rm(healthDir, { recursive: true, force: true });
});

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
      source: "spotify",
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

// Songs as Spotify's Web API lists them (trimmed to the fields the app asks for).
const apiItem = (n: number) => ({
  is_local: false,
  track: {
    type: "track",
    id: `${String(n).padStart(4, "0")}Foc5Q5nqNiosCNqttz`.slice(0, 22),
    name: `Song ${n}`,
    duration_ms: 200_400,
    explicit: n % 2 === 0,
    artists: [{ name: "Band" }, { name: "Guest" }],
  },
});
const TOKEN = "BQBwyEGz2FQskAhrmhWc1nzSmTZ_RCV8pdaLd2QDbuW";

describe("readEmbedAccessToken", () => {
  it("reads the embed page's anonymous pass", () => {
    const html = embedPage({
      state: { settings: { session: { accessToken: TOKEN, isAnonymous: true } } },
    });
    expect(readEmbedAccessToken(html)).toBe(TOKEN);
  });

  it("gives undefined without one, or for anything that isn't a plain token", () => {
    for (const accessToken of [
      undefined,
      "",
      42,
      "a b c d e f g h i j k l m n",
      "x".repeat(2000),
    ]) {
      const html = embedPage({ state: { settings: { session: { accessToken } } } });
      expect(readEmbedAccessToken(html)).toBeUndefined();
    }
    expect(readEmbedAccessToken("<html>no data here</html>")).toBeUndefined();
  });
});

describe("parsePlaylistItemsPage", () => {
  it("reads the songs, how many entries the page had and the playlist's total", () => {
    const page = parsePlaylistItemsPage({
      total: 230,
      items: [
        apiItem(100),
        // An episode, a local file and a song Spotify removed: no song to find.
        { is_local: false, track: { type: "episode", id: "4rOoJ6Egrf8K2IrywzwOMk", name: "Ep" } },
        { is_local: true, track: { type: "track", id: null, name: "Home Recording" } },
        { is_local: false, track: null },
        apiItem(101),
      ],
    });
    expect(page.count).toBe(5);
    expect(page.total).toBe(230);
    expect(page.tracks).toEqual([
      {
        id: "0100Foc5Q5nqNiosCNqttz",
        url: "https://open.spotify.com/track/0100Foc5Q5nqNiosCNqttz",
        title: "Song 100",
        artists: "Band, Guest",
        duration: 200,
        explicit: true,
      },
      expect.objectContaining({ title: "Song 101", explicit: false }),
    ]);
  });

  it("reads the song under `item`, as `/items` answers since Spotify's Feb 2026 changes", () => {
    const page = parsePlaylistItemsPage({
      total: 1,
      items: [{ is_local: false, item: apiItem(7).track }],
    });
    expect(page.tracks.map((t) => t.title)).toEqual(["Song 7"]);
  });

  it("copes with an answer it can't read", () => {
    for (const json of [null, "text", { items: "nope" }, { total: -1, items: [] }]) {
      expect(parsePlaylistItemsPage(json)).toEqual({ tracks: [], count: 0, total: 0 });
    }
  });
});

describe("fetchSpotifyPlaylist", () => {
  const PLAYLIST = "1aBcDeFgHiJkLmNoPqRsTu";
  const firstHundred = Array.from({ length: PLAYLIST_EMBED_LIMIT }, (_, n) => {
    const track = apiItem(n).track;
    return item(track.id, track.name, "Band", 200_000);
  });
  const page = (entity: object, accessToken = TOKEN) =>
    new Response(
      embedPage({
        state: { data: { entity }, settings: { session: { accessToken, isAnonymous: true } } },
      }),
    );
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const apiPage = (from: number, to: number, total: number) =>
    json({ total, items: Array.from({ length: to - from }, (_, i) => apiItem(from + i)) });
  const stubFetch = (...responses: Response[]) => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => {
      const next = responses.shift();
      if (!next) throw new Error("no more answers");
      return next;
    });
    vi.stubGlobal("fetch", fetch);
    return fetch;
  };
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    webApiRefusal.clear();
  });
  const full = { ...playlistEntity, trackList: firstHundred };
  /** Spotify's "too many requests", with the Retry-After it gave (or none). */
  const tooMany = (retryAfter?: string) =>
    new Response(JSON.stringify({ error: { status: 429, message: "API rate limit exceeded" } }), {
      status: 429,
      headers: retryAfter === undefined ? {} : { "retry-after": retryAfter },
    });
  const webApiCalls = (fetch: ReturnType<typeof stubFetch>) =>
    fetch.mock.calls.filter(([url]) => url.startsWith("https://api.spotify.com/")).length;
  const webApiHealth = () => sourceHealth.report().sources["spotify-web-api"];

  it("pages through the rest of a long playlist with the embed page's pass", async () => {
    const fetch = stubFetch(page(full), apiPage(100, 200, 230), apiPage(200, 230, 230));
    const playlist = await fetchSpotifyPlaylist("playlist", PLAYLIST);
    expect(playlist.tracks).toHaveLength(230);
    expect(playlist.tracks.map((t) => t.title).slice(98, 102)).toEqual([
      "Song 98",
      "Song 99",
      "Song 100",
      "Song 101",
    ]);
    expect(playlist.maybeMore).toBe(false);
    expect(playlist.more).toBeUndefined();

    expect(fetch.mock.calls[0][0]).toBe(`https://open.spotify.com/embed/playlist/${PLAYLIST}`);
    expect(fetch.mock.calls[0][1]?.headers).not.toHaveProperty("Authorization");
    for (const [n, offset] of [
      [1, 100],
      [2, 200],
    ]) {
      const url = new URL(fetch.mock.calls[n][0]);
      expect(url.origin + url.pathname).toBe(
        `https://api.spotify.com/v1/playlists/${PLAYLIST}/tracks`,
      );
      expect(url.searchParams.get("offset")).toBe(String(offset));
      expect(url.searchParams.get("limit")).toBe("100");
      expect(fetch.mock.calls[n][1]?.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
    }
  });

  it("asks nothing more of a short playlist, an album, or a page with no pass", async () => {
    const short = stubFetch(page(playlistEntity));
    expect((await fetchSpotifyPlaylist("playlist", PLAYLIST)).maybeMore).toBe(false);
    expect(short).toHaveBeenCalledTimes(1);

    const album = stubFetch(page({ ...full, type: "album" }));
    expect((await fetchSpotifyPlaylist("album", PLAYLIST)).tracks).toHaveLength(100);
    expect(album).toHaveBeenCalledTimes(1);

    // No pass: there may be more, but the app can't say why it stopped.
    const noPass = stubFetch(page(full, ""));
    const withoutPass = await fetchSpotifyPlaylist("playlist", PLAYLIST);
    expect(withoutPass.maybeMore).toBe(true);
    expect(withoutPass.more).toBeUndefined();
    expect(noPass).toHaveBeenCalledTimes(1);
  });

  it("knows a playlist of exactly 100 songs is complete", async () => {
    stubFetch(page(full), json({ total: 100, items: [] }));
    const playlist = await fetchSpotifyPlaylist("playlist", PLAYLIST);
    expect(playlist.tracks).toHaveLength(100);
    expect(playlist.maybeMore).toBe(false);
    expect(playlist.more).toBeUndefined();
  });

  it("keeps the first 100 when Spotify won't share the rest (its own playlists)", async () => {
    stubFetch(page(full), json({ error: { status: 404, message: "Resource not found" } }, 404));
    const playlist = await fetchSpotifyPlaylist("playlist", PLAYLIST);
    expect(playlist.tracks).toHaveLength(100);
    expect(playlist.maybeMore).toBe(true);
    expect(playlist.more).toEqual({ reason: "spotify-own" });
  });

  it("keeps what came before a page that fails, and says to try again in a minute", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const inAMinute = new Date(Date.now() + RETRY_FAILED_AFTER_MS).toISOString();
    stubFetch(page(full), apiPage(100, 200, 400), json({}, 500));
    const failedLater = await fetchSpotifyPlaylist("playlist", PLAYLIST);
    expect(failedLater.tracks).toHaveLength(200);
    expect(failedLater.maybeMore).toBe(true);
    expect(failedLater.more).toEqual({ reason: "failed", note: "HTTP 500", retryAt: inAMinute });

    stubFetch(page(full), new Response("not json"));
    const unreadable = await fetchSpotifyPlaylist("playlist", PLAYLIST);
    expect(unreadable.tracks).toHaveLength(100);
    expect(unreadable.more).toMatchObject({ reason: "failed", retryAt: inAMinute });
  });

  it("says when a playlist's rest failed: an error, no answer, or a 429 without Retry-After", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const inAMinute = new Date(Date.now() + RETRY_FAILED_AFTER_MS).toISOString();
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), {
      name: "TimeoutError",
    });
    const cases: [answer: Response | Error, note: string][] = [
      [new Response("busy", { status: 503 }), "HTTP 503"],
      [new Response("no", { status: 401 }), "HTTP 401"],
      [timeout, "it took too long"],
      [new TypeError("fetch failed"), "no connection"],
      [tooMany(), "HTTP 429"],
      [tooMany("0"), "HTTP 429"], // nothing to wait for
      [tooMany("soon"), "HTTP 429"], // unreadable
      [tooMany("99999999999999"), "HTTP 429"], // later than any date can be
    ];
    for (const [answer, note] of cases) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (url.startsWith("https://open.spotify.com/")) return page(full);
          if (answer instanceof Error) throw answer;
          return answer;
        }),
      );
      const playlist = await fetchSpotifyPlaylist("playlist", PLAYLIST);
      expect(playlist.tracks, note).toHaveLength(100);
      expect(playlist.more, note).toEqual({ reason: "failed", note, retryAt: inAMinute });
    }
    // None of them is a refusal to remember: the next open asks again.
    expect(webApiRefusal.until).toBe(0);
    expect(() => sourceHealth.report()).not.toThrow();
  });

  it("gives the first 100 and when to ask again when Spotify refuses the rest (429)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const before = webApiHealth();
    const until = Date.now() + 54_901_000;
    stubFetch(page(full), tooMany("54901"));
    const playlist = await fetchSpotifyPlaylist("playlist", PLAYLIST);
    expect(playlist.tracks).toHaveLength(100);
    expect(playlist.maybeMore).toBe(true);
    expect(playlist.more).toEqual({ reason: "refused", retryAt: new Date(until).toISOString() });

    // Recorded as the Web API's, with until when it refuses; the embed page's stays Spotify's.
    expect(webApiHealth()).toMatchObject({
      failed: before.failed + 1,
      throttled: before.throttled + 1,
      lastError: "HTTP 429",
    });
    expect(Date.parse(webApiHealth().refusedUntil!)).toBe(until);
  });

  it("reads Retry-After as an HTTP date too", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const at = new Date(Math.ceil(Date.now() / 1000) * 1000 + 3 * 60 * 60_000);
    stubFetch(page(full), tooMany(at.toUTCString()));
    const playlist = await fetchSpotifyPlaylist("playlist", PLAYLIST);
    expect(playlist.more).toEqual({ reason: "refused", retryAt: at.toISOString() });
  });

  it("asks the Web API nothing while it refuses, then again once the time has come", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const refusedAt = Date.now();
    const retryAt = new Date(refusedAt + 54_901_000).toISOString();
    stubFetch(page(full), tooMany("54901"));
    await fetchSpotifyPlaylist("playlist", PLAYLIST);

    // Any playlist, any pass: the refusal is the whole route's, not one playlist's.
    vi.setSystemTime(refusedAt + 60 * 60_000);
    const other = stubFetch(page({ ...full, name: "Another" }, "AnotherAnonymousPass_123"));
    const meanwhile = await fetchSpotifyPlaylist("playlist", "9zYxWvUtSrQpOnMlKjIhGf");
    expect(meanwhile.tracks).toHaveLength(100);
    expect(meanwhile.more).toEqual({ reason: "refused", retryAt });
    expect(other).toHaveBeenCalledTimes(1); // the embed page only
    expect(webApiCalls(other)).toBe(0);

    vi.setSystemTime(Date.parse(retryAt) + 1000);
    const after = stubFetch(page(full), apiPage(100, 200, 250), apiPage(200, 250, 250));
    const whole = await fetchSpotifyPlaylist("playlist", PLAYLIST);
    expect(webApiCalls(after)).toBe(2);
    expect(whole.tracks).toHaveLength(250);
    expect(whole.maybeMore).toBe(false);
    expect(whole.more).toBeUndefined();
  });

  it("keeps the songs that came before a refused page", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const retryAt = new Date(Date.now() + 600_000).toISOString();
    stubFetch(page(full), apiPage(100, 200, 400), apiPage(200, 300, 400), tooMany("600"));
    const playlist = await fetchSpotifyPlaylist("playlist", PLAYLIST);
    expect(playlist.tracks).toHaveLength(300);
    expect(playlist.more).toEqual({ reason: "refused", retryAt });
  });

  it("says Spotify refused, and until when, though a page before the refused one failed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const retryAt = new Date(Date.now() + 600_000).toISOString();
    stubFetch(page(full), apiPage(100, 200, 400), json({}, 503), tooMany("600"));
    const playlist = await fetchSpotifyPlaylist("playlist", PLAYLIST);
    expect(playlist.tracks).toHaveLength(200);
    expect(playlist.more).toEqual({ reason: "refused", retryAt });
  });

  it("asks for the remaining pages together once the first says how many there are", async () => {
    // The answer for each request, once the test says (by offset; the embed page at once).
    const answers = new Map<string, (res: Response) => void>();
    const fetch = vi.fn((url: string) =>
      url.startsWith("https://open.spotify.com/")
        ? Promise.resolve(page(full))
        : new Promise<Response>((resolve) =>
            answers.set(new URL(url).searchParams.get("offset")!, resolve),
          ),
    );
    vi.stubGlobal("fetch", fetch);
    const answered = new Set<string>();
    const waiting = () => [...answers.keys()].filter((offset) => !answered.has(offset));
    const answer = (offset: string) => {
      answered.add(offset);
      const from = Number(offset);
      answers.get(offset)!(apiPage(from, Math.min(from + 100, 450), 450));
    };

    const playlist = fetchSpotifyPlaylist("playlist", PLAYLIST);
    await vi.waitFor(() => expect(waiting()).toEqual(["100"]));
    answer("100");
    // Pages 200, 300 and 400 go out together: as many at once as this computer has cores.
    await vi.waitFor(() =>
      expect(waiting()).toEqual(["200", "300", "400"].slice(0, Math.min(cpuCores(), 3))),
    );
    // Answered last page first, the songs still come in the playlist's order.
    while (answered.size < 4) {
      await vi.waitFor(() => expect(waiting().length).toBeGreaterThan(0));
      answer(waiting().sort((a, b) => Number(b) - Number(a))[0]);
    }
    const done = await playlist;
    expect(done.tracks).toHaveLength(450);
    expect(done.tracks.map((t) => t.title).slice(199, 202)).toEqual([
      "Song 199",
      "Song 200",
      "Song 201",
    ]);
    expect(done.maybeMore).toBe(false);
  });

  it("keeps the songs before a page that fails, even when later pages came", async () => {
    stubFetch(
      page(full),
      apiPage(100, 200, 500),
      apiPage(200, 300, 500),
      json({}, 500),
      apiPage(400, 500, 500),
    );
    const playlist = await fetchSpotifyPlaylist("playlist", PLAYLIST);
    expect(playlist.tracks).toHaveLength(300);
    expect(playlist.maybeMore).toBe(true);
    expect(playlist.more).toMatchObject({ reason: "failed", note: "HTTP 500" });
  });

  it("stops at a short page before the end, rather than leave a gap", async () => {
    stubFetch(page(full), apiPage(100, 200, 400), apiPage(200, 250, 400), apiPage(300, 400, 400));
    const playlist = await fetchSpotifyPlaylist("playlist", PLAYLIST);
    expect(playlist.tracks).toHaveLength(250);
    expect(playlist.maybeMore).toBe(true);
    expect(playlist.more).toMatchObject({ reason: "failed", note: "a page came back short" });
  });

  it(`stops at ${PLAYLIST_MAX_SONGS} songs`, async () => {
    const total = PLAYLIST_MAX_SONGS + 500;
    const pages = [];
    for (let from = 100; from < PLAYLIST_MAX_SONGS; from += 100) {
      pages.push(apiPage(from, from + 100, total));
    }
    const fetch = stubFetch(page(full), ...pages);
    const playlist = await fetchSpotifyPlaylist("playlist", PLAYLIST);
    expect(playlist.tracks).toHaveLength(PLAYLIST_MAX_SONGS);
    expect(playlist.maybeMore).toBe(true);
    expect(playlist.more).toEqual({ reason: "limit" });
    expect(fetch).toHaveBeenCalledTimes(1 + pages.length);
  });
});

describe("fetchSpotifyPlaylist with your Spotify sign-in", () => {
  const PLAYLIST = "1aBcDeFgHiJkLmNoPqRsTu";
  const YOURS = "BQDyourOwnPassFromSigningIn0000000000000";
  const signedIn = async () => YOURS;
  /** An entry as `/items` answers since Spotify's Feb 2026 changes: the song under `item`. */
  const itemEntry = (n: number) => ({ is_local: false, item: apiItem(n).track });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const itemsPage = (from: number, to: number, total: number) => ({
    total,
    items: Array.from({ length: Math.max(0, to - from) }, (_, i) => itemEntry(from + i)),
  });
  /** Spotify: your playlist (`total` songs, `first` in its first page) by address. */
  const standIn = (total: number, answer?: (url: URL) => Response | undefined) => {
    const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
      const asked = new URL(url);
      const own = answer?.(asked);
      if (own) return own;
      if (asked.pathname === `/v1/playlists/${PLAYLIST}`) {
        return json({
          name: "Trance Legends",
          owner: { display_name: "Shayan" },
          images: [
            { url: "https://i.scdn.co/image/640", width: 640 },
            { url: "https://i.scdn.co/image/300", width: 300 },
          ],
          items: itemsPage(0, Math.min(100, total), total),
        });
      }
      if (asked.pathname === `/v1/playlists/${PLAYLIST}/items`) {
        const offset = Number(asked.searchParams.get("offset"));
        const limit = Number(asked.searchParams.get("limit"));
        return json(itemsPage(offset, Math.min(offset + limit, total), total));
      }
      throw new TypeError(`fetch failed: nothing stands in for ${url}`);
    });
    vi.stubGlobal("fetch", fetch);
    return fetch;
  };
  afterEach(() => {
    vi.unstubAllGlobals();
    webApiRefusal.clear();
  });

  it("lists your own playlist whole from the Web API, 50 songs a page, with your pass", async () => {
    const fetch = standIn(260);
    const playlist = await fetchSpotifyPlaylist("playlist", PLAYLIST, { signedIn });
    expect(playlist).toMatchObject({
      name: "Trance Legends",
      by: "Shayan",
      image: "https://i.scdn.co/image/300",
      url: `https://open.spotify.com/playlist/${PLAYLIST}`,
      maybeMore: false,
    });
    expect(playlist.more).toBeUndefined();
    expect(playlist.tracks).toHaveLength(260);
    expect(playlist.tracks.map((t) => t.title).slice(99, 101)).toEqual(["Song 99", "Song 100"]);
    expect(playlist.tracks[0]).toMatchObject({ artists: "Band, Guest", duration: 200 });
    // No embed page and no anonymous pass: just yours.
    const urls = fetch.mock.calls.map(([url]) => url);
    expect(urls.some((url) => url.includes("/embed/"))).toBe(false);
    for (const [, init] of fetch.mock.calls) {
      expect(init?.headers).toEqual({ Authorization: `Bearer ${YOURS}` });
    }
    const offsets = urls
      .filter((url) => url.includes("/items?"))
      .map((url) => new URL(url).searchParams.get("offset"))
      .sort((a, b) => Number(a) - Number(b));
    expect(offsets).toEqual(["100", "150", "200", "250"]);
  });

  it("reads someone else's playlist from the embed page, as when signed out", async () => {
    // Since Feb 2026 Spotify answers a playlist that isn't yours without its songs.
    const fetch = standIn(0, (url) =>
      url.pathname === `/v1/playlists/${PLAYLIST}`
        ? json({ name: "Not Mine", owner: { display_name: "Someone" } })
        : url.pathname === `/embed/playlist/${PLAYLIST}`
          ? new Response(
              embedPage({
                state: { data: { entity: playlistEntity }, settings: { session: {} } },
              }),
            )
          : undefined,
    );
    const playlist = await fetchSpotifyPlaylist("playlist", PLAYLIST, { signedIn });
    expect(playlist.name).toBe(playlistEntity.name);
    expect(fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      `/v1/playlists/${PLAYLIST}`,
      `/embed/playlist/${PLAYLIST}`,
    ]);
  });

  it("falls back to the embed page when Spotify refuses your pass or isn't reached", async () => {
    for (const refusal of [json({ error: { status: 403 } }, 403), json({}, 401)]) {
      standIn(0, (url) =>
        url.pathname === `/v1/playlists/${PLAYLIST}`
          ? refusal
          : url.pathname === `/embed/playlist/${PLAYLIST}`
            ? new Response(
                embedPage({
                  state: { data: { entity: playlistEntity }, settings: { session: {} } },
                }),
              )
            : undefined,
      );
      expect((await fetchSpotifyPlaylist("playlist", PLAYLIST, { signedIn })).name).toBe(
        playlistEntity.name,
      );
    }
  });

  it("asks nothing as you when nobody is signed in", async () => {
    const fetch = standIn(0, (url) =>
      url.pathname.startsWith("/embed/")
        ? new Response(
            embedPage({ state: { data: { entity: playlistEntity }, settings: { session: {} } } }),
          )
        : undefined,
    );
    await fetchSpotifyPlaylist("playlist", PLAYLIST, { signedIn: async () => undefined });
    expect(fetch.mock.calls.map(([url]) => new URL(url).hostname)).toEqual(["open.spotify.com"]);
  });

  it("keeps the songs before a page that fails, and says when Spotify refused", async () => {
    standIn(300, (url) =>
      url.pathname.endsWith("/items") && url.searchParams.get("offset") === "200"
        ? new Response("{}", { status: 429, headers: { "retry-after": "30" } })
        : undefined,
    );
    const playlist = await fetchSpotifyPlaylist("playlist", PLAYLIST, { signedIn });
    expect(playlist.tracks).toHaveLength(200);
    expect(playlist.maybeMore).toBe(true);
    expect(playlist.more?.reason).toBe("refused");
    // Your own quota: the anonymous route's refusal is left alone.
    expect(webApiRefusal.until).toBe(0);
  });

  it(`stops at ${PLAYLIST_MAX_SONGS} songs`, async () => {
    standIn(PLAYLIST_MAX_SONGS + 40);
    const playlist = await fetchSpotifyPlaylist("playlist", PLAYLIST, { signedIn });
    expect(playlist.tracks).toHaveLength(PLAYLIST_MAX_SONGS);
    expect(playlist.more).toEqual({ reason: "limit" });
  });
});

describe("fetchMyPlaylists", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists your playlists with their song counts, page after page", async () => {
    const playlist = (n: number) => ({
      id: `${String(n).padStart(4, "0")}aBcDeFgHiJkLmNoPqR`.slice(0, 22),
      name: `List ${n}`,
      owner: { display_name: "Shayan" },
      images: [{ url: `https://i.scdn.co/${n}`, width: 640 }],
      items: { total: n },
    });
    const fetch = vi.fn(async (url: string) => {
      const offset = Number(new URL(url).searchParams.get("offset"));
      const count = offset === 0 ? 50 : 3;
      return Response.json({
        items: Array.from({ length: count }, (_, i) => playlist(offset + i)),
        next: offset === 0 ? "more" : null,
      });
    });
    vi.stubGlobal("fetch", fetch);
    const list = await fetchMyPlaylists("BQDyourOwnPassFromSigningIn0000000000000");
    expect(list).toHaveLength(53);
    expect(list[52]).toEqual({
      id: playlist(52).id,
      url: `https://open.spotify.com/playlist/${playlist(52).id}`,
      name: "List 52",
      by: "Shayan",
      image: "https://i.scdn.co/52",
      songs: 52,
    });
    expect(fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      "/v1/me/playlists",
      "/v1/me/playlists",
    ]);
  });

  it("says to sign in again when Spotify no longer takes the pass", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 401 })),
    );
    await expect(fetchMyPlaylists("BQDexpired0000000000000000")).rejects.toMatchObject({
      status: 401,
      message: "Your Spotify sign-in ended. Sign in again.",
    });
  });
});

describe("parseRetryAfter", () => {
  const NOW = Date.UTC(2026, 9, 12, 14, 0, 0);

  it("reads seconds or an HTTP date, as the time to ask again", () => {
    expect(parseRetryAfter("54901", NOW)).toBe(NOW + 54_901_000);
    expect(parseRetryAfter(" 120 ", NOW)).toBe(NOW + 120_000);
    expect(parseRetryAfter("Tue, 13 Oct 2026 05:10:00 GMT", NOW)).toBe(
      Date.UTC(2026, 9, 13, 5, 10, 0),
    );
  });

  it("gives undefined for nothing to wait for, or anything it can't read", () => {
    for (const value of [null, "", "0", "-5", "1.5", "soon", "Mon, 12 Oct 2026 13:00:00 GMT"]) {
      expect(parseRetryAfter(value, NOW), String(value)).toBeUndefined();
    }
  });

  it("turns down a time later than any date can be", () => {
    expect(parseRetryAfter("99999999999999", NOW)).toBeUndefined();
    expect(parseRetryAfter(String(8.64e12), NOW)).toBeUndefined();
    expect(parseRetryAfter(String(365 * 86_400), NOW)).toBe(NOW + 365 * 86_400_000);
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

  it("leaves out “audio” on SoundCloud, whose tracks are all audio", () => {
    const track = { title: "One More Time", artists: ["Daft Punk"] };
    expect(spotifySearchQuery(track, "soundcloud")).toBe("Daft Punk One More Time");
    expect(spotifySearchQuery(track, "youtube")).toBe("Daft Punk One More Time audio");
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

describe("parseOembed", () => {
  it("reads the title and cover: all the oEmbed endpoint knows", () => {
    expect(
      parseOembed(
        {
          title: "Bohemian Rhapsody - Remastered 2011",
          thumbnail_url: "https://i.scdn.co/image/ab67616d00001e02",
          provider_name: "Spotify",
        },
        ID,
      ),
    ).toEqual({
      id: ID,
      url: `https://open.spotify.com/track/${ID}`,
      title: "Bohemian Rhapsody - Remastered 2011",
      artists: [],
      duration: null,
      thumbnail: "https://i.scdn.co/image/ab67616d00001e02",
      source: "spotify-oembed",
    });
    expect(parseOembed({ title: "Song" }, ID).thumbnail).toBeNull();
  });

  it("fails clearly without a title", () => {
    for (const json of [{}, null, { title: " " }, { title: 42 }]) {
      expect(() => parseOembed(json, ID)).toThrow(SpotifyError);
    }
  });
});

describe("fetchSpotifyTrack", () => {
  const trackPage = () => new Response(embedPage({ state: { data: { entity: trackEntity } } }));
  const oembed = (status = 200) =>
    new Response(
      JSON.stringify({
        title: "Bohemian Rhapsody - Remastered 2011",
        thumbnail_url: "https://i.scdn.co/image/cover",
      }),
      { status, headers: { "content-type": "application/json" } },
    );
  const answer = (status: number, headers: Record<string, string> = {}) =>
    new Response(status === 204 ? null : "error", { status, headers });
  /** Spotify's answers, in turn: a response, or an error to throw (no answer at all). */
  const stubFetch = (...responses: (Response | Error)[]) => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => {
      const next = responses.shift();
      if (!next) throw new TypeError("fetch failed");
      if (next instanceof Error) throw next;
      return next;
    });
    vi.stubGlobal("fetch", fetch);
    return fetch;
  };
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    spotifyTrackCache.clear();
  });
  const healthOf = (source: "spotify" | "spotify-oembed") => {
    const { ok, failed, throttled } = sourceHealth.report().sources[source];
    return { ok, failed, throttled };
  };

  it("reads the song from its embed page, and records that Spotify answered", async () => {
    const before = healthOf("spotify");
    const fetch = stubFetch(trackPage());
    const track = await fetchSpotifyTrack(ID);
    expect(track).toMatchObject({
      title: "Bohemian Rhapsody - Remastered 2011",
      artists: ["Queen"],
    });
    expect(track.source).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(`https://open.spotify.com/embed/track/${ID}`);
    expect(healthOf("spotify").ok).toBe(before.ok + 1);
  });

  it("asks Spotify once about a song it has just read — but again after a fallback's answer", async () => {
    const fetch = stubFetch(trackPage());
    const first = await fetchSpotifyTrack(ID);
    expect(await fetchSpotifyTrack(ID)).toBe(first);
    expect(fetch).toHaveBeenCalledTimes(1);

    spotifyTrackCache.clear();
    const fallback = stubFetch(answer(503), oembed(), trackPage());
    expect((await fetchSpotifyTrack(ID)).source).toBe("spotify-oembed");
    expect((await fetchSpotifyTrack(ID)).source).toBeUndefined(); // the whole song, this time
    expect(fallback).toHaveBeenCalledTimes(3);
  });

  it("goes straight to the oEmbed endpoint after a 429 — no retry, no waiting", async () => {
    // Fake timers: a wait (Retry-After, a back-off) would never end, and the test with it.
    vi.useFakeTimers();
    const before = { spotify: healthOf("spotify"), oembed: healthOf("spotify-oembed") };
    const fetch = stubFetch(answer(429, { "retry-after": "30" }), oembed());
    const track = await fetchSpotifyTrack(ID);
    expect(track.source).toBe("spotify-oembed");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    expect(healthOf("spotify")).toEqual({
      ok: before.spotify.ok,
      failed: before.spotify.failed + 1,
      throttled: before.spotify.throttled + 1,
    });
    expect(healthOf("spotify-oembed").ok).toBe(before.oembed.ok + 1);
  });

  it("falls back to the oEmbed endpoint at once when the embed page can't be read", async () => {
    vi.useFakeTimers();
    const timedOut = () =>
      Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
    // A 429, a 5xx, no answer in time, or a page whose shape has changed.
    for (const responses of [
      [answer(429), oembed()],
      [answer(503), oembed()],
      [timedOut(), oembed()],
      [new Response("<html>nothing here</html>"), oembed()],
    ]) {
      const before = healthOf("spotify-oembed");
      const fetch = stubFetch(...responses);
      const track = await fetchSpotifyTrack(ID);
      expect(track).toEqual({
        id: ID,
        url: `https://open.spotify.com/track/${ID}`,
        title: "Bohemian Rhapsody - Remastered 2011",
        artists: [],
        duration: null,
        thumbnail: "https://i.scdn.co/image/cover",
        source: "spotify-oembed",
      });
      const last = fetch.mock.calls.at(-1)!;
      const url = new URL(last[0]);
      expect(url.origin + url.pathname).toBe("https://open.spotify.com/oembed");
      expect(url.searchParams.get("url")).toBe(`https://open.spotify.com/track/${ID}`);
      expect(healthOf("spotify-oembed").ok).toBe(before.ok + 1);
      vi.unstubAllGlobals();
    }
  });

  it("doesn't fall back for a song Spotify doesn't have", async () => {
    const fetch = stubFetch(answer(404), oembed());
    await expect(fetchSpotifyTrack(ID)).rejects.toMatchObject({ status: 404 });
    expect(fetch).toHaveBeenCalledTimes(1);

    const inPage = stubFetch(new Response(embedPage({ status: 404, title: "Page not found" })));
    await expect(fetchSpotifyTrack(ID)).rejects.toMatchObject({ status: 404 });
    expect(inPage).toHaveBeenCalledTimes(1);
  });

  it("reports the embed page's problem when the fallback fails too", async () => {
    stubFetch(answer(503), answer(500));
    await expect(fetchSpotifyTrack(ID)).rejects.toThrow(/HTTP 503/);
    stubFetch(answer(503)); // and then no connection at all
    await expect(fetchSpotifyTrack(ID)).rejects.toThrow(/HTTP 503/);
  });

  it("asks the oEmbed endpoint only about a valid song id", async () => {
    const fetch = stubFetch(oembed());
    await expect(fetchOembedTrack("not-an-id")).rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
    await expect(fetchOembedTrack(ID)).resolves.toMatchObject({ source: "spotify-oembed" });
  });
});
