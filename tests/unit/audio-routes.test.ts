import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import http, { createServer } from "http";
import type { AddressInfo } from "net";
import request from "supertest";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { REFUSED_MESSAGE, searchCacheKey, youtubeGuard } from "../../server/youtube-limits";
import { sourceHealth } from "../../server/source-health";
import { FFMPEG_PATH } from "../../server/audio";
import { errorSchemas } from "../../shared/routes";
import { sourceHealthReportSchema } from "../../shared/schema";
import { verifyMp3File } from "../utils/mp3";

// The routes that ask YouTube, with yt-dlp played by stand-ins — no network:
// its look-ups are fakes, and its audio stream is a small Node process
// writing an MP3 that ffmpeg made. Everything else is the real thing: the
// routes, the guard, the yt-dlp → ffmpeg pipeline, the folder and the history.

const fake = vi.hoisted(() => ({
  videoInfo: vi.fn(),
  audioInfo: vi.fn(),
  runJson: vi.fn(),
  /** What plays yt-dlp's audio stream for the next download or save. */
  source: undefined as undefined | (() => ChildProcessWithoutNullStreams),
  /** Every stand-in started, and how each pipeline ended. */
  sources: [] as ChildProcessWithoutNullStreams[],
  pipelines: [] as Promise<{ ok: boolean; reason: string }>[],
}));

vi.mock("../../server/audio", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../server/audio")>();
  return {
    ...real,
    fetchVideoInfo: fake.videoInfo,
    fetchAudioInfo: fake.audioInfo,
    runYtDlpJson: fake.runJson,
    startAudioPipeline: (
      url: string,
      formatId: string | undefined,
      args: string[],
      prefix?: Buffer,
    ) => {
      const pipeline = real.startAudioPipeline(url, formatId, args, prefix, {
        spawnSource: () => {
          const child = fake.source!();
          fake.sources.push(child);
          return child;
        },
      });
      fake.pipelines.push(pipeline.finished);
      return pipeline;
    },
  };
});

// A download's cover comes from YouTube's thumbnails or Spotify (server/cover.ts):
// none here, so nothing leaves this computer.
vi.mock("../../server/cover", () => ({ coverFor: async () => undefined }));

const VIDEO = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const PLAYLIST = "https://www.youtube.com/playlist?list=PLBCF2DAC6FFB574DE";
const BOT_CHECK = "Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies";
const TOO_MANY = "HTTP Error 429: Too Many Requests";

// The stand-in for yt-dlp's stream: writes a file to stdout — all at once, or
// a burst and then 4 KB every 200 ms (slow enough to cancel part-way).
const PLAY = `
const fs = require("fs");
const [file, burst] = process.argv.slice(1);
const data = fs.readFileSync(file);
let at = Math.min(Number(burst), data.length);
process.stdout.write(data.subarray(0, at));
if (at < data.length) {
  const timer = setInterval(() => {
    process.stdout.write(data.subarray(at, at + 4096));
    at += 4096;
    if (at >= data.length) clearInterval(timer);
  }, 200);
}`;
const playing =
  (file: string, { slow = false } = {}) =>
  () =>
    spawn(process.execPath, ["-e", PLAY, file, String(slow ? 64 * 1024 : 1e9)], {
      windowsHide: true,
    });
/** yt-dlp when YouTube refuses the stream: its error line, no audio, exit code 1. */
const refusing = (line: string) => () =>
  spawn(
    process.execPath,
    [
      "-e",
      `process.stderr.write(${JSON.stringify(`ERROR: [youtube] dQw4w9WgXcQ: ${line}\n`)}); process.exitCode = 1;`,
    ],
    { windowsHide: true },
  );

/** Runs ffmpeg with `args`. */
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

let app: express.Express;
let dir: string;
let folder: string;
let tone: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-routes-"));
  process.env.HISTORY_FILE = path.join(dir, "history.json");
  process.env.SETTINGS_FILE = path.join(dir, "settings.json");
  process.env.SOURCE_HEALTH_FILE = path.join(dir, "source-health.json");
  folder = path.join(dir, "Music");
  await fs.mkdir(folder);
  // 20 seconds of tone as a 128 kbps MP3 (~320 KB): what "YouTube" sends.
  tone = path.join(dir, "tone.mp3");
  await ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=20",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "128k",
    tone,
  ]);

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
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

beforeEach(() => {
  // A refusal or an outdated yt-dlp starts a background update: never a real one here.
  vi.spyOn(youtubeGuard.updater, "update").mockResolvedValue(false);
  fake.audioInfo.mockResolvedValue({
    title: "Tone",
    artist: "Test",
    formatId: "251",
    acodec: "opus",
  });
  fake.videoInfo.mockResolvedValue({ title: "Tone", thumbnail: "https://i.ytimg.com/vi/x/0.jpg" });
  fake.source = playing(tone);
});

afterEach(() => {
  youtubeGuard.reset();
  vi.restoreAllMocks();
  fake.videoInfo.mockReset();
  fake.audioInfo.mockReset();
  fake.runJson.mockReset();
  fake.sources.length = 0;
  fake.pipelines.length = 0;
});

/** Checks a response is the 502 the app answers with when YouTube refuses. */
function expectRefused(res: request.Response) {
  expect(res.status).toBe(502);
  expect(errorSchemas.limited.parse(res.body)).toEqual({
    message: REFUSED_MESSAGE,
    source: "youtube",
    limited: true,
  });
  expect(res.headers["retry-after"]).toBeUndefined();
  expect(res.headers["content-disposition"]).toBeUndefined();
}

const useFolder = async () =>
  expect((await request(app).put("/api/settings").send({ saveFolder: folder })).status).toBe(200);

/** POST /api/video/save: the progress lines it streams back. */
async function saveLines(body: Record<string, unknown>) {
  const res = await request(app)
    .post("/api/video/save")
    .send(body)
    .buffer(true)
    .parse((response, callback) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (text += chunk));
      response.on("end", () => callback(null, text));
    });
  expect(res.status).toBe(200);
  return String(res.body)
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; [key: string]: unknown });
}

const historyOf = async (url: string) =>
  ((await request(app).get("/api/downloads")).body as { url: string }[]).filter(
    (row) => row.url === url,
  );

/** The history entries for `url`, once there are `count` of them (it's written just after). */
async function waitForHistory(url: string, count: number) {
  for (let i = 0; i < 50; i++) {
    const rows = await historyOf(url);
    if (rows.length >= count) return rows;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return historyOf(url);
}

/** What's in the folder once a failed or cancelled save has tidied up (it does just after). */
async function folderEmptied() {
  for (let i = 0; i < 30 && (await fs.readdir(folder)).length > 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return fs.readdir(folder);
}

/** Settles once every process the last pipeline started has exited (or fails after a while). */
async function pipelineGone() {
  const finished = fake.pipelines.at(-1);
  expect(finished).toBeDefined();
  const ended = await Promise.race([
    finished!.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 15_000)),
  ]);
  expect(ended, "yt-dlp or ffmpeg was left running").toBe(true);
  for (const child of fake.sources) {
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  }
}

/**
 * Starts a real request and hangs up as soon as the first bytes arrive, like
 * pressing Cancel. Resolves once it has (true), or if it ended first (false).
 */
async function cancelPartWay(
  pathAndQuery: string,
  init: { method?: string; json?: unknown } = {},
): Promise<boolean> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await new Promise<boolean>((resolve, reject) => {
      const req = http.request(
        `http://127.0.0.1:${port}${pathAndQuery}`,
        {
          method: init.method ?? "GET",
          headers: init.json === undefined ? {} : { "Content-Type": "application/json" },
        },
        (res) => {
          res.once("data", () => {
            req.destroy();
            resolve(true);
          });
          res.once("end", () => resolve(false));
        },
      );
      req.on("error", (err) =>
        (err as NodeJS.ErrnoException).code === "ECONNRESET" ? null : reject(err),
      );
      req.end(init.json === undefined ? undefined : JSON.stringify(init.json));
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("when YouTube refuses (it's limiting this computer)", () => {
  it("a pasted link's video is answered at once with a 502 that says so", async () => {
    fake.videoInfo.mockRejectedValueOnce(new Error(BOT_CHECK));
    expectRefused(await request(app).post("/api/video/info").send({ url: VIDEO }));
    expect(fake.videoInfo).toHaveBeenCalledTimes(1);
    expect(youtubeGuard.updater.update).toHaveBeenCalledTimes(1); // in the background
  });

  it("…and the very next request still asks YouTube: nothing is held back", async () => {
    fake.videoInfo.mockRejectedValueOnce(new Error(TOO_MANY));
    expectRefused(await request(app).post("/api/video/info").send({ url: VIDEO }));
    const again = await request(app).post("/api/video/info").send({ url: VIDEO });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({
      title: "Tone",
      thumbnail: "https://i.ytimg.com/vi/x/0.jpg",
      url: VIDEO,
    });
    expect(fake.videoInfo).toHaveBeenCalledTimes(2);
  });

  it("a search and a YouTube playlist are answered the same way", async () => {
    fake.runJson.mockRejectedValue(new Error(TOO_MANY));
    expectRefused(await request(app).get("/api/search").query({ q: "daft punk get lucky" }));
    expectRefused(await request(app).get("/api/youtube/playlist").query({ link: PLAYLIST }));
  });

  it("a download refused at its look-up gets the 502, with no file name", async () => {
    fake.audioInfo.mockRejectedValueOnce(new Error(BOT_CHECK));
    expectRefused(await request(app).get("/api/video/download").query({ url: VIDEO }));
    expect(fake.sources).toHaveLength(0); // no stream was started
  });

  it("a download refused when its stream starts gets the 502 too", async () => {
    fake.source = refusing(TOO_MANY);
    expectRefused(await request(app).get("/api/video/download").query({ url: VIDEO }));
    await pipelineGone();
    expect(await historyOf(VIDEO)).toEqual([]);
  });

  it("a save refused, at its look-up or its stream, leaves nothing in the folder", async () => {
    await useFolder();
    fake.audioInfo.mockRejectedValueOnce(new Error(BOT_CHECK));
    expectRefused(await request(app).post("/api/video/save").send({ url: VIDEO }));
    fake.source = refusing(BOT_CHECK);
    expectRefused(await request(app).post("/api/video/save").send({ url: VIDEO }));
    await pipelineGone();
    expect(await folderEmptied()).toEqual([]);
    expect(await historyOf(VIDEO)).toEqual([]);
  });
});

describe("cached answers", () => {
  it("a search asked again is answered from the cache, without asking YouTube", async () => {
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
    const res = await request(app).get("/api/search").query({ q: "Rick  Astley" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ results });
    expect(fake.runJson).not.toHaveBeenCalled();
  });
});

describe("downloads and saves (yt-dlp's stream played by ffmpeg-made audio)", () => {
  it("a download streams an MP3 and is added to the history", async () => {
    const before = (await historyOf(VIDEO)).length;
    const res = await request(app)
      .get("/api/video/download")
      .query({ url: VIDEO })
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("audio/mpeg");
    expect(res.headers["content-disposition"]).toContain("Tone.mp3");
    const file = path.join(dir, "downloaded.mp3");
    await fs.writeFile(file, res.body as Buffer);
    expect((await verifyMp3File(file)).isValid).toBe(true);
    expect(await waitForHistory(VIDEO, before + 1)).toHaveLength(before + 1);
  });

  it("a download cancelled part-way stops both processes and adds nothing to the history", async () => {
    const before = (await historyOf(VIDEO)).length;
    fake.source = playing(tone, { slow: true });
    const url = `/api/video/download?${new URLSearchParams({ url: VIDEO })}`;
    expect(await cancelPartWay(url)).toBe(true);
    await pipelineGone();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await historyOf(VIDEO)).toHaveLength(before);
  });

  it("a save lands in the folder under its name, and is added to the history", async () => {
    await useFolder();
    const before = (await historyOf(VIDEO)).length;
    const lines = await saveLines({ url: VIDEO, name: "Saved tone" });
    expect(lines.at(-1)).toMatchObject({ type: "done", fileName: "Saved tone.mp3" });
    expect((await verifyMp3File(path.join(folder, "Saved tone.mp3"))).isValid).toBe(true);
    expect(await historyOf(VIDEO)).toHaveLength(before + 1);
    await fs.rm(path.join(folder, "Saved tone.mp3"));
  });

  it("a save cancelled part-way stops both processes and leaves no .part file", async () => {
    await useFolder();
    const before = (await historyOf(VIDEO)).length;
    fake.source = playing(tone, { slow: true });
    expect(
      await cancelPartWay("/api/video/save", {
        method: "POST",
        json: { url: VIDEO, name: "Cancelled" },
      }),
    ).toBe(true);
    await pipelineGone();
    expect(await folderEmptied()).toEqual([]);
    expect(await historyOf(VIDEO)).toHaveLength(before);
  });
});

describe("GET /api/health/sources", () => {
  it("reports how the sources have been answering, for anyone", async () => {
    youtubeGuard.pipelineEnded(false, TOO_MANY);
    youtubeGuard.pipelineEnded(true, "");
    const res = await request(app).get("/api/health/sources");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const report = sourceHealthReportSchema.parse(res.body);
    expect(report.sources.youtube).toMatchObject({
      role: "primary",
      for: "audio",
      lastError: TOO_MANY,
    });
    expect(report.sources.youtube.throttled).toBeGreaterThanOrEqual(1);
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
