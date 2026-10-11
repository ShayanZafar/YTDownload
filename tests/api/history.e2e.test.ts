import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer } from "http";
import request from "supertest";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import type { Download } from "../../shared/schema";

// Managing the download history (Recent Extractions) and looking up lyrics,
// through the real routes — no internet needed: the history is a temp file
// and LRCLIB's answers are made up.

let app: express.Express;
let dir: string;
let historyFile: string;

const entry = (id: number, daysAgo: number): Download => ({
  id,
  url: `https://www.youtube.com/watch?v=video${String(id).padStart(6, "0")}`,
  title: `Song ${id}`,
  downloadedAt: new Date(Date.UTC(2026, 9, 11) - daysAgo * 86_400_000).toISOString(),
});
const history = [entry(3, 0), entry(2, 1), entry(1, 2)];

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-history-api-"));
  historyFile = path.join(dir, "history.json");
  process.env.HISTORY_FILE = historyFile;
  process.env.SETTINGS_FILE = path.join(dir, "settings.json");
  await fs.writeFile(historyFile, JSON.stringify(history));

  const { registerRoutes } = await import("../../server/routes");
  app = express();
  app.use(express.json({ limit: "1mb" }));
  await registerRoutes(createServer(app), app);
});

afterAll(async () => {
  delete process.env.HISTORY_FILE;
  delete process.env.SETTINGS_FILE;
  vi.unstubAllGlobals();
  await fs.rm(dir, { recursive: true, force: true });
});

const titles = async () =>
  ((await request(app).get("/api/downloads")).body as Download[]).map((e) => e.title);

describe("Download history (API)", () => {
  it("takes one entry out and puts it back in its place", async () => {
    const removed = await request(app).delete("/api/downloads/2");
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual(history[1]);
    expect(await titles()).toEqual(["Song 3", "Song 1"]);

    expect((await request(app).delete("/api/downloads/2")).status).toBe(404);
    expect((await request(app).delete("/api/downloads/nope")).status).toBe(404);

    const back = await request(app)
      .post("/api/downloads/restore")
      .send({ entries: [removed.body] });
    expect(back.status).toBe(200);
    expect(await titles()).toEqual(["Song 3", "Song 2", "Song 1"]);
  });

  it("clears everything, and Undo puts it all back once", async () => {
    const cleared = await request(app).delete("/api/downloads");
    expect(cleared.body).toEqual(history);
    expect(await titles()).toEqual([]);

    await request(app).post("/api/downloads/restore").send({ entries: cleared.body });
    // Twice (a double click): what's already back isn't added again.
    const again = await request(app).post("/api/downloads/restore").send({ entries: cleared.body });
    expect(again.body).toEqual([]);
    expect(await titles()).toEqual(["Song 3", "Song 2", "Song 1"]);
  });

  it("is changed only by the app's own page, with JSON", async () => {
    const otherSite = await request(app)
      .delete("/api/downloads")
      .set("Origin", "https://evil.example")
      .set("Sec-Fetch-Site", "cross-site");
    expect(otherSite.status).toBe(403);
    const form = await request(app)
      .post("/api/downloads/restore")
      .type("form")
      .send({ entries: "x" });
    expect(form.status).toBe(415);
    const bad = await request(app)
      .post("/api/downloads/restore")
      .send({ entries: [{ id: "x" }] });
    expect(bad.status).toBe(400);
    expect(await titles()).toEqual(["Song 3", "Song 2", "Song 1"]);
  });
});

describe("Lyrics (API)", () => {
  it("answers with the song's lyrics, or null when there are none", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      const found = new URL(url).searchParams.get("track_name") === "Known Song";
      const records = found
        ? [{ trackName: "Known Song", artistName: "Band", duration: 120, plainLyrics: "Hi" }]
        : [];
      return new Response(JSON.stringify(records), { status: 200 });
    });
    const found = await request(app).get("/api/lyrics").query({
      title: "Known Song",
      artist: "Band",
      duration: 121,
    });
    expect(found.status).toBe(200);
    expect(found.body.lyrics).toMatchObject({ plain: "Hi", synced: null, track: "Known Song" });

    const missing = await request(app)
      .get("/api/lyrics")
      .query({ title: "Nothing", artist: "Band" });
    expect(missing.body).toEqual({ lyrics: null });
  });

  it("says when LRCLIB can't be reached, and needs a title", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    const down = await request(app).get("/api/lyrics").query({ title: "Unreachable" });
    expect(down.status).toBe(502);
    expect(down.body.message).toContain("lyrics library");
    expect((await request(app).get("/api/lyrics")).status).toBe(400);
  });
});
