import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { createServer } from "http";
import request from "supertest";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { FFMPEG_PATH } from "../../server/audio";
import { musicLibrarySchema, trimmedSongSchema, waveformSchema } from "../../shared/schema";

// Trimming a song through the app's routes, on a song ffmpeg makes here (no
// network): the waveform with its dead air, cutting a part out, Undo — and
// only for this computer's own page.

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
let song: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-trim-routes-"));
  process.env.HISTORY_FILE = path.join(dir, "history.json");
  process.env.SETTINGS_FILE = path.join(dir, "settings.json");
  process.env.TRIM_BACKUP_DIR = path.join(dir, "backups");
  folder = path.join(dir, "Music");
  await fs.mkdir(folder, { recursive: true });
  // 10 seconds: quiet, a tone (2–5 s), quiet (5–7 s), a tone (7–10 s).
  song = path.join(folder, "Gaps.mp3");
  await ffmpeg([
    ...["-f", "lavfi", "-i"],
    "aevalsrc=exprs='(between(t,2,5)+between(t,7,10))*0.5*sin(2*PI*440*t)':d=10:s=44100",
    ...["-c:a", "libmp3lame", "-b:a", "320k", "-id3v2_version", "3"],
    ...["-metadata", "title=Gaps", "-metadata", "artist=Sine Wave", song],
  ]);

  const { registerRoutes } = await import("../../server/routes");
  app = express();
  app.use(express.json());
  await registerRoutes(createServer(app), app);
  await request(app).put("/api/settings").send({ saveFolder: folder }).expect(200);
});

afterAll(async () => {
  delete process.env.HISTORY_FILE;
  delete process.env.SETTINGS_FILE;
  delete process.env.TRIM_BACKUP_DIR;
  await fs.rm(dir, { recursive: true, force: true });
});

/** The song's id and length, as the player lists it. */
async function listed() {
  const res = await request(app).get("/api/music").expect(200);
  const [track] = musicLibrarySchema.parse(res.body).tracks;
  return track;
}

describe("Trimming a song (routes)", () => {
  it("shows a song's waveform with its dead air, cuts a part out, and Undo puts it back", async () => {
    const before = await listed();
    const original = await fs.readFile(song);

    const waveform = waveformSchema.parse(
      (await request(app).get(`/api/music/${before.id}/waveform`).expect(200)).body,
    );
    expect(waveform.duration).toBeCloseTo(10, 0);
    expect(waveform.silences.map((quiet) => Math.round(quiet.start))).toEqual([0, 5]);

    const cut = waveform.silences[1];
    const trimmed = trimmedSongSchema.parse(
      (await request(app).post(`/api/music/${before.id}/trim`).send(cut).expect(200)).body,
    );
    expect(trimmed.id).toBe(before.id);
    expect(trimmed.duration).toBeCloseTo(8, 0);
    const after = await listed();
    expect(after).toMatchObject({ id: before.id, title: "Gaps", artist: "Sine Wave" });
    expect(after.duration).toBeCloseTo(8, 0);

    const undone = await request(app)
      .post("/api/music/trim/undo")
      .send({ undo: trimmed.undo })
      .expect(200);
    expect(undone.body.id).toBe(before.id);
    expect((await fs.readFile(song)).equals(original)).toBe(true);
    expect((await listed()).duration).toBeCloseTo(10, 0);
  });

  it("says what's wrong with a cut, and leaves the song alone", async () => {
    const { id } = await listed();
    const original = await fs.readFile(song);
    const backwards = await request(app).post(`/api/music/${id}/trim`).send({ start: 5, end: 4 });
    expect(backwards.status).toBe(400);
    expect(backwards.body.message).toMatch(/end must come after its start/);
    const whole = await request(app).post(`/api/music/${id}/trim`).send({ start: 0, end: 60 });
    expect(whole.status).toBe(400);
    expect(whole.body.message).toMatch(/whole song/);
    const gone = await request(app)
      .post("/api/music/trim/undo")
      .send({ undo: "0123456789abcdef01234567" });
    expect(gone.status).toBe(404);
    expect((await fs.readFile(song)).equals(original)).toBe(true);
  });

  it("only for this computer's own page, sent as JSON", async () => {
    const { id } = await listed();
    const otherSite = await request(app)
      .post(`/api/music/${id}/trim`)
      .set("Origin", "https://example.com")
      .send({ start: 5, end: 7 });
    expect(otherSite.status).toBe(403);
    const form = await request(app)
      .post(`/api/music/${id}/trim`)
      .type("form")
      .send("start=5&end=7");
    expect(form.status).toBe(415);
    const proxied = await request(app)
      .get(`/api/music/${id}/waveform`)
      .set("X-Forwarded-For", "192.168.1.20");
    expect(proxied.status).toBe(403);
  });
});
