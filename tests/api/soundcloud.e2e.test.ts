import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { createServer } from "http";
import request from "supertest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { parseFile } from "music-metadata";
import { verifyMp3File } from "../utils/mp3";
import { verifyOriginalAudioFile } from "../utils/original-audio";
import { audioLinkOf, parseSoundCloudLink } from "../../shared/soundcloud-link";
import { fetchAudioInfo, runYtDlpJson } from "../../server/audio";
import { soundCloudSearchArgs, type RawSearchEntry } from "../../server/search";
import { PREVIEW_ONLY, isPreview, looksLikePreview } from "../../server/soundcloud";
import { sourceHealth } from "../../server/source-health";
import type { SearchResult } from "../../shared/schema";

// SoundCloud, the fallback for audio, for real: the app's own yt-dlp against SoundCloud — no
// key, no account. Needs the internet (the cloud workspace can't reach SoundCloud). The song is
// the one the owner probed by hand (Oct 11, 2026): its search lists a 30-second preview first.
const QUERY = "daft punk one more time";

let app: express.Express;
let dir: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-soundcloud-"));
  process.env.HISTORY_FILE = path.join(dir, "history.json");
  process.env.SETTINGS_FILE = path.join(dir, "settings.json");
  process.env.SOURCE_HEALTH_FILE = path.join(dir, "source-health.json");
  const { registerRoutes } = await import("../../server/routes");
  app = express();
  app.use(express.json());
  await registerRoutes(createServer(app), app);
});

afterAll(async () => {
  await sourceHealth.flush().catch(() => {});
  delete process.env.HISTORY_FILE;
  delete process.env.SETTINGS_FILE;
  delete process.env.SOURCE_HEALTH_FILE;
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** GET /api/video/download, its body kept as bytes. */
const download = (query: Record<string, string>) =>
  request(app)
    .get("/api/video/download")
    .query(query)
    .buffer(true)
    .parse((response, callback) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => callback(null, Buffer.concat(chunks)));
    });

let results: SearchResult[] = [];

describe("SoundCloud end-to-end (API)", () => {
  it("yt-dlp still lists tracks in the shape the app turns into canonical links", async () => {
    const listing = (await runYtDlpJson(soundCloudSearchArgs(QUERY))) as {
      entries?: RawSearchEntry[];
    };
    const entries = listing.entries ?? [];
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(parseSoundCloudLink(entry.url), String(entry.url)).toMatch(
        /^https:\/\/api\.soundcloud\.com\/tracks\/[1-9][0-9]*$/,
      );
    }
  });

  it("searches SoundCloud alone, with canonical links and previews last", async () => {
    const res = await request(app).get("/api/search").query({ q: QUERY, source: "soundcloud" });
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("soundcloud");
    results = res.body.results as SearchResult[];
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.source).toBe("soundcloud");
      expect(audioLinkOf(result.url)).toEqual({ source: "soundcloud", url: result.url });
    }
    // A 30-second preview never comes before a whole track.
    const firstPreview = results.findIndex((r) => looksLikePreview(r));
    if (firstPreview >= 0) {
      expect(results.slice(firstPreview).every((r) => looksLikePreview(r))).toBe(true);
    }
  });

  it("looks for a Spotify song on SoundCloud alone, by its artist and title", async () => {
    // Queen – Bohemian Rhapsody (Remastered 2011), 5:54 on Spotify.
    const res = await request(app)
      .get("/api/search")
      .query({ q: "https://open.spotify.com/track/4u7EnebtmKWzUH433cf5Qv", source: "soundcloud" });
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("soundcloud");
    expect(res.body.spotify).toMatchObject({ id: "4u7EnebtmKWzUH433cf5Qv" });
    for (const result of res.body.results as SearchResult[]) {
      expect(audioLinkOf(result.url)?.source).toBe("soundcloud");
    }
  });

  it("opens a canonical link in yt-dlp, and refuses a preview at the look-up", async () => {
    const whole = results.find((r) => !looksLikePreview(r));
    expect(whole, "a whole track in the results").toBeDefined();
    const info = await fetchAudioInfo(whole!.url);
    expect(info.title.length).toBeGreaterThan(0);
    expect(isPreview(info)).toBe(false);

    const preview = results.find((r) => looksLikePreview(r));
    if (!preview) return; // SoundCloud listed none this time
    const res = await request(app).get("/api/video/download").query({ url: preview.url });
    expect(res.status).toBe(500);
    expect(res.text).toBe(PREVIEW_ONLY);
  });

  it("downloads a whole track as a valid MP3, remembered as SoundCloud's", async () => {
    const whole = results.find((r) => !looksLikePreview(r))!;
    const res = await download({ url: whole.url, name: "SoundCloud track" });
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain("SoundCloud track.mp3");
    const file = path.join(dir, "track.mp3");
    await fs.writeFile(file, res.body as Buffer);
    expect((await verifyMp3File(file)).isValid).toBe(true);
    // Its cover is the track's artwork, from SoundCloud's image host.
    const { common } = await parseFile(file);
    expect(common.picture?.[0]?.format).toBe("image/jpeg");
    let history: { url: string; source?: string }[] = [];
    for (let i = 0; i < 50 && !history.some((d) => d.url === whole.url); i++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      history = (await request(app).get("/api/downloads")).body;
    }
    expect(history.find((d) => d.url === whole.url)?.source).toBe("soundcloud");
  });

  it("downloads SoundCloud's own stream untouched with ?format=original", async () => {
    const whole = results.find((r) => !looksLikePreview(r))!;
    const res = await download({ url: whole.url, format: "original" });
    expect(res.status).toBe(200);
    const ext = /\.(\w+)"?$/.exec(String(res.headers["content-disposition"]))?.[1] ?? "";
    expect(["mp3", "opus", "m4a", "mka"]).toContain(ext);
    const file = path.join(dir, `original.${ext}`);
    await fs.writeFile(file, res.body as Buffer);
    const check =
      ext === "mp3" ? await verifyMp3File(file) : await verifyOriginalAudioFile(file, ext);
    expect(check.isValid, check.reason).toBe(true);
  });
});
