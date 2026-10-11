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
import { soundCloudCache } from "../../server/search";
import { PREVIEW_ONLY } from "../../server/soundcloud";
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
  /** Every stand-in started, the link each was given, and how each pipeline ended. */
  sources: [] as ChildProcessWithoutNullStreams[],
  links: [] as string[],
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
        spawnSource: (link) => {
          const child = fake.source!();
          fake.sources.push(child);
          fake.links.push(link);
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
// A SoundCloud track: its canonical link, and the URN form yt-dlp's search lists it by.
const TRACK = "https://api.soundcloud.com/tracks/254112129";
const TRACK_URN = "https://api.soundcloud.com/tracks/soundcloud%3Atracks%3A254112129";
/** What yt-dlp's SoundCloud search lists (the shape the owner's PC saw; see soundcloud.test.ts). */
const SOUNDCLOUD_ENTRIES = [
  { title: "One More Time", uploader: "Daft Punk", duration: 30.0, url: TRACK_URN },
  {
    title: "One More Time",
    uploader: "Daft Punk",
    duration: 320.403,
    url: "https://api.soundcloud.com/tracks/soundcloud%3Atracks%3A300000002",
  },
];
const YOUTUBE_ENTRIES = [
  {
    id: "dQw4w9WgXcQ",
    title: "Daft Punk - One More Time (Official Audio)",
    duration: 320,
    channel: "Daft Punk",
    channel_is_verified: true,
  },
];
const isYouTubeSearch = (args: string[]) => args.at(-1)!.startsWith("ytsearch");
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
  soundCloudCache.clear();
  vi.restoreAllMocks();
  fake.videoInfo.mockReset();
  fake.audioInfo.mockReset();
  fake.runJson.mockReset();
  fake.sources.length = 0;
  fake.links.length = 0;
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

  it("a YouTube playlist is answered the same way", async () => {
    fake.runJson.mockRejectedValue(new Error(TOO_MANY));
    expectRefused(await request(app).get("/api/youtube/playlist").query({ link: PLAYLIST }));
  });

  it("a search is answered from SoundCloud instead, at once", async () => {
    fake.runJson.mockImplementation(async (args: string[]) => {
      if (isYouTubeSearch(args)) throw new Error(TOO_MANY);
      return { entries: SOUNDCLOUD_ENTRIES };
    });
    const res = await request(app).get("/api/search").query({ q: "daft punk one more time" });
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("soundcloud");
    expect(res.body.results).toEqual([
      expect.objectContaining({
        url: "https://api.soundcloud.com/tracks/300000002",
        duration: 320,
        source: "soundcloud",
      }),
      // The 30-second preview, last.
      expect.objectContaining({ url: TRACK, duration: 30, source: "soundcloud" }),
    ]);
  });

  it("…and the next search asks YouTube and SoundCloud at once, using YouTube's results if it has some", async () => {
    fake.videoInfo.mockRejectedValueOnce(new Error(TOO_MANY));
    expectRefused(await request(app).post("/api/video/info").send({ url: VIDEO }));
    fake.runJson.mockImplementation(async (args: string[]) =>
      isYouTubeSearch(args) ? { entries: YOUTUBE_ENTRIES } : { entries: SOUNDCLOUD_ENTRIES },
    );
    const res = await request(app).get("/api/search").query({ q: "daft punk one more time" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      source: "youtube",
      results: [{ id: "dQw4w9WgXcQ", source: "youtube" }],
    });
    expect(fake.runJson.mock.calls.map(([args]) => (args as string[]).at(-1))).toEqual([
      "scsearch12:daft punk one more time",
      "ytsearch12:daft punk one more time",
    ]);
  });

  it("a search neither source can answer says so, without telling you to wait for the app", async () => {
    fake.runJson.mockRejectedValue(new Error(TOO_MANY));
    const res = await request(app).get("/api/search").query({ q: "daft punk get lucky" });
    expect(res.status).toBe(502);
    expect(errorSchemas.limited.parse(res.body)).toMatchObject({
      source: "youtube",
      limited: true,
    });
    expect(res.body.message).toMatch(/SoundCloud couldn't be searched either/);
    expect(res.body.message).not.toMatch(/try again in/i);
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
    expect(res.body).toEqual({ results, source: "youtube" });
    expect(fake.runJson).not.toHaveBeenCalled();
  });
});

describe("SoundCloud", () => {
  const trackInfo = { title: "One More Time", artist: "Daft Punk", formatId: "http_mp3_1_0" };

  it("?source=soundcloud searches SoundCloud alone", async () => {
    fake.runJson.mockResolvedValue({ entries: SOUNDCLOUD_ENTRIES });
    const res = await request(app)
      .get("/api/search")
      .query({ q: "daft punk one more time", source: "soundcloud" });
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("soundcloud");
    expect(fake.runJson).toHaveBeenCalledTimes(1);
    expect(fake.runJson.mock.calls[0][0].at(-1)).toBe("scsearch12:daft punk one more time");
    const wrong = await request(app).get("/api/search").query({ q: "x", source: "youtube" });
    expect(wrong.status).toBe(400);
    expect(wrong.body).toEqual({ message: 'source must be "soundcloud"', field: "source" });
  });

  it("a track downloads through the same pipeline, by its canonical link, into the history", async () => {
    fake.audioInfo.mockResolvedValue(trackInfo);
    const res = await request(app)
      .get("/api/video/download")
      .query({ url: TRACK_URN })
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain("One More Time.mp3");
    // Only the canonical link reached yt-dlp, for the look-up and the stream.
    expect(fake.audioInfo).toHaveBeenCalledWith(TRACK);
    expect(fake.links).toEqual([TRACK]);
    const file = path.join(dir, "soundcloud.mp3");
    await fs.writeFile(file, res.body as Buffer);
    expect((await verifyMp3File(file)).isValid).toBe(true);
    const [entry] = await waitForHistory(TRACK_URN, 1);
    expect(entry).toMatchObject({ title: "One More Time", source: "soundcloud" });
  });

  it("a track SoundCloud only previews is refused before anything starts", async () => {
    fake.audioInfo.mockResolvedValue({ ...trackInfo, formatId: "http_mp3_1_0_preview" });
    const download = await request(app).get("/api/video/download").query({ url: TRACK });
    expect(download.status).toBe(500);
    expect(download.text).toBe(PREVIEW_ONLY);
    await useFolder();
    const save = await request(app).post("/api/video/save").send({ url: TRACK });
    expect(save.status).toBe(502);
    expect(save.body.message).toBe(`Couldn't download the audio: ${PREVIEW_ONLY}`);
    expect(fake.sources).toHaveLength(0);
    expect(await fs.readdir(folder)).toEqual([]);
  });

  it("a track saves into the folder, and is remembered as SoundCloud's", async () => {
    await useFolder();
    fake.audioInfo.mockResolvedValue(trackInfo);
    const lines = await saveLines({ url: TRACK, name: "Daft Punk - One More Time" });
    expect(lines.at(-1)).toMatchObject({ type: "done", fileName: "Daft Punk - One More Time.mp3" });
    expect(fake.links).toEqual([TRACK]);
    const saved = path.join(folder, "Daft Punk - One More Time.mp3");
    expect((await verifyMp3File(saved)).isValid).toBe(true);
    expect((await historyOf(TRACK)).at(0)).toMatchObject({ source: "soundcloud" });
    await fs.rm(saved);
  });

  it("a track's save cancelled part-way stops both processes and leaves no .part file", async () => {
    await useFolder();
    fake.audioInfo.mockResolvedValue(trackInfo);
    fake.source = playing(tone, { slow: true });
    const before = (await historyOf(TRACK)).length;
    expect(
      await cancelPartWay("/api/video/save", {
        method: "POST",
        json: { url: TRACK, name: "Cancelled track" },
      }),
    ).toBe(true);
    await pipelineGone();
    expect(await folderEmptied()).toEqual([]);
    expect(await historyOf(TRACK)).toHaveLength(before);
  });

  it("anything but a YouTube video or a canonical track never reaches yt-dlp", async () => {
    await useFolder();
    for (const url of [
      "https://soundcloud.com.evil.example/daftpunk/one-more-time",
      "https://evil.example/soundcloud.com/daftpunk/one-more-time",
      "https://user:password@api.soundcloud.com/tracks/254112129",
      "http://api.soundcloud.com/tracks/254112129",
      "https://soundcloud.com/daftpunkofficialmusic/sets/discovery",
      "https://soundcloud.com/daftpunkofficialmusic",
      "https://api.soundcloud.com/tracks/soundcloud%253Atracks%253A254112129",
      "https://api.soundcloud.com/tracks/254112129?secret_token=s-x",
      "--exec=calc",
    ]) {
      const download = await request(app).get("/api/video/download").query({ url });
      expect(download.status, url).toBe(400);
      expect(download.text).toBe("Invalid or missing YouTube or SoundCloud link");
      const save = await request(app).post("/api/video/save").send({ url });
      expect(save.status, url).toBe(400);
      expect(save.body).toEqual({
        message: "Invalid or missing YouTube or SoundCloud link",
        field: "url",
      });
    }
    expect(fake.audioInfo).not.toHaveBeenCalled();
    expect(fake.sources).toHaveLength(0);
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
    expect(report.sources.soundcloud).toMatchObject({ role: "fallback", for: "audio" });
    // SoundCloud's searches, look-ups and streams in the tests above were recorded.
    expect(report.sources.soundcloud.ok).toBeGreaterThanOrEqual(1);
    expect(Object.keys(report.sources).sort()).toEqual([
      "soundcloud",
      "spotify",
      "spotify-oembed",
      "youtube",
    ]);
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
