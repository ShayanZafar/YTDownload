// The Spotify playlist route as the page uses it: the real Express routes,
// with Spotify played by a stand-in fetch (no network).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer } from "http";
import request from "supertest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { webApiRefusal } from "../../server/spotify";
import { sourceHealth } from "../../server/source-health";
import { sourceHealthReportSchema, spotifyPlaylistSchema } from "../../shared/schema";

const PLAYLIST = "1aBcDeFgHiJkLmNoPqRsTu";
const LINK = `https://open.spotify.com/playlist/${PLAYLIST}`;
const PASS = "BQBwyEGz2FQskAhrmhWc1nzSmTZ_RCV8pdaLd2QDbuW";

const trackId = (n: number) => `${String(n).padStart(4, "0")}Foc5Q5nqNiosCNqttz`.slice(0, 22);

/** The playlist's embed page: its first 100 songs, and the anonymous pass. */
const embedPage = () =>
  `<!DOCTYPE html><html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: {
      pageProps: {
        state: {
          data: {
            entity: {
              type: "playlist",
              name: "Trance Legends",
              subtitle: "Shayan",
              trackList: Array.from({ length: 100 }, (_, n) => ({
                uri: `spotify:track:${trackId(n)}`,
                title: `Song ${n}`,
                subtitle: "Band",
                duration: 200_000,
                entityType: "track",
              })),
            },
          },
          settings: { session: { accessToken: PASS, isAnonymous: true } },
        },
      },
    },
    page: "/playlist/[id]",
  })}</script></body></html>`;

/** A page of the playlist from Spotify's Web API: songs `from`…`to - 1` of `total`. */
const apiPage = (from: number, to: number, total: number) =>
  Response.json({
    total,
    items: Array.from({ length: to - from }, (_, i) => ({
      is_local: false,
      track: {
        type: "track",
        id: trackId(from + i),
        name: `Song ${from + i}`,
        duration_ms: 200_000,
        explicit: false,
        artists: [{ name: "Band" }],
      },
    })),
  });

/** Spotify: the embed page, and the Web API answering with `webApi` (by offset). */
function standInSpotify(webApi: (offset: number) => Response) {
  const fetch = vi.fn(async (url: string) => {
    if (url === `https://open.spotify.com/embed/playlist/${PLAYLIST}`) {
      return new Response(embedPage());
    }
    const asked = new URL(url);
    if (asked.origin === "https://api.spotify.com") {
      return webApi(Number(asked.searchParams.get("offset")));
    }
    throw new TypeError(`fetch failed: nothing stands in for ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  return {
    webApiCalls: () =>
      fetch.mock.calls.filter(([url]) => url.startsWith("https://api.spotify.com/")).length,
  };
}

let app: express.Express;
let dir: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-spotify-routes-"));
  process.env.HISTORY_FILE = path.join(dir, "history.json");
  process.env.SETTINGS_FILE = path.join(dir, "settings.json");
  process.env.SOURCE_HEALTH_FILE = path.join(dir, "source-health.json");
  process.env.SPOTIFY_SIGN_IN_FILE = path.join(dir, "spotify-sign-in.json");
  const { registerRoutes } = await import("../../server/routes");
  app = express();
  app.use(express.json());
  await registerRoutes(createServer(app), app);
});

afterEach(() => {
  vi.unstubAllGlobals();
  webApiRefusal.clear();
});

afterAll(async () => {
  await sourceHealth.flush().catch(() => {});
  delete process.env.HISTORY_FILE;
  delete process.env.SETTINGS_FILE;
  delete process.env.SOURCE_HEALTH_FILE;
  delete process.env.SPOTIFY_SIGN_IN_FILE;
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const openPlaylist = async () => {
  const res = await request(app).get("/api/spotify/playlist").query({ link: LINK });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return spotifyPlaylistSchema.parse(res.body);
};

describe("GET /api/spotify/playlist (Spotify played by a stand-in)", () => {
  it("lists every song of a long playlist, the rest from Spotify's Web API", async () => {
    const spotify = standInSpotify((offset) => apiPage(offset, Math.min(offset + 100, 250), 250));
    const playlist = await openPlaylist();
    expect(playlist.name).toBe("Trance Legends");
    expect(playlist.tracks).toHaveLength(250);
    expect(playlist.tracks.at(-1)?.title).toBe("Song 249");
    expect(playlist.maybeMore).toBe(false);
    expect(playlist.more).toBeUndefined();
    expect(spotify.webApiCalls()).toBe(2);
  });

  it("while Spotify refuses the rest, answers at once with the first 100 and when to ask again", async () => {
    const spotify = standInSpotify(
      () =>
        new Response(JSON.stringify({ error: { status: 429 } }), {
          status: 429,
          headers: { "Retry-After": "54901" },
        }),
    );
    const askedAt = Date.now();
    const first = await openPlaylist();
    expect(first.tracks).toHaveLength(100);
    expect(first.maybeMore).toBe(true);
    expect(first.more?.reason).toBe("refused");
    const retryAt = Date.parse(first.more!.retryAt!);
    expect(retryAt).toBeGreaterThanOrEqual(askedAt + 54_901_000);
    expect(retryAt).toBeLessThanOrEqual(Date.now() + 54_901_000);
    expect(spotify.webApiCalls()).toBe(1);

    // Opened again: the same answer, and Spotify's Web API isn't asked.
    const again = await openPlaylist();
    expect(again.tracks).toHaveLength(100);
    expect(again.more).toEqual(first.more);
    expect(spotify.webApiCalls()).toBe(1);

    // The health report says so: refused for 15 hours, nothing to stand in.
    const health = sourceHealthReportSchema.parse(
      (await request(app).get("/api/health/sources")).body,
    );
    const webApi = health.sources["spotify-web-api"];
    expect(webApi).toMatchObject({ throttled: 1, lastError: "HTTP 429" });
    expect(Math.abs(Date.parse(webApi.refusedUntil!) - retryAt)).toBeLessThan(1000);
    expect(health.unreliable).toBe(true);
  });
});

// Signing in with Spotify through the page's routes, then opening your own
// playlist: Spotify's sign-in and Web API are played by a stand-in fetch.
describe("Spotify sign-in, then your own playlist (Spotify played by a stand-in)", () => {
  const CLIENT_ID = "0123456789abcdef0123456789abcdef";
  const YOURS = "BQDyourOwnPassFromSigningIn0000000000000";
  const TOTAL = 230;
  const itemsPage = (from: number, to: number) => ({
    total: TOTAL,
    items: Array.from({ length: to - from }, (_, i) => ({
      is_local: false,
      item: {
        type: "track",
        id: trackId(from + i),
        name: `Song ${from + i}`,
        duration_ms: 200_000,
        explicit: false,
        artists: [{ name: "Band" }],
      },
    })),
  });

  function standInSignedInSpotify() {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const asked = new URL(url);
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (url === "https://accounts.spotify.com/api/token") {
        return Response.json({ access_token: YOURS, refresh_token: "refresh", expires_in: 3600 });
      }
      if (auth !== `Bearer ${YOURS}`) throw new TypeError(`fetch failed: not signed in for ${url}`);
      if (asked.pathname === "/v1/me") return Response.json({ display_name: "moomoo" });
      if (asked.pathname === "/v1/me/playlists") {
        return Response.json({
          items: [{ id: PLAYLIST, name: "Trance Legends", items: { total: TOTAL }, images: [] }],
          next: null,
        });
      }
      if (asked.pathname === `/v1/playlists/${PLAYLIST}`) {
        return Response.json({
          name: "Trance Legends",
          owner: { display_name: "moomoo" },
          items: itemsPage(0, 100),
        });
      }
      if (asked.pathname === `/v1/playlists/${PLAYLIST}/items`) {
        const offset = Number(asked.searchParams.get("offset"));
        const limit = Number(asked.searchParams.get("limit"));
        return Response.json(itemsPage(offset, Math.min(offset + limit, TOTAL)));
      }
      throw new TypeError(`fetch failed: nothing stands in for ${url}`);
    });
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }

  it("sets the Client ID, signs in through Spotify's page, and lists your playlist whole", async () => {
    const fetch = standInSignedInSpotify();
    const before = await request(app).get("/api/spotify/account");
    expect(before.body).toMatchObject({ canSignIn: true, clientId: null, signedInAs: null });
    expect(before.body.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/spotify\/callback$/);

    const bad = await request(app).put("/api/spotify/account/client-id").send({ clientId: "nope" });
    expect(bad.status).toBe(400);
    const set = await request(app)
      .put("/api/spotify/account/client-id")
      .send({ clientId: CLIENT_ID });
    expect(set.body).toMatchObject({ clientId: CLIENT_ID, signedInAs: null });

    // A form on another website can't start one (it isn't JSON).
    expect(
      (await request(app).post("/api/spotify/account/sign-in").type("form").send("x=1")).status,
    ).toBe(415);
    const start = await request(app)
      .post("/api/spotify/account/sign-in")
      .set("Host", "localhost:5000")
      .send({});
    expect(start.status).toBe(200);
    const spotifyPage = new URL(start.body.url);
    expect(spotifyPage.origin).toBe("https://accounts.spotify.com");

    // Spotify sends the browser back with the code, and the app sends it home.
    const back = await request(app)
      .get("/api/spotify/callback")
      .query({ code: "the-code", state: spotifyPage.searchParams.get("state") });
    expect(back.status).toBe(303);
    expect(back.headers.location).toBe("http://localhost:5000/");
    // The same link again does nothing.
    const again = await request(app)
      .get("/api/spotify/callback")
      .query({ code: "the-code", state: spotifyPage.searchParams.get("state") });
    expect(again.status).toBe(400);

    const after = await request(app).get("/api/spotify/account");
    expect(after.body).toMatchObject({ clientId: CLIENT_ID, signedInAs: "moomoo", error: null });
    expect(JSON.stringify(after.body)).not.toContain(YOURS);

    const mine = await request(app).get("/api/spotify/account/playlists");
    expect(mine.body).toEqual([
      expect.objectContaining({ id: PLAYLIST, name: "Trance Legends", songs: TOTAL }),
    ]);

    const playlist = await openPlaylist();
    expect(playlist.tracks).toHaveLength(TOTAL);
    expect(playlist.tracks.at(-1)?.title).toBe(`Song ${TOTAL - 1}`);
    expect(playlist.maybeMore).toBe(false);
    expect(fetch.mock.calls.some(([url]) => url.includes("/embed/"))).toBe(false);

    const out = await request(app).post("/api/spotify/account/sign-out").send({});
    expect(out.body).toMatchObject({ clientId: CLIENT_ID, signedInAs: null });
    expect((await request(app).get("/api/spotify/account/playlists")).status).toBe(401);
  });

  it("keeps the sign-in to this computer: another device can't see or use it", async () => {
    standInSignedInSpotify();
    const fromPhone = (req: request.Test) => req.set("X-Forwarded-For", "192.168.1.20");
    const status = await fromPhone(request(app).get("/api/spotify/account"));
    expect(status.body).toMatchObject({ canSignIn: false, clientId: null, signedInAs: null });
    expect(
      (await fromPhone(request(app).post("/api/spotify/account/sign-in").send({}))).status,
    ).toBe(403);
    expect((await fromPhone(request(app).get("/api/spotify/account/playlists"))).status).toBe(403);
    expect(
      (await fromPhone(request(app).get("/api/spotify/callback").query({ state: "x" }))).status,
    ).toBe(403);
  });
});
