import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { createServer } from "http";
import request from "supertest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import {
  COOLDOWN_MS,
  LIMITED_MESSAGE,
  playlistCacheKey,
  searchCacheKey,
  videoCacheKey,
  youtubeGuard,
} from "../../server/youtube-limits";
import { sourceHealth } from "../../server/source-health";
import { errorSchemas } from "../../shared/routes";
import { sourceHealthReportSchema } from "../../shared/schema";

// The routes' answers while YouTube is limiting this computer: a 429 that
// says how long to wait, with nothing asked of YouTube (there's no yt-dlp to
// run in this test: asking would show up as a failure, not a 429), cached
// answers still served, and the source-health report. No network needed.

let app: express.Express;
let dir: string;

const VIDEO = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const PLAYLIST = "https://www.youtube.com/playlist?list=PLBCF2DAC6FFB574DE";

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-limited-"));
  process.env.HISTORY_FILE = path.join(dir, "history.json");
  process.env.SETTINGS_FILE = path.join(dir, "settings.json");
  process.env.SOURCE_HEALTH_FILE = path.join(dir, "source-health.json");

  const { registerRoutes } = await import("../../server/routes");
  app = express();
  app.use(express.json());
  await registerRoutes(createServer(app), app);
});

afterAll(async () => {
  youtubeGuard.reset();
  await sourceHealth.flush().catch(() => {});
  delete process.env.HISTORY_FILE;
  delete process.env.SETTINGS_FILE;
  delete process.env.SOURCE_HEALTH_FILE;
  await fs.rm(dir, { recursive: true, force: true });
});

afterEach(() => youtubeGuard.reset());

/** Checks a response is the 429 every route sends while YouTube is limiting us. */
function expectLimited(res: request.Response) {
  expect(res.status).toBe(429);
  expect(res.headers["retry-after"]).toBe(String(COOLDOWN_MS / 1000));
  const body = errorSchemas.rateLimited.parse(res.body);
  expect(body).toEqual({
    message: LIMITED_MESSAGE,
    retryAfterSeconds: COOLDOWN_MS / 1000,
    source: "youtube",
  });
  expect(res.headers["content-disposition"]).toBeUndefined();
}

describe("while YouTube is limiting this computer", () => {
  it("search, video info and playlists answer 429 without asking YouTube", async () => {
    youtubeGuard.cooldown.start(Date.now());
    expectLimited(await request(app).get("/api/search").query({ q: "daft punk get lucky" }));
    expectLimited(await request(app).post("/api/video/info").send({ url: VIDEO }));
    expectLimited(await request(app).get("/api/youtube/playlist").query({ link: PLAYLIST }));
  });

  it("a download answers 429 before anything is sent", async () => {
    youtubeGuard.cooldown.start(Date.now());
    expectLimited(await request(app).get("/api/video/download").query({ url: VIDEO }));
  });

  it("saving into the folder answers 429 too", async () => {
    const folder = path.join(dir, "Music");
    await fs.mkdir(folder, { recursive: true });
    const settings = await request(app).put("/api/settings").send({ saveFolder: folder });
    expect(settings.status).toBe(200);

    youtubeGuard.cooldown.start(Date.now());
    expectLimited(await request(app).post("/api/video/save").send({ url: VIDEO, format: "mp3" }));
    expect(await fs.readdir(folder)).toEqual([]); // no .part file was started
  });

  it("still answers a search it has cached", async () => {
    const results = [
      {
        id: "dQw4w9WgXcQ",
        url: VIDEO,
        title: "Never Gonna Give You Up",
        channel: "Rick Astley",
        duration: 213,
        thumbnail: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
        official: true,
      },
    ];
    youtubeGuard.cache.set(searchCacheKey("rick astley"), results, Date.now());
    youtubeGuard.cooldown.start(Date.now());
    const res = await request(app).get("/api/search").query({ q: "Rick  Astley" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ results });
  });

  it("still answers a video and a playlist it has cached — as they're sent, not yt-dlp's JSON", async () => {
    const video = { title: "Never Gonna Give You Up", thumbnail: "https://i.ytimg.com/vi/x/0.jpg" };
    youtubeGuard.cache.set(videoCacheKey("dQw4w9WgXcQ"), video, Date.now());
    const playlist = {
      source: "youtube",
      kind: "playlist",
      id: "PLBCF2DAC6FFB574DE",
      url: PLAYLIST,
      name: "Classics",
      by: null,
      image: null,
      tracks: [],
      maybeMore: false,
    };
    youtubeGuard.cache.set(playlistCacheKey("PLBCF2DAC6FFB574DE"), playlist, Date.now());
    youtubeGuard.cooldown.start(Date.now());

    const info = await request(app).post("/api/video/info").send({ url: VIDEO });
    expect(info.status).toBe(200);
    expect(info.body).toEqual({ ...video, url: VIDEO });
    const listed = await request(app).get("/api/youtube/playlist").query({ link: PLAYLIST });
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual(playlist);
  });

  it("the cooldown counts down in the answer", async () => {
    youtubeGuard.cooldown.start(Date.now() - COOLDOWN_MS + 90_000);
    const res = await request(app).get("/api/search").query({ q: "x" });
    expect(res.status).toBe(429);
    expect(res.body.retryAfterSeconds).toBeLessThanOrEqual(90);
    expect(res.body.retryAfterSeconds).toBeGreaterThan(80);
    expect(res.headers["retry-after"]).toBe(String(res.body.retryAfterSeconds));
  });
});

describe("GET /api/health/sources", () => {
  it("reports how the sources have been answering, for anyone", async () => {
    youtubeGuard.pipelineEnded(false, "HTTP Error 429: Too Many Requests");
    youtubeGuard.pipelineEnded(true, "");
    const res = await request(app).get("/api/health/sources");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const report = sourceHealthReportSchema.parse(res.body);
    expect(report.sources.youtube).toMatchObject({
      role: "primary",
      for: "audio",
      throttled: 1,
      lastError: "HTTP Error 429: Too Many Requests",
    });
    expect(report.sources.youtube.ok).toBeGreaterThanOrEqual(1);
    expect(Object.keys(report.sources).sort()).toEqual(["spotify", "spotify-oembed", "youtube"]);
    expect(JSON.stringify(report)).not.toContain(dir); // no paths in it
  });

  it("is also written to the source-health file", async () => {
    youtubeGuard.pipelineEnded(true, "");
    await sourceHealth.flush();
    const written = sourceHealthReportSchema.parse(
      JSON.parse(await fs.readFile(path.join(dir, "source-health.json"), "utf8")),
    );
    expect(written.sources.youtube.ok).toBeGreaterThanOrEqual(1);
  });
});
