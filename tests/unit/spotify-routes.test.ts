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
