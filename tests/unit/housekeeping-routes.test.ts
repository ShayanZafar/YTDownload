import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { createServer } from "http";
import request from "supertest";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { FFMPEG_PATH } from "../../server/audio";
import { copiesOf } from "../../client/src/lib/housekeeping";
import { folderTrack } from "../../client/src/lib/music";
import {
  folderFilesSchema,
  musicLibrarySchema,
  saveSettingsSchema,
  songCheckSchema,
} from "../../shared/schema";

// Housekeeping through the real routes, against real files in a temporary
// "Save to" folder: check each song, list the other files, delete one to a
// stand-in bin, keep the quality bar in the settings, and find extra copies.

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

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-housekeeping-api-"));
  process.env.HISTORY_FILE = path.join(dir, "history.json");
  process.env.SETTINGS_FILE = path.join(dir, "settings.json");
  process.env.PLAYER_CACHE_DIR = path.join(dir, "cache");
  process.env.TRASH_DIR = path.join(dir, "trash");
  folder = path.join(dir, "Music");
  await fs.mkdir(folder);
  await ffmpeg([
    ...["-f", "lavfi", "-i", "sine=frequency=440:duration=20"],
    ...["-c:a", "libmp3lame", "-b:a", "128k", path.join(folder, "Cut.mp3")],
  ]);
  const whole = await fs.readFile(path.join(folder, "Cut.mp3"));
  await fs.writeFile(path.join(folder, "Cut.mp3"), whole.subarray(0, whole.length / 4));
  await fs.writeFile(path.join(folder, "Song.mp3.part"), Buffer.alloc(100));

  const { registerRoutes } = await import("../../server/routes");
  app = express();
  app.use(express.json());
  await registerRoutes(createServer(app), app);
  await request(app).put("/api/settings").send({ saveFolder: folder }).expect(200);
});

afterAll(async () => {
  delete process.env.HISTORY_FILE;
  delete process.env.SETTINGS_FILE;
  delete process.env.PLAYER_CACHE_DIR;
  delete process.env.TRASH_DIR;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("Housekeeping (API)", () => {
  it("checks a song, lists the other files and deletes one to the bin, this computer only", async () => {
    const [song] = musicLibrarySchema.parse((await request(app).get("/api/music")).body).tracks;
    const check = songCheckSchema.parse(
      (await request(app).get(`/api/music/${song.id}/check`).expect(200)).body,
    );
    expect(check.cutShort?.says).toBeCloseTo(20, 0);
    expect(check.cutShort?.plays).toBeLessThan(8);
    expect((await request(app).get("/api/music/nope/check")).status).toBe(400);

    const { files } = folderFilesSchema.parse(
      (await request(app).get("/api/folder-files").expect(200)).body,
    );
    expect(files).toMatchObject([
      { path: "Song.mp3.part", what: "a download that didn't finish", leftover: true },
    ]);
    // Never for another device.
    const away = await request(app)
      .delete(`/api/folder-files/${files[0].id}`)
      .set("X-Forwarded-For", "192.168.1.20");
    expect(away.status).toBe(403);
    expect(
      (await request(app).get("/api/folder-files").set("X-Forwarded-For", "10.0.0.2")).status,
    ).toBe(403);

    const deleted = await request(app)
      .delete(`/api/folder-files/${files[0].id}`)
      .send({})
      .expect(200);
    expect(deleted.body).toMatchObject({ trashed: true });
    expect(await fs.readdir(folder)).toEqual(["Cut.mp3"]);
    expect(await fs.readdir(path.join(dir, "trash", "files"))).toEqual(["Song.mp3.part"]);
    expect((await request(app).delete(`/api/folder-files/${files[0].id}`).send({})).status).toBe(
      404,
    );
  });

  it("finds the extra copies of a song among the songs it checked, keeping the best", async () => {
    // From the owner's folder: About You twice, a few seconds apart, and a live recording.
    const sub = path.join(folder, "Copies");
    await fs.mkdir(sub);
    const song = (name: string, seconds: number, kbps: string, title: string) =>
      ffmpeg([
        ...["-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`],
        ...["-c:a", "libmp3lame", "-b:a", kbps, "-metadata", `title=${title}`],
        ...["-metadata", "artist=Mike Shinoda", path.join(sub, name)],
      ]);
    await song(
      "Mike Shinoda - About You feat. blackbear.mp3",
      12,
      "128k",
      "About You feat. blackbear",
    );
    await song(
      "Mike Shinoda - About You (feat. blackbear).mp3",
      10,
      "256k",
      "About You (feat. blackbear)",
    );
    await song("Mike Shinoda - About You (Live).mp3", 11, "256k", "About You (Live)");

    // As the Housekeeping panel does: each song checked, then copiesOf() over them.
    const { tracks } = musicLibrarySchema.parse((await request(app).get("/api/music")).body);
    const checked = await Promise.all(
      tracks
        .filter((track) => track.path.startsWith(`Copies${path.sep}`))
        .map(async (track) => ({
          ...folderTrack(track),
          check: songCheckSchema.parse(
            (await request(app).get(`/api/music/${track.id}/check`).expect(200)).body,
          ),
        })),
    );
    expect(checked).toHaveLength(3);
    const sets = copiesOf(checked);
    expect(
      sets.map(({ keep, extra }) => [keep, ...extra].map((each) => path.basename(each.fileName))),
    ).toEqual([
      [
        "Mike Shinoda - About You (feat. blackbear).mp3",
        "Mike Shinoda - About You feat. blackbear.mp3",
      ],
    ]);
    expect(sets[0].extra[0].check.kbps).toBe(128);
    await fs.rm(sub, { recursive: true });
  });

  it("keeps the quality bar with the settings, 128 kbps until it's changed", async () => {
    expect(saveSettingsSchema.parse((await request(app).get("/api/settings")).body)).toMatchObject({
      saveFolder: folder,
      qualityBar: "128",
    });
    const changed = await request(app).put("/api/settings").send({ qualityBar: "256" }).expect(200);
    // The folder stays as it was.
    expect(changed.body).toMatchObject({ saveFolder: folder, qualityBar: "256" });
    expect((await request(app).get("/api/settings")).body.qualityBar).toBe("256");
    expect((await request(app).put("/api/settings").send({ qualityBar: "999" })).status).toBe(400);
    expect((await request(app).put("/api/settings").send({})).status).toBe(400);
  });
});
