import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import http, { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import request from "supertest";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { verifyMp3File } from "../utils/mp3";
import { verifyOriginalAudioFile } from "../utils/original-audio";

// Stable, public, non-restricted test video:
// "Me at the zoo" - the very first video uploaded to YouTube (April 2005).
// 19 seconds long, ~150KB of audio, kept up by Google as historical archive.
const TEST_VIDEO_URL = "https://www.youtube.com/watch?v=jNQXAC9IVRw";

let httpServer: Server;
let app: express.Express;
let historyDir: string;

beforeAll(async () => {
  // Keep test downloads out of your real history and settings: point the
  // app's files at a throwaway folder for this run.
  historyDir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-history-"));
  process.env.HISTORY_FILE = path.join(historyDir, "history.json");
  process.env.SETTINGS_FILE = path.join(historyDir, "settings.json");

  // Mirror the minimum middleware stack that server/index.ts sets up,
  // so we can attach Supertest to the real route handlers without starting
  // a Vite dev server.
  const { registerRoutes } = await import("../../server/routes");

  app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  httpServer = createServer(app);
  await registerRoutes(httpServer, app);
});

afterAll(async () => {
  delete process.env.HISTORY_FILE;
  delete process.env.SETTINGS_FILE;
  await fs.rm(historyDir, { recursive: true, force: true });
});

type HistoryRow = { id: number; url: string; title: string };

const historyFor = async (url: string): Promise<HistoryRow[]> => {
  const res = await request(app).get("/api/downloads");
  expect(res.status).toBe(200);
  return (res.body as HistoryRow[]).filter((row) => row.url === url);
};

// The history entry is saved just after the file finishes sending, so give it a moment.
const waitForHistory = async (url: string, count: number, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  let rows = await historyFor(url);
  while (rows.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    rows = await historyFor(url);
  }
  return rows;
};

describe("YouTube → MP3 end-to-end (API)", () => {
  it("rejects an invalid YouTube URL on /api/video/info", async () => {
    const res = await request(app)
      .post("/api/video/info")
      .send({ url: "https://example.com/not-a-video" })
      .set("content-type", "application/json");

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("message");
  });

  it("returns title and thumbnail metadata for a real YouTube URL", async () => {
    const res = await request(app)
      .post("/api/video/info")
      .send({ url: TEST_VIDEO_URL })
      .set("content-type", "application/json");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      url: TEST_VIDEO_URL,
      title: expect.any(String),
      thumbnail: expect.any(String),
    });
    expect(res.body.title.length).toBeGreaterThan(0);
    expect(res.body.thumbnail).toMatch(/^https?:\/\//);
  });

  it("finds a video by searching for its title on /api/search", async () => {
    const res = await request(app).get("/api/search").query({ q: "me at the zoo jawed" });

    expect(res.status).toBe(200);
    const results = res.body.results as { id: string; url: string; title: string }[];
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(8);
    const zoo = results.find((r) => r.id === "jNQXAC9IVRw");
    expect(
      zoo,
      `"Me at the zoo" missing from: ${results.map((r) => r.title).join(" | ")}`,
    ).toMatchObject({
      url: TEST_VIDEO_URL,
      title: expect.stringMatching(/me at the zoo/i),
      channel: expect.any(String),
      duration: expect.any(Number),
      thumbnail: expect.stringMatching(/^https:\/\//),
      official: expect.any(Boolean),
    });
  });

  it("finds the YouTube upload of a Spotify song link on /api/search", async () => {
    // Queen – Bohemian Rhapsody (Remastered 2011), 5:54 on Spotify.
    const res = await request(app)
      .get("/api/search")
      .query({ q: "https://open.spotify.com/track/4u7EnebtmKWzUH433cf5Qv?si=e2e" });

    expect(res.status).toBe(200);
    expect(res.body.spotify).toMatchObject({
      id: "4u7EnebtmKWzUH433cf5Qv",
      title: expect.stringMatching(/bohemian rhapsody/i),
      artists: expect.arrayContaining(["Queen"]),
      duration: expect.any(Number),
    });
    const [best] = res.body.results as { title: string; duration: number }[];
    expect(best.title).toMatch(/bohemian rhapsody/i);
    expect(Math.abs(best.duration - res.body.spotify.duration)).toBeLessThanOrEqual(3);
  });

  it("explains that a Spotify album link isn't a song", async () => {
    const res = await request(app)
      .get("/api/search")
      .query({ q: "https://open.spotify.com/album/4m2880jivSbbyEGAKfITCa" });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/album/i);
  });

  it("lists the songs in a public Spotify playlist", async () => {
    // Spotify's own "Today's Top Hits": public, and always about 50 songs.
    const res = await request(app)
      .get("/api/spotify/playlist")
      .query({ link: "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=e2e" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      kind: "playlist",
      id: "37i9dQZF1DXcBWIGoYBM5M",
      name: expect.stringMatching(/top hits/i),
      maybeMore: false,
    });
    const tracks = res.body.tracks as { id: string; title: string; artists: string }[];
    expect(tracks.length).toBeGreaterThan(10);
    expect(tracks.length).toBeLessThanOrEqual(100);
    for (const track of tracks) {
      expect(track).toMatchObject({
        id: expect.stringMatching(/^[A-Za-z0-9]{22}$/),
        url: `https://open.spotify.com/track/${track.id}`,
        title: expect.any(String),
        artists: expect.any(String),
        explicit: expect.any(Boolean),
      });
    }
  });

  it("lists an album's songs too", async () => {
    const res = await request(app)
      .get("/api/spotify/playlist")
      .query({ link: "https://open.spotify.com/album/4m2880jivSbbyEGAKfITCa" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      kind: "album",
      name: "Random Access Memories",
      by: expect.stringMatching(/daft punk/i),
    });
    expect(res.body.tracks).toHaveLength(13);
    expect(res.body.tracks[0]).toMatchObject({
      title: "Give Life Back to Music",
      duration: expect.any(Number),
    });
  });

  it("explains a playlist Spotify won't share, and links that aren't playlists", async () => {
    const missing = await request(app)
      .get("/api/spotify/playlist")
      .query({ link: "https://open.spotify.com/playlist/0000000000000000000000" });
    expect(missing.status).toBe(404);
    expect(missing.body.message).toMatch(/private/i);

    const song = await request(app)
      .get("/api/spotify/playlist")
      .query({ link: "https://open.spotify.com/track/4u7EnebtmKWzUH433cf5Qv" });
    expect(song.status).toBe(400);
    expect(song.body.message).toMatch(/song, not a playlist/i);

    const empty = await request(app).get("/api/spotify/playlist").query({ link: " " });
    expect(empty.status).toBe(400);
  });

  it("rejects an empty search", async () => {
    for (const query of [{}, { q: "   " }]) {
      const res = await request(app).get("/api/search").query(query);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ message: expect.any(String), field: "q" });
    }
  });

  // GET /api/video/download with the body collected as raw bytes.
  const download = (query: Record<string, string>) =>
    request(app)
      .get("/api/video/download")
      .query(query)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
        response.on("error", (err) => callback(err, Buffer.alloc(0)));
      });

  it("downloads a valid MP3 audio file from /api/video/download", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-test-"));
    const outPath = path.join(tmpDir, "out.mp3");

    const res = await download({ url: TEST_VIDEO_URL });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("audio/mpeg");
    expect(res.headers["content-disposition"]).toMatch(/attachment;\s*filename=/i);

    await fs.writeFile(outPath, res.body as Buffer);

    const verdict = await verifyMp3File(outPath);
    expect(
      verdict.isValid,
      `Downloaded file is not a valid MP3: ${verdict.reason} (size=${verdict.size})`,
    ).toBe(true);
    expect(verdict.size).toBeGreaterThan(10_000); // at least 10KB of audio

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("saves under a new name with ?name=, keeping accents and non-Latin letters", async () => {
    const res = await download({ url: TEST_VIDEO_URL, name: "Zoo: first video – café 動物園.mp3" });
    expect(res.status).toBe(200);

    const disposition = String(res.headers["content-disposition"]);
    // A plain-ASCII name for old clients, and the real one (UTF-8) for everyone else.
    const utf8Name = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
    expect(utf8Name, disposition).toBeDefined();
    expect(decodeURIComponent(utf8Name!)).toBe("Zoo - first video – café 動物園.mp3");
    expect((res.body as Buffer).length).toBeGreaterThan(10_000);
  });

  it("downloads YouTube's original audio, unconverted, with ?format=original", async () => {
    const res = await download({ url: TEST_VIDEO_URL, format: "original" });
    expect(res.status).toBe(200);

    const disposition = String(res.headers["content-disposition"]);
    const ext = /\.(opus|m4a|mka)(?=["; ]|$)/.exec(disposition)?.[1];
    expect(ext, `unexpected filename in: ${disposition}`).toBeDefined();
    const contentTypes: Record<string, string> = {
      opus: "audio/ogg",
      m4a: "audio/mp4",
      mka: "audio/x-matroska",
    };
    expect(res.headers["content-type"]).toContain(contentTypes[ext!]);

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-test-"));
    const outPath = path.join(tmpDir, `out.${ext}`);
    await fs.writeFile(outPath, res.body as Buffer);
    const verdict = await verifyOriginalAudioFile(outPath, ext!);
    expect(verdict.isValid, `Not a valid .${ext}: ${verdict.reason}`).toBe(true);
    expect(verdict.size).toBeGreaterThan(10_000);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("rejects a malformed Spotify song id", async () => {
    const res = await request(app)
      .get("/api/video/download")
      .query({ url: TEST_VIDEO_URL, spotifyId: "not-an-id" });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown download format", async () => {
    const res = await request(app)
      .get("/api/video/download")
      .query({ url: TEST_VIDEO_URL, format: "flac" });
    expect(res.status).toBe(400);
    expect(res.text).toMatch(/mp3.*original/);
  });

  it("logs completed downloads in /api/downloads", async () => {
    // The three download tests above (MP3, renamed and original) all completed.
    const rows = await waitForHistory(TEST_VIDEO_URL, 3);
    expect(rows).toHaveLength(3);
    // The history keeps the video's title, whatever the file was named.
    expect(rows.every((row) => row.title.length > 0 && !row.title.includes("café"))).toBe(true);
  });

  it("does not log a download the browser cancels part-way through", async () => {
    const before = (await historyFor(TEST_VIDEO_URL)).length;

    // Start a real download and hang up as soon as the first audio arrives.
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const { port } = httpServer.address() as AddressInfo;
    const gotAudio = await new Promise<boolean>((resolve, reject) => {
      const req = http.get(
        `http://127.0.0.1:${port}/api/video/download?url=${encodeURIComponent(TEST_VIDEO_URL)}`,
        (res) => {
          res.once("data", () => {
            req.destroy(); // like cancelling in the browser
            resolve(true);
          });
          res.once("end", () => resolve(false));
        },
      );
      req.on("error", (err) =>
        (err as NodeJS.ErrnoException).code === "ECONNRESET" ? null : reject(err),
      );
    });
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    expect(gotAudio).toBe(true);

    // Give the server time to notice and clean up, then check nothing was saved.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect((await historyFor(TEST_VIDEO_URL)).length).toBe(before);
  });
});

describe("Save to folder (API)", () => {
  let saveDir: string;

  beforeAll(async () => {
    saveDir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-save-to-"));
  });

  afterAll(async () => {
    await fs.rm(saveDir, { recursive: true, force: true });
  });

  type SaveEvent = { type: string; [key: string]: unknown };

  // POST /api/video/save: the progress lines it streams back, or its error.
  const save = async (body: Record<string, unknown>) => {
    const res = await request(app)
      .post("/api/video/save")
      .send(body)
      .buffer(true)
      .parse((response, callback) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (text += chunk));
        response.on("end", () => callback(null, text));
        response.on("error", (err) => callback(err, ""));
      });
    const text = String(res.body);
    if (res.status !== 200) {
      return { res, error: JSON.parse(text) as { message: string }, events: [], done: undefined };
    }
    const events: SaveEvent[] = text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return { res, error: undefined, events, done: events.at(-1) };
  };

  const setFolder = (saveFolder: unknown) => request(app).put("/api/settings").send({ saveFolder });

  it("starts with downloads going to the browser, and won't save before a folder is chosen", async () => {
    const settings = await request(app).get("/api/settings");
    expect(settings.body).toEqual({ saveFolder: null, canSaveToFolder: true });

    const { res, error } = await save({ url: TEST_VIDEO_URL });
    expect(res.status).toBe(409);
    expect(error?.message).toMatch(/choose a folder/i);
  });

  it("refuses a folder that doesn't exist, isn't a folder, or isn't a full path", async () => {
    expect((await setFolder(path.join(saveDir, "missing"))).status).toBe(404);
    expect((await setFolder("relative/folder")).status).toBe(400);
    const file = path.join(saveDir, "not-a-folder.txt");
    await fs.writeFile(file, "x");
    expect((await setFolder(file)).status).toBe(400);
    await fs.rm(file);
    expect((await request(app).get("/api/settings")).body.saveFolder).toBeNull();
  });

  it("browses folders and makes new ones", async () => {
    const made = await request(app)
      .post("/api/folders")
      .send({ parent: saveDir, name: "Mix: 2024" });
    expect(made.status).toBe(201);
    expect(made.body).toEqual({ name: "Mix - 2024", path: path.join(saveDir, "Mix - 2024") });

    const listing = await request(app).get("/api/folders").query({ path: saveDir });
    expect(listing.status).toBe(200);
    expect(listing.body).toMatchObject({
      path: saveDir,
      parent: path.dirname(saveDir),
      folders: [made.body],
    });
    expect(listing.body.places).toEqual(
      expect.arrayContaining([{ name: "Home", path: os.homedir() }]),
    );

    const again = await request(app)
      .post("/api/folders")
      .send({ parent: saveDir, name: "Mix: 2024" });
    expect(again.status).toBe(409);
    await fs.rmdir(made.body.path);
  });

  it("saves the MP3 straight into the chosen folder, reporting progress", async () => {
    const chosen = await setFolder(saveDir);
    expect(chosen.status).toBe(200);
    expect(chosen.body).toEqual({ saveFolder: saveDir, canSaveToFolder: true });
    const before = (await historyFor(TEST_VIDEO_URL)).length;

    const { res, events, done } = await save({ url: TEST_VIDEO_URL });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/x-ndjson");
    expect(events.slice(0, -1).length).toBeGreaterThan(0);
    expect(events.slice(0, -1).every((e) => e.type === "progress")).toBe(true);
    expect(done).toMatchObject({
      type: "done",
      folder: saveDir,
      fileName: expect.stringMatching(/\.mp3$/),
    });
    expect(done!.path).toBe(path.join(saveDir, String(done!.fileName)));

    const verdict = await verifyMp3File(String(done!.path));
    expect(verdict.isValid, `Saved file is not a valid MP3: ${verdict.reason}`).toBe(true);
    expect(verdict.size).toBe(done!.bytes);
    // Nothing else in the folder: the unfinished .part file became the MP3.
    expect(await fs.readdir(saveDir)).toEqual([done!.fileName]);
    expect(await waitForHistory(TEST_VIDEO_URL, before + 1)).toHaveLength(before + 1);
  });

  it("never replaces a file: the same name again gets “(1)”, accents and all", async () => {
    const first = await save({ url: TEST_VIDEO_URL, name: "Zoo: café 動物園" });
    const second = await save({ url: TEST_VIDEO_URL, name: "Zoo: café 動物園" });
    expect(first.done).toMatchObject({ type: "done", fileName: "Zoo - café 動物園.mp3" });
    expect(second.done).toMatchObject({ type: "done", fileName: "Zoo - café 動物園 (1).mp3" });
    for (const { done } of [first, second]) {
      expect((await fs.stat(String(done!.path))).size).toBe(done!.bytes);
    }
  });

  it("saves YouTube's original audio too, remembering the Spotify song it was for", async () => {
    const spotifyId = "4u7EnebtmKWzUH433cf5Qv";
    const { done } = await save({ url: TEST_VIDEO_URL, format: "original", spotifyId });
    const ext = /\.(opus|m4a|mka)$/.exec(String(done?.fileName))?.[1];
    expect(ext, `unexpected file: ${JSON.stringify(done)}`).toBeDefined();
    const verdict = await verifyOriginalAudioFile(String(done!.path), ext!);
    expect(verdict.isValid, `Not a valid .${ext}: ${verdict.reason}`).toBe(true);
    // The history entry carries the Spotify song, for the playlist panel.
    const [latest] = (await request(app).get("/api/downloads")).body as { spotifyId?: string }[];
    expect(latest.spotifyId).toBe(spotifyId);
  });

  it("explains a video that can't be downloaded, and leaves nothing behind", async () => {
    const files = await fs.readdir(saveDir);
    const { res, error } = await save({ url: "https://www.youtube.com/watch?v=ZZZZZZZZZZZ" });
    expect(res.status).toBe(502);
    expect(error?.message).toMatch(/^Couldn't download the audio: /);
    expect(error?.message).not.toMatch(/command spawned/i);
    expect(await fs.readdir(saveDir)).toEqual(files);
  });

  it("cancelling part-way leaves no file and adds nothing to the history", async () => {
    const files = await fs.readdir(saveDir);
    const before = (await historyFor(TEST_VIDEO_URL)).length;

    // Start a real save and hang up as soon as the first progress arrives.
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const { port } = httpServer.address() as AddressInfo;
    const gotProgress = await new Promise<boolean>((resolve, reject) => {
      const req = http.request(
        `http://127.0.0.1:${port}/api/video/save`,
        { method: "POST", headers: { "Content-Type": "application/json" } },
        (res) => {
          res.once("data", () => {
            req.destroy(); // like pressing Cancel
            resolve(true);
          });
          res.once("end", () => resolve(false));
        },
      );
      req.on("error", (err) =>
        (err as NodeJS.ErrnoException).code === "ECONNRESET" ? null : reject(err),
      );
      req.end(JSON.stringify({ url: TEST_VIDEO_URL, name: "Cancelled" }));
    });
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    expect(gotProgress).toBe(true);

    // Give the app time to stop and tidy up, then check nothing was kept.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(await fs.readdir(saveDir)).toEqual(files);
    expect((await historyFor(TEST_VIDEO_URL)).length).toBe(before);
  });

  it("only this app's own page can save or change the folder", async () => {
    const crossSite = await request(app)
      .post("/api/video/save")
      .set("Sec-Fetch-Site", "cross-site")
      .send({ url: TEST_VIDEO_URL });
    expect(crossSite.status).toBe(403);

    const otherSite = await request(app)
      .put("/api/settings")
      .set("Origin", "https://example.com")
      .send({ saveFolder: os.tmpdir() });
    expect(otherSite.status).toBe(403);

    // A plain HTML form (not JSON) can't change anything either.
    const form = await request(app)
      .put("/api/settings")
      .type("form")
      .send({ saveFolder: os.tmpdir() });
    expect(form.status).toBe(415);

    expect((await request(app).get("/api/settings")).body.saveFolder).toBe(saveDir);
  });
});
