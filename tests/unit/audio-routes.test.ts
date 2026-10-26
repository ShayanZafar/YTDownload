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
import { spotifyTrackCache } from "../../server/spotify";
import { FFMPEG_PATH } from "../../server/audio";
import { readDetailsLog } from "../../server/details-log";
import {
  markBeingSaved,
  removeLeftoverSaves,
  saveRetry,
  unfinishedSavesFile,
} from "../../server/save";
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
  /** What plays yt-dlp's audio stream for the next download or save (given its link). */
  source: undefined as undefined | ((link: string) => ChildProcessWithoutNullStreams),
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
          const child = fake.source!(link);
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

// A download's cover comes from YouTube's thumbnails, Spotify or SoundCloud
// (server/cover.ts): none here, so nothing leaves this computer.
const coverFor = vi.hoisted(() => vi.fn(async () => undefined));
const fetchCover = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../server/cover", () => ({ coverFor, fetchCover }));

// The music catalogues (iTunes, Deezer: server/catalogues.ts), asked for a
// download's genre while it downloads: a stand-in that has nothing, unless a test says so.
const lookUpSong = vi.hoisted(() => vi.fn(async () => null as unknown));
vi.mock("../../server/catalogues", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../server/catalogues")>()),
  lookUpSong,
}));

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

// A Spotify song (Queen – Bohemian Rhapsody), as Spotify's own pages describe it.
const SONG = "4u7EnebtmKWzUH433cf5Qv";
const SONG_LINK = `https://open.spotify.com/track/${SONG}?si=9f0c1d2e3a4b5c6d`;
/** The song's embed page: its title, artists and length (354.32 s). */
const songEmbedPage = `<!DOCTYPE html><html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
  {
    props: {
      pageProps: {
        state: {
          data: {
            entity: {
              type: "track",
              name: "Bohemian Rhapsody - Remastered 2011",
              id: SONG,
              artists: [{ name: "Queen", uri: "spotify:artist:1dfeR4HaWDbWqFHLkxsg1d" }],
              duration: 354320,
            },
          },
        },
      },
    },
    page: "/track/[id]",
  },
)}</script></body></html>`;
/** The song's own page, as Spotify sends it to a link preview: its album details. */
const songPage = `<html><head>
  <meta property="og:description" content="Queen · A Night At The Opera (2011 Remaster) · Song · 1975"/>
  <meta name="music:album:track" content="11"/>
  <meta name="music:release_date" content="1975-11-21"/>
</head></html>`;
/** YouTube's search for the song: the official video (with an intro) first, the same-length upload after. */
const SONG_ENTRIES = [
  {
    id: "fJ9rUzIMcZQ",
    title: "Queen – Bohemian Rhapsody (Official Video Remastered)",
    duration: 412,
    channel: "Queen Official",
    channel_is_verified: true,
  },
  {
    id: "yk3prd8GER4",
    title: "Bohemian Rhapsody (Remastered 2011)",
    duration: 355,
    channel: "Queen - Topic",
  },
];

/** Spotify played by a stand-in: the song's embed page and its own page; nothing else. */
function standInSpotify() {
  const fetch = vi.fn(async (url: string) => {
    if (url === `https://open.spotify.com/embed/track/${SONG}`) return new Response(songEmbedPage);
    if (url === `https://open.spotify.com/track/${SONG}`) return new Response(songPage);
    throw new TypeError(`fetch failed: nothing stands in for ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

// music-metadata is ESM-only and types parseFile under the "node" condition only (see library.ts).
type Tags = {
  common: { title?: string; artist?: string; album?: string; track: { no: number | null } };
  native: Record<string, { id: string; value: unknown }[]>;
};
const readTags = async (file: string): Promise<Tags> => {
  const mm = (await import("music-metadata")) as unknown as {
    parseFile: (file: string) => Promise<Tags>;
  };
  return mm.parseFile(file);
};
const BOT_CHECK = "Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies";
const TOO_MANY = "HTTP Error 429: Too Many Requests";

// The stand-in for yt-dlp's stream: writes a file to stdout — all at once, or
// a burst and then a piece at a time: 4 KB every 200 ms (slow enough to cancel
// part-way), or 32 KB every 50 ms (steady: about half a second in all).
const PLAY = `
const fs = require("fs");
const [file, burst, piece, everyMs] = process.argv.slice(1).map((v, i) => (i ? Number(v) : v));
const data = fs.readFileSync(file);
let at = Math.min(burst, data.length);
process.stdout.write(data.subarray(0, at));
if (at < data.length) {
  const timer = setInterval(() => {
    process.stdout.write(data.subarray(at, at + piece));
    at += piece;
    if (at >= data.length) clearInterval(timer);
  }, everyMs);
}`;
const playing =
  (file: string, { slow = false, steady = false } = {}) =>
  () =>
    spawn(
      process.execPath,
      [
        "-e",
        PLAY,
        file,
        ...(slow ? [64 * 1024, 4096, 200] : steady ? [16 * 1024, 32 * 1024, 50] : [1e9, 0, 0]).map(
          String,
        ),
      ],
      { windowsHide: true },
    );
/** yt-dlp when the source stops sending part-way, without hanging up: a burst, then nothing. */
const stalling = (file: string) => () =>
  spawn(
    process.execPath,
    [
      "-e",
      `process.stdout.write(require("fs").readFileSync(process.argv[1]).subarray(0, 64 * 1024)); setInterval(() => {}, 1000);`,
      file,
    ],
    { windowsHide: true },
  );
/** Plays each of these stand-ins in turn, one per stream started. */
const inTurn =
  (...sources: (() => ChildProcessWithoutNullStreams)[]) =>
  () =>
    sources.shift()!();
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
let registerRoutes: typeof import("../../server/routes").registerRoutes;
let dir: string;
let folder: string;
let tone: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-routes-"));
  process.env.HISTORY_FILE = path.join(dir, "history.json");
  process.env.SETTINGS_FILE = path.join(dir, "settings.json");
  process.env.SOURCE_HEALTH_FILE = path.join(dir, "source-health.json");
  process.env.DETAILS_LOG_FILE = path.join(dir, "details.log");
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

  ({ registerRoutes } = await import("../../server/routes"));
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
  delete process.env.DETAILS_LOG_FILE;
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
  spotifyTrackCache.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  coverFor.mockClear();
  lookUpSong.mockReset();
  lookUpSong.mockResolvedValue(null);
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
    const artwork = "https://i1.sndcdn.com/artworks-abc-t500x500.jpg";
    fake.audioInfo.mockResolvedValue({ ...trackInfo, artwork });
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
    // Its cover is its artwork (a YouTube video's is its thumbnail: see the next test).
    expect(coverFor).toHaveBeenCalledWith({ kind: "soundcloud", url: artwork }, undefined);
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
    // "Tone" by the channel "Test": named "Artist - Title".
    expect(res.headers["content-disposition"]).toContain("Test - Tone.mp3");
    const file = path.join(dir, "downloaded.mp3");
    await fs.writeFile(file, res.body as Buffer);
    expect((await verifyMp3File(file)).isValid).toBe(true);
    expect(await waitForHistory(VIDEO, before + 1)).toHaveLength(before + 1);
    expect(coverFor).toHaveBeenCalledWith({ kind: "youtube", videoId: "dQw4w9WgXcQ" }, undefined);
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

  it("a save not renamed on the page is named “Artist - Title” and tagged with the artist the video names", async () => {
    await useFolder();
    // A channel that uploads other people's songs: the artist is the one the title names.
    fake.audioInfo.mockResolvedValue({
      title: "Paul van Dyk - For An Angel (Official Video) HQ",
      artist: "Trance Classics",
      formatId: "251",
      acodec: "opus",
    });
    let lines = await saveLines({ url: VIDEO });
    expect(lines.at(-1)).toMatchObject({
      type: "done",
      fileName: "Paul van Dyk - For An Angel.mp3",
    });
    let file = path.join(folder, "Paul van Dyk - For An Angel.mp3");
    expect((await readTags(file)).common).toMatchObject({
      title: "For An Angel",
      artist: "Paul van Dyk",
    });
    await fs.rm(file);

    // YouTube Music's own upload: the title is the song, the channel its artist.
    fake.audioInfo.mockResolvedValue({
      title: "Numb",
      artist: "Linkin Park - Topic",
      formatId: "251",
      acodec: "opus",
    });
    lines = await saveLines({ url: VIDEO });
    expect(lines.at(-1)).toMatchObject({ type: "done", fileName: "Linkin Park - Numb.mp3" });
    file = path.join(folder, "Linkin Park - Numb.mp3");
    expect((await readTags(file)).common).toMatchObject({ title: "Numb", artist: "Linkin Park" });
    await fs.rm(file);
  });

  it("a saved download is found in the folder from the history, and isn't once it's gone", async () => {
    await useFolder();
    const lines = await saveLines({ url: VIDEO, name: "Found again" });
    expect(lines.at(-1)).toMatchObject({ type: "done", fileName: "Found again.mp3" });
    const [entry] = await historyOf(VIDEO);
    expect(entry).toMatchObject({ fileName: "Found again.mp3" });
    const id = (entry as unknown as { id: number }).id;

    // Moved into a subfolder, it's still found, as the song the player lists.
    await fs.mkdir(path.join(folder, "Sorted"));
    await fs.rename(
      path.join(folder, "Found again.mp3"),
      path.join(folder, "Sorted", "Found again.mp3"),
    );
    const found = await request(app).get("/api/downloads/in-folder");
    expect(found.status).toBe(200);
    expect(found.body).toMatchObject({ folder, complete: true });
    const song = found.body.found[id];
    expect(song).toMatchObject({ file: path.join("Sorted", "Found again.mp3"), by: "file" });
    const music = await request(app).get("/api/music");
    expect(music.body.tracks.find((t: { id: string }) => t.id === song.song)).toMatchObject({
      path: path.join("Sorted", "Found again.mp3"),
    });
    expect((await request(app).get(`/api/music/${song.song}`)).status).toBe(200);

    // Gone from the folder: no longer found.
    await fs.rm(path.join(folder, "Sorted"), { recursive: true });
    const gone = await request(app).get("/api/downloads/in-folder");
    expect(gone.body.found[id]).toBeUndefined();
  });

  it("a save gets the genre and album the catalogues have for it, keeping its own title", async () => {
    await useFolder();
    fake.audioInfo.mockResolvedValue({
      title: "Tone",
      artist: "Test",
      formatId: "251",
      acodec: "opus",
      duration: 3,
    });
    lookUpSong.mockResolvedValue({
      source: "itunes",
      song: {
        title: "Tone (Remastered)",
        artist: "Test",
        album: "Pure Tones",
        genre: "Electronic",
        year: 1999,
        track: 4,
      },
    });
    const lines = await saveLines({ url: VIDEO, name: "Looked up" });
    expect(lines.at(-1)).toMatchObject({ type: "done", fileName: "Looked up.mp3" });
    expect(lookUpSong).toHaveBeenCalledWith({ title: "Tone", artist: "Test", duration: 3 });
    const file = path.join(folder, "Looked up.mp3");
    expect((await verifyMp3File(file)).isValid).toBe(true);
    const { common, native } = await readTags(file);
    expect(common).toMatchObject({
      title: "Tone",
      artist: "Test",
      album: "Pure Tones",
      track: { no: 4 },
    });
    const frames = Object.fromEntries(native["ID3v2.3"].map(({ id, value }) => [id, value]));
    expect(frames).toMatchObject({ TCON: "Electronic", TYER: "1999" });
    // The details log says what it got.
    expect((await readDetailsLog()).split("\n").at(-1)).toMatch(
      /download {2}Looked up {2}added: genre Electronic; album Pure Tones; date 1999; track 4$/,
    );
    await fs.rm(file);
  });

  it("a save and a download go ahead with their own tags when the catalogues fail", async () => {
    await useFolder();
    lookUpSong.mockRejectedValue(new Error("Couldn't reach the music catalogues"));
    const lines = await saveLines({ url: VIDEO, name: "Not looked up" });
    expect(lines.at(-1)).toMatchObject({ type: "done", fileName: "Not looked up.mp3" });
    const file = path.join(folder, "Not looked up.mp3");
    expect((await verifyMp3File(file)).isValid).toBe(true);
    const { common, native } = await readTags(file);
    expect(common).toMatchObject({ title: "Tone", artist: "Test" });
    expect(native["ID3v2.3"].map(({ id }) => id)).not.toContain("TCON");
    expect((await readDetailsLog()).split("\n").at(-1)).toMatch(
      /download {2}Not looked up {2}nothing added: Couldn't reach the music catalogues$/,
    );
    await fs.rm(file);

    const res = await request(app)
      .get("/api/video/download")
      .query({ url: VIDEO })
      .buffer(true)
      .parse((r, done) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => done(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    const downloaded = path.join(folder, "Downloaded.mp3");
    await fs.writeFile(downloaded, res.body as Buffer);
    expect((await verifyMp3File(downloaded)).isValid).toBe(true);
    expect((await readTags(downloaded)).common.title).toBe("Tone");
    await fs.rm(downloaded);
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

describe("a save whose stream stalls, breaks off or comes up short", () => {
  beforeEach(() => {
    saveRetry.stallMs = 1_000;
  });
  afterEach(() => {
    saveRetry.stallMs = 60_000;
  });

  it("is tried again at once, and the whole song is saved, with no .part file left", async () => {
    await useFolder();
    fake.source = inTurn(stalling(tone), playing(tone));
    const lines = await saveLines({ url: VIDEO, name: "Stalled once" });
    expect(lines.at(-1)).toMatchObject({ type: "done", fileName: "Stalled once.mp3" });
    expect(fake.sources).toHaveLength(2);
    const file = path.join(folder, "Stalled once.mp3");
    expect((await verifyMp3File(file)).isValid).toBe(true);
    expect(await fs.readdir(folder)).toEqual(["Stalled once.mp3"]);
    await fs.rm(file);
  });

  it("fails saying the source stopped sending, once it has stalled every time", async () => {
    await useFolder();
    const before = (await historyOf(VIDEO)).length;
    fake.source = inTurn(stalling(tone), stalling(tone));
    const lines = await saveLines({ url: VIDEO, name: "Stalled" });
    expect(lines.at(-1)).toEqual({
      type: "error",
      message:
        "Couldn't download the audio: YouTube stopped sending the audio (nothing for 1 s) (tried 2 times)",
    });
    expect(fake.sources).toHaveLength(2);
    await pipelineGone();
    expect(await folderEmptied()).toEqual([]);
    expect(await historyOf(VIDEO)).toHaveLength(before);
  });

  it("fails saying where it stopped, when the audio comes up short of the video every time", async () => {
    await useFolder();
    // The video is a minute long; what arrives is the 20-second tone.
    fake.audioInfo.mockResolvedValue({
      title: "Tone",
      artist: "Test",
      formatId: "251",
      acodec: "opus",
      duration: 60,
    });
    fake.source = inTurn(playing(tone), playing(tone));
    const lines = await saveLines({ url: VIDEO, name: "Short" });
    expect(lines.at(-1)).toEqual({
      type: "error",
      message: "Couldn't download the audio: it stopped at 0:20 of 1:00 (tried 2 times)",
    });
    expect(await folderEmptied()).toEqual([]);
  });

  it("a song that doesn't stall or come up short is fetched once", async () => {
    await useFolder();
    fake.audioInfo.mockResolvedValue({
      title: "Tone",
      artist: "Test",
      formatId: "251",
      acodec: "opus",
      duration: 20,
    });
    fake.source = playing(tone, { steady: true });
    const lines = await saveLines({ url: VIDEO, name: "Whole" });
    expect(lines.at(-1)).toMatchObject({ type: "done", fileName: "Whole.mp3" });
    expect(fake.sources).toHaveLength(1);
    await fs.rm(path.join(folder, "Whole.mp3"));
  });
});

describe("saves an app closed part-way left behind", () => {
  it("a save in progress is noted, until it's done with", async () => {
    const part = path.join(folder, "Noted.mp3.part");
    const noted = async () =>
      JSON.parse(await fs.readFile(unfinishedSavesFile(), "utf8").catch(() => "[]")) as string[];
    const done = markBeingSaved(part);
    await expect.poll(noted).toEqual([part]);
    done();
    await expect.poll(noted).toEqual([]);
  });

  it("their .part files are deleted when the app starts again, and nothing else", async () => {
    const left = path.join(folder, "Left behind.mp3.part");
    const notOurs = path.join(folder, "A browser's download.mp3.part");
    await fs.writeFile(left, "half a song");
    await fs.writeFile(notOurs, "someone else's");
    await fs.writeFile(
      unfinishedSavesFile(),
      JSON.stringify([left, path.join(folder, "Already gone.mp3.part")]),
    );
    // The app starting again.
    const restarted = express();
    await registerRoutes(createServer(restarted), restarted);
    expect(await fs.readdir(folder)).toEqual(["A browser's download.mp3.part"]);
    expect(JSON.parse(await fs.readFile(unfinishedSavesFile(), "utf8"))).toEqual([]);
    // Nothing noted (or a damaged note): nothing to remove.
    await fs.writeFile(unfinishedSavesFile(), "not json");
    await expect(removeLeftoverSaves()).resolves.toEqual([]);
    await fs.rm(notOurs);
  });
});

describe("several saves at once (Download all runs one per CPU core)", () => {
  it("tells the page how many: one per CPU core of this computer", async () => {
    const settings = await request(app).get("/api/settings");
    expect(settings.body.cpuCores).toBe(os.availableParallelism());
    const chosen = await request(app).put("/api/settings").send({ saveFolder: folder });
    expect(chosen.body).toMatchObject({ saveFolder: folder, cpuCores: os.availableParallelism() });
  });

  it("saves under the same name at once land as separate files, neither replacing the other", async () => {
    await useFolder();
    await fs.writeFile(path.join(folder, "Same name.mp3"), "someone else's");
    const before = (await historyOf(VIDEO)).length;
    const saved = await Promise.all(
      Array.from({ length: 4 }, () => saveLines({ url: VIDEO, name: "Same name" })),
    );
    const names = saved.map((lines) => String(lines.at(-1)!.fileName)).sort();
    expect(names).toEqual([
      "Same name (1).mp3",
      "Same name (2).mp3",
      "Same name (3).mp3",
      "Same name (4).mp3",
    ]);
    for (const name of names) {
      expect((await verifyMp3File(path.join(folder, name))).isValid, name).toBe(true);
    }
    // What was there is untouched, and nothing else is left: no .part file, no empty name.
    expect(await fs.readFile(path.join(folder, "Same name.mp3"), "utf8")).toBe("someone else's");
    expect((await fs.readdir(folder)).sort()).toEqual(["Same name.mp3", ...names].sort());
    expect(await waitForHistory(VIDEO, before + 4)).toHaveLength(before + 4);
    await Promise.all(["Same name.mp3", ...names].map((name) => fs.rm(path.join(folder, name))));
  });

  it("a save cancelled while another goes on stops only its own processes", async () => {
    await useFolder();
    const OTHER = "https://www.youtube.com/watch?v=jNQXAC9IVRw";
    // The one to cancel streams slowly; the other steadily, for about half a second.
    fake.source = (link) => playing(tone, link === VIDEO ? { slow: true } : { steady: true })();
    const other = saveLines({ url: OTHER, name: "Carries on" });
    expect(
      await cancelPartWay("/api/video/save", {
        method: "POST",
        json: { url: VIDEO, name: "Cancelled" },
      }),
    ).toBe(true);
    // The cancelled one's processes are gone…
    const cancelled = fake.pipelines[fake.links.indexOf(VIDEO)];
    expect(
      await Promise.race([
        cancelled.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 15_000)),
      ]),
      "yt-dlp or ffmpeg was left running",
    ).toBe(true);
    // …and the other save finishes whole.
    const lines = await other;
    expect(lines.at(-1)).toMatchObject({ type: "done", fileName: "Carries on.mp3" });
    expect((await verifyMp3File(path.join(folder, "Carries on.mp3"))).isValid).toBe(true);
    expect(await fs.readdir(folder)).toEqual(["Carries on.mp3"]);
    await fs.rm(path.join(folder, "Carries on.mp3"));
  });
});

describe("a Spotify song link (Spotify played by a stand-in fetch)", () => {
  it("is looked up on Spotify, then found on YouTube, the same-length upload first", async () => {
    const fetch = standInSpotify();
    fake.runJson.mockResolvedValue({ entries: SONG_ENTRIES });
    const res = await request(app).get("/api/search").query({ q: SONG_LINK });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.spotify).toMatchObject({
      id: SONG,
      url: `https://open.spotify.com/track/${SONG}`,
      title: "Bohemian Rhapsody - Remastered 2011",
      artists: ["Queen"],
      duration: 354,
    });
    expect(res.body.source).toBe("youtube");
    expect(res.body.results.map((r: { id: string }) => r.id)).toEqual([
      "yk3prd8GER4",
      "fJ9rUzIMcZQ",
    ]);
    // YouTube is asked for the song by its artist and title, never for the link…
    expect(fake.runJson).toHaveBeenCalledTimes(1);
    expect(fake.runJson.mock.calls[0][0].at(-1)).toBe("ytsearch12:Queen Bohemian Rhapsody audio");
    // …and Spotify only for the song's own embed page, built from its id (not the link pasted).
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      `https://open.spotify.com/embed/track/${SONG}`,
    ]);
  });

  it("its download is tagged with Spotify's title, artists, album and song id", async () => {
    standInSpotify();
    const before = (await historyOf(VIDEO)).length;
    const res = await request(app)
      .get("/api/video/download")
      .query({ url: VIDEO, spotifyId: SONG, name: "Queen - Bohemian Rhapsody" })
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain("Queen - Bohemian Rhapsody.mp3");
    const file = path.join(dir, "spotify-song.mp3");
    await fs.writeFile(file, res.body as Buffer);
    expect((await verifyMp3File(file)).isValid).toBe(true);
    const { common, native } = await readTags(file);
    expect(common).toMatchObject({
      title: "Bohemian Rhapsody",
      artist: "Queen",
      album: "A Night At The Opera (2011 Remaster)",
      track: { no: 11 },
    });
    expect(native["ID3v2.3"]).toContainEqual({ id: "TXXX:spotify_id", value: SONG });
    const rows = await waitForHistory(VIDEO, before + 1);
    expect(rows[0]).toMatchObject({ spotifyId: SONG, title: "Tone" });
  });

  it("a link that isn't a song is turned down, without asking Spotify or YouTube", async () => {
    const fetch = standInSpotify();
    const res = await request(app)
      .get("/api/search")
      .query({ q: "https://open.spotify.com/artist/1dfeR4HaWDbWqFHLkxsg1d" });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe("q");
    expect(fetch).not.toHaveBeenCalled();
    expect(fake.runJson).not.toHaveBeenCalled();
  });
});

describe("a YouTube playlist (yt-dlp's listing played by a stand-in)", () => {
  const LIST = "PLbpi6ZahtOH6Blw3RGYpWkSByi_T7Rygb";
  const flatPlaylist = {
    _type: "playlist",
    id: LIST,
    title: "Road Trip",
    channel: "Moomoo",
    playlist_count: 2,
    thumbnails: [{ url: "https://i.ytimg.com/pl/large.jpg", width: 480 }],
    entries: [
      { _type: "url", id: "jNQXAC9IVRw", title: "Me at the zoo", duration: 19.0, channel: "jawed" },
      {
        _type: "url",
        id: "fJ9rUzIMcZQ",
        title: "Queen – Bohemian Rhapsody (Official Video Remastered)",
        duration: 359.0,
        channel: "Queen Official",
      },
    ],
  };

  it("lists its videos for the panel, asking yt-dlp for the playlist's own link only", async () => {
    fake.runJson.mockResolvedValue(flatPlaylist);
    const res = await request(app)
      .get("/api/youtube/playlist")
      .query({ link: `youtube.com/playlist?list=${LIST}&si=shared` });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      source: "youtube",
      kind: "playlist",
      id: LIST,
      url: `https://www.youtube.com/playlist?list=${LIST}`,
      name: "Road Trip",
      by: "Moomoo",
    });
    expect(res.body.tracks).toEqual([
      expect.objectContaining({
        id: "jNQXAC9IVRw",
        url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
        title: "Me at the zoo",
        artists: "jawed",
        duration: 19,
      }),
      expect.objectContaining({ id: "fJ9rUzIMcZQ", artists: "Queen Official", duration: 359 }),
    ]);
    const args = fake.runJson.mock.calls[0][0] as string[];
    expect(args).toContain("--flat-playlist");
    expect(args.slice(-2)).toEqual(["--", `https://www.youtube.com/playlist?list=${LIST}`]);

    // Opened again soon after: the same answer, without asking YouTube again.
    const again = await request(app).get("/api/youtube/playlist").query({ link: res.body.url });
    expect(again.body).toEqual(res.body);
    expect(fake.runJson).toHaveBeenCalledTimes(1);
  });

  it("a link that isn't a playlist it can open is explained, without asking YouTube", async () => {
    const res = await request(app)
      .get("/api/youtube/playlist")
      .query({ link: "https://www.youtube.com/playlist?list=WL" });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/only you can see/);
    expect(fake.runJson).not.toHaveBeenCalled();
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
      "spotify-account",
      "spotify-oembed",
      "spotify-web-api",
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
