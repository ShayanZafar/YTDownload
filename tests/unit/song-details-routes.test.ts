import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer } from "http";
import request from "supertest";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { FFMPEG_PATH } from "../../server/audio";
import { resetCatalogues } from "../../server/catalogues";
import {
  musicLibrarySchema,
  songDetailsWrittenSchema,
  songLookupSchema,
  type MusicTrack,
} from "../../shared/schema";

// Fill in details through the real routes, against real files in a temporary
// "Save to" folder: look a song up (iTunes played by a stand-in — no
// network), write what it lacks, and the folder's list shows its genre.

let app: express.Express;
let dir: string;
let folder: string;

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

const tone = (file: string, codecArgs: string[]) =>
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=3", ...codecArgs, file]);

/** What the iTunes stand-in was asked. */
const asked: URL[] = [];

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-details-api-"));
  process.env.HISTORY_FILE = path.join(dir, "history.json");
  process.env.SETTINGS_FILE = path.join(dir, "settings.json");
  process.env.PLAYER_CACHE_DIR = path.join(dir, "cache");
  process.env.DETAILS_LOG_FILE = path.join(dir, "details.log");
  folder = path.join(dir, "Music");
  await fs.mkdir(folder);
  await tone(path.join(folder, "Test Tone.mp3"), [
    ...["-c:a", "libmp3lame", "-b:a", "128k", "-id3v2_version", "3"],
    ...["-metadata", "title=Test Tone", "-metadata", "artist=Sine Wave"],
  ]);
  await tone(path.join(folder, "Rock Song.mp3"), [
    ...["-c:a", "libmp3lame", "-b:a", "128k", "-id3v2_version", "3"],
    ...["-metadata", "title=Rock Song", "-metadata", "genre=Rock; Pop"],
  ]);
  await tone(path.join(folder, "Old Song.wma"), ["-c:a", "wmav2"]);

  vi.stubGlobal("fetch", async (url: string) => {
    asked.push(new URL(url));
    const results = url.includes("Test+Tone")
      ? [
          {
            kind: "song",
            trackName: "Test Tone",
            artistName: "Sine Wave",
            collectionName: "Pure Tones",
            primaryGenreName: "Electronic",
            releaseDate: "1999-04-01T07:00:00Z",
            trackNumber: 3,
            trackTimeMillis: 3000,
          },
        ]
      : [];
    return new Response(JSON.stringify({ resultCount: results.length, results }), {
      headers: { "content-type": "application/json" },
    });
  });
  resetCatalogues();

  const { registerRoutes } = await import("../../server/routes");
  app = express();
  app.use(express.json());
  await registerRoutes(createServer(app), app);
  await request(app).put("/api/settings").send({ saveFolder: folder }).expect(200);
});

afterEach(() => {
  asked.length = 0;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  delete process.env.HISTORY_FILE;
  delete process.env.SETTINGS_FILE;
  delete process.env.PLAYER_CACHE_DIR;
  delete process.env.DETAILS_LOG_FILE;
  await fs.rm(dir, { recursive: true, force: true });
});

async function songs(): Promise<Record<string, MusicTrack>> {
  const res = await request(app).get("/api/music").expect(200);
  const { tracks } = musicLibrarySchema.parse(res.body);
  return Object.fromEntries(tracks.map((track) => [track.path, track]));
}

describe("Fill in details (API)", () => {
  it("lists each song's genres", async () => {
    const tracks = await songs();
    expect(tracks["Rock Song.mp3"].genres).toEqual(["Rock", "Pop"]);
    expect(tracks["Test Tone.mp3"].genres).toEqual([]);
  });

  it("looks a song up, writes what it lacks, and the list shows its genre", async () => {
    const { id } = (await songs())["Test Tone.mp3"];
    const lookup = songLookupSchema.parse(
      (await request(app).get(`/api/music/${id}/details`).expect(200)).body,
    );
    expect(lookup).toMatchObject({
      missing: ["album", "genre", "year", "track", "cover"],
      writable: true,
      source: "itunes",
      found: { album: "Pure Tones", genre: "Electronic", year: 1999, track: 3 },
      match: { title: "Test Tone", artist: "Sine Wave", album: "Pure Tones" },
    });
    // Only the title and artist went to iTunes.
    expect(asked.map((url) => url.searchParams.get("term"))).toEqual(["Sine Wave Test Tone"]);

    const written = songDetailsWrittenSchema.parse(
      (await request(app).post(`/api/music/${id}/details`).send(lookup.found).expect(200)).body,
    );
    expect(written.added).toEqual(["album", "genre", "year", "track"]);
    expect(written.track).toMatchObject({ id, album: "Pure Tones", genres: ["Electronic"] });
    expect((await songs())["Test Tone.mp3"]).toMatchObject({
      album: "Pure Tones",
      genres: ["Electronic"],
      year: 1999,
    });
  });

  it("finds nothing for a song the catalogues don't have, and writes nothing for it", async () => {
    const { id } = (await songs())["Rock Song.mp3"];
    const res = await request(app).get(`/api/music/${id}/details`).expect(200);
    expect(res.body).toMatchObject({ writable: true, found: null });
  });

  it("says a file that can't hold tags can't be changed", async () => {
    const { id } = (await songs())["Old Song.wma"];
    expect((await request(app).get(`/api/music/${id}/details`).expect(200)).body).toMatchObject({
      writable: false,
      found: null,
    });
    expect(asked).toEqual([]);
    const res = await request(app).post(`/api/music/${id}/details`).send({ genre: "Rock" });
    expect(res.status).toBe(400);
  });

  it("says why a file named .mp3 that's really another kind can't be changed, and leaves it", async () => {
    await ffmpeg([
      ...["-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:a", "aac", "-f", "ipod"],
      path.join(folder, "Misnamed.mp3"),
    ]);
    const before = await fs.readFile(path.join(folder, "Misnamed.mp3"));
    const { id } = (await songs())["Misnamed.mp3"];
    const lookup = songLookupSchema.parse(
      (await request(app).get(`/api/music/${id}/details`).expect(200)).body,
    );
    expect(lookup).toMatchObject({ writable: false, found: null });
    expect(lookup.problem).toContain("rename it to end in .m4a");
    expect(asked).toEqual([]);
    const res = await request(app).post(`/api/music/${id}/details`).send({ genre: "Rock" });
    expect(res.status).toBe(422);
    expect(res.body.message).toContain("rename it to end in .m4a");
    expect(await fs.readFile(path.join(folder, "Misnamed.mp3"))).toEqual(before);
    await fs.rm(path.join(folder, "Misnamed.mp3"));
  });

  it("keeps a log of each song looked up and written, and why one wasn't found", async () => {
    const tracks = await songs();
    await request(app).get(`/api/music/${tracks["Rock Song.mp3"].id}/details`).expect(200);
    const res = await request(app).get("/api/details-log").expect(200);
    expect(res.headers["content-type"]).toMatch(/^text\/plain/);
    const lines: string[] = res.text.split("\n");
    // The earlier tests' songs, in order, each with what happened and why.
    expect(lines.find((line) => line.includes("look-up  Test Tone.mp3  found"))).toContain(
      "matched “Test Tone” by Sine Wave on iTunes; album Pure Tones; genre Electronic",
    );
    expect(lines.find((line) => line.includes("write  Test Tone.mp3  added"))).toContain(
      "genre Electronic",
    );
    // Not found: what it lacks, and each search with why its answers weren't it.
    expect(lines.at(-1)).toMatch(
      /look-up {2}Rock Song\.mp3 {2}not found: lacks artist, album, year, track, cover; iTunes, “Rock Song”: nothing came back; Deezer, “Rock Song”: nothing came back$/,
    );
    expect(lines.some((line) => line.includes("Misnamed.mp3  can't be written"))).toBe(true);
  });

  it("takes only details that make sense, as JSON, by a song's id", async () => {
    const { id } = (await songs())["Rock Song.mp3"];
    await request(app).post(`/api/music/${id}/details`).send({ year: 12 }).expect(400);
    await request(app)
      .post(`/api/music/${id}/details`)
      .set("Content-Type", "text/plain")
      .send("genre=Rock")
      .expect(415);
    await request(app).get("/api/music/..%2F..%2Fsecret/details").expect(400);
    await request(app)
      .get(`/api/music/${"x".repeat(22)}/details`)
      .expect(404);
  });
});
