import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
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
  // Keep test downloads out of your real history: point the app's history
  // file at a throwaway folder for this run.
  historyDir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-history-"));
  process.env.HISTORY_FILE = path.join(historyDir, "history.json");

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
  await fs.rm(historyDir, { recursive: true, force: true });
});

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

  it("downloads YouTube's original audio, unconverted, with ?format=original", async () => {
    const res = await download({ url: TEST_VIDEO_URL, format: "original" });
    expect(res.status).toBe(200);

    const disposition = String(res.headers["content-disposition"]);
    const ext = /\.(opus|m4a|mka)"$/.exec(disposition)?.[1];
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

  it("rejects an unknown download format", async () => {
    const res = await request(app)
      .get("/api/video/download")
      .query({ url: TEST_VIDEO_URL, format: "flac" });
    expect(res.status).toBe(400);
    expect(res.text).toMatch(/mp3.*original/);
  });

  it("logs the download in /api/downloads after a successful extraction", async () => {
    const res = await request(app).get("/api/downloads");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    // The previous test downloaded TEST_VIDEO_URL, so it should appear here.
    const found = (res.body as Array<{ url: string; title: string }>).some(
      (row) => row.url === TEST_VIDEO_URL,
    );
    expect(found).toBe(true);
  });
});
