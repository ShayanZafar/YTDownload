import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import { createServer } from "http";
import request from "supertest";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { FFMPEG_PATH } from "../../server/audio";
import { parseFile } from "../../server/library";
import { musicLibrarySchema, type MusicTrack } from "../../shared/schema";

// The music player's routes, against real files in a temporary "Save to"
// folder (no internet needed): listing the songs, playing one as it is (with
// range requests, for seeking), converting one a browser can't play to FLAC,
// and cover pictures — only ever for this computer's own page.

let app: express.Express;
let dir: string;
let folder: string;

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

const tone = (file: string, seconds: number, codecArgs: string[]) =>
  ffmpeg(["-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`, ...codecArgs, file]);

/** Reads any response body as bytes. */
const binary = (
  res: NodeJS.ReadableStream,
  callback: (err: Error | null, body: Buffer) => void,
) => {
  const chunks: Buffer[] = [];
  res.on("data", (chunk: Buffer) => chunks.push(chunk));
  res.on("end", () => callback(null, Buffer.concat(chunks)));
};

const get = (url: string) => request(app).get(url).buffer(true).parse(binary);

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-music-api-"));
  process.env.HISTORY_FILE = path.join(dir, "history.json");
  process.env.SETTINGS_FILE = path.join(dir, "settings.json");
  process.env.PLAYER_CACHE_DIR = path.join(dir, "cache");
  // Deleted songs go here, not into this computer's Recycle Bin / Trash.
  process.env.TRASH_DIR = path.join(dir, "bin");

  // A folder with an MP3 the way the app saves them (tags and all), an old
  // WMA no browser plays, one with a cover picture, and a file that isn't a song.
  folder = path.join(dir, "Music");
  await fs.mkdir(path.join(folder, "Sine Wave"), { recursive: true });
  await tone(path.join(folder, "Sine Wave", "Test Tone.mp3"), 3, [
    ...["-c:a", "libmp3lame", "-b:a", "320k", "-id3v2_version", "3"],
    ...["-metadata", "title=Test Tone", "-metadata", "artist=Sine Wave"],
  ]);
  await tone(path.join(folder, "Old Song.wma"), 2, ["-c:a", "wmav2"]);
  const picture = path.join(dir, "cover.png");
  await ffmpeg(["-f", "lavfi", "-i", "color=c=blue:s=16x16", "-frames:v", "1", picture]);
  await ffmpeg([
    ...["-i", path.join(folder, "Sine Wave", "Test Tone.mp3"), "-i", picture],
    ...["-map", "0:a", "-map", "1:v", "-c", "copy", "-id3v2_version", "3"],
    path.join(folder, "With Cover.mp3"),
  ]);
  await fs.writeFile(path.join(folder, "notes.txt"), "not a song");

  const { registerRoutes } = await import("../../server/routes");
  app = express();
  app.use(express.json());
  await registerRoutes(createServer(app), app);
});

afterAll(async () => {
  delete process.env.HISTORY_FILE;
  delete process.env.SETTINGS_FILE;
  delete process.env.PLAYER_CACHE_DIR;
  delete process.env.TRASH_DIR;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("Music player (API)", () => {
  let tracks: Record<string, MusicTrack>;

  it("has no songs before a folder is chosen", async () => {
    const res = await request(app).get("/api/music");
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/choose a folder/i);
  });

  it("lists the songs in the Save to folder, with their tags", async () => {
    await request(app).put("/api/settings").send({ saveFolder: folder }).expect(200);
    const res = await request(app).get("/api/music");
    expect(res.status).toBe(200);
    const library = musicLibrarySchema.parse(res.body);
    expect(library.folder).toBe(folder);
    tracks = Object.fromEntries(library.tracks.map((track) => [track.path, track]));
    expect(Object.keys(tracks).sort()).toEqual([
      "Old Song.wma",
      path.join("Sine Wave", "Test Tone.mp3"),
      "With Cover.mp3",
    ]);
    expect(tracks[path.join("Sine Wave", "Test Tone.mp3")]).toMatchObject({
      title: "Test Tone",
      artist: "Sine Wave",
    });
    expect(tracks[path.join("Sine Wave", "Test Tone.mp3")].duration).toBeCloseTo(3, 0);
    expect(tracks["Old Song.wma"]).toMatchObject({ title: "Old Song", artist: null });
  });

  it("plays a song as it is, with range requests so the player can seek", async () => {
    const song = tracks[path.join("Sine Wave", "Test Tone.mp3")];
    const file = await fs.readFile(path.join(folder, song.path));

    const whole = await get(`/api/music/${song.id}`);
    expect(whole.status).toBe(200);
    expect(whole.headers["content-type"]).toMatch(/^audio\/mpeg/);
    expect(whole.headers["accept-ranges"]).toBe("bytes");
    expect(Buffer.compare(whole.body as Buffer, file)).toBe(0);

    const part = await get(`/api/music/${song.id}`).set("Range", "bytes=100-199");
    expect(part.status).toBe(206);
    expect(part.headers["content-range"]).toBe(`bytes 100-199/${file.length}`);
    expect(Buffer.compare(part.body as Buffer, file.subarray(100, 200))).toBe(0);
  });

  it("converts a song browsers can't play to FLAC (lossless), and keeps it for next time", async () => {
    const song = tracks["Old Song.wma"];
    const first = await get(`/api/music/${song.id}/flac`);
    expect(first.status).toBe(200);
    expect(first.headers["content-type"]).toMatch(/^audio\/flac/);
    expect((first.body as Buffer).subarray(0, 4).toString()).toBe("fLaC");

    const again = await get(`/api/music/${song.id}/flac`).set("Range", "bytes=0-3");
    expect(again.status).toBe(206);
    expect((again.body as Buffer).toString()).toBe("fLaC");
    expect(await fs.readdir(path.join(dir, "cache"))).toHaveLength(1);
  });

  it("sends a song's cover picture, and nothing for a song without one", async () => {
    const cover = await get(`/api/music/${tracks["With Cover.mp3"].id}/cover`);
    expect(cover.status).toBe(200);
    expect(cover.headers["content-type"]).toBe("image/png");
    expect(cover.headers["x-content-type-options"]).toBe("nosniff");
    expect((cover.body as Buffer).subarray(1, 4).toString()).toBe("PNG");

    const none = await get(`/api/music/${tracks["Old Song.wma"].id}/cover`);
    expect(none.status).toBe(204);
  });

  it("only plays songs the folder has, asked for by id — never a path", async () => {
    expect((await request(app).get("/api/music/AAAAAAAAAAAAAAAAAAAAAA")).status).toBe(404);
    expect((await request(app).get("/api/music/..%2F..%2Fsettings.json")).status).toBe(400);
    expect((await request(app).get("/api/music/not-an-id/flac")).status).toBe(400);
  });

  it("is only for this computer's own page", async () => {
    const song = tracks[path.join("Sine Wave", "Test Tone.mp3")];
    const otherSite = await request(app)
      .get(`/api/music/${song.id}`)
      .set("Sec-Fetch-Site", "cross-site");
    expect(otherSite.status).toBe(403);

    const otherDevice = await request(app).get("/api/music").set("X-Forwarded-For", "192.168.1.20");
    expect(otherDevice.status).toBe(403);
    expect(otherDevice.body.message).toMatch(/only in a browser on the computer running the app/i);
  });

  it("saves a playlist's songs in the folder as an .m3u8 playlist file, in its order", async () => {
    const songs = [
      { id: "4u7EnebtmKWzUH433cf5Qv", title: "Not Here", artists: "Nobody", duration: 200 },
      { id: "3n3Ppam7vgaVa1iaRUc9Lp", title: "Test Tone", artists: "Sine Wave", duration: 3 },
      { id: "dQw4w9WgXcQ", title: "Old Song", artists: "", duration: null },
    ];
    // The file the folder has for "Test Tone" (two of its files are tagged so).
    const found = await request(app).post("/api/folders/songs").send({ songs });
    const testTone = found.body.found["3n3Ppam7vgaVa1iaRUc9Lp"].file as string;
    expect(found.body.found["dQw4w9WgXcQ"].file).toBe("Old Song.wma");

    const res = await request(app)
      .post("/api/folders/playlist-file")
      .send({ name: "Road: Trip", songs });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ file: "Road - Trip.m3u8", songs: 2, missing: 1, replaced: false });
    const text = await fs.readFile(path.join(folder, "Road - Trip.m3u8"), "utf8");
    expect(text.split(/\r?\n/)).toEqual([
      "#EXTM3U",
      "#PLAYLIST:Road: Trip",
      "# Written by YouTube Audio Extractor",
      "#EXTINF:3,Sine Wave - Test Tone",
      testTone,
      "#EXTINF:-1,Old Song",
      "Old Song.wma",
      "",
    ]);

    // Saving again brings the app's own file up to date, in place.
    const again = await request(app)
      .post("/api/folders/playlist-file")
      .send({ name: "Road: Trip", songs: songs.slice(1, 2) });
    expect(again.body).toEqual({ file: "Road - Trip.m3u8", songs: 1, missing: 0, replaced: true });
    expect(await fs.readFile(path.join(folder, "Road - Trip.m3u8"), "utf8")).not.toMatch(/Old/);
  });

  it("won't save a playlist file with none of its songs, or for another device", async () => {
    const none = await request(app)
      .post("/api/folders/playlist-file")
      .send({
        name: "Empty",
        songs: [{ id: "4u7EnebtmKWzUH433cf5Qv", title: "Not Here", artists: "Nobody" }],
      });
    expect(none.status).toBe(409);
    expect(none.body.message).toMatch(/none of these songs/i);

    const badId = await request(app)
      .post("/api/folders/playlist-file")
      .send({ name: "Bad", songs: [{ id: "../../x", title: "x", artists: "" }] });
    expect(badId.status).toBe(400);

    const otherDevice = await request(app)
      .post("/api/folders/playlist-file")
      .set("X-Forwarded-For", "192.168.1.20")
      .send({
        name: "Road Trip",
        songs: [{ id: "dQw4w9WgXcQ", title: "With Cover", artists: "" }],
      });
    expect(otherDevice.status).toBe(403);
    await expect(fs.stat(path.join(folder, "Road Trip.m3u8"))).rejects.toThrow();
  });

  it("deletes a song from the folder to the bin, or for good only when asked", async () => {
    // Two copies of a song to delete, so the songs the other tests use stay.
    const original = path.join(folder, "Sine Wave", "Test Tone.mp3");
    await fs.copyFile(original, path.join(folder, "Tired Of It.mp3"));
    await fs.copyFile(original, path.join(folder, "Gone For Good.mp3"));
    const listed = musicLibrarySchema.parse((await request(app).get("/api/music")).body).tracks;
    const tired = listed.find((track) => track.path === "Tired Of It.mp3")!;
    const gone = listed.find((track) => track.path === "Gone For Good.mp3")!;

    // Only this computer's own page, and only as JSON.
    const otherDevice = await request(app)
      .delete(`/api/music/${tired.id}`)
      .set("X-Forwarded-For", "192.168.1.20")
      .send({});
    expect(otherDevice.status).toBe(403);
    const otherSite = await request(app)
      .delete(`/api/music/${tired.id}`)
      .set("Sec-Fetch-Site", "cross-site")
      .send({});
    expect(otherSite.status).toBe(403);
    expect((await request(app).delete(`/api/music/${tired.id}`)).status).toBe(415);
    expect((await request(app).delete("/api/music/..%2Fhistory.json").send({})).status).toBe(400);
    await fs.stat(path.join(folder, "Tired Of It.mp3"));

    // To the bin, where it can be put back from.
    const res = await request(app).delete(`/api/music/${tired.id}`).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      trashed: true,
      bin: process.platform === "win32" ? "Recycle Bin" : "Trash",
    });
    await expect(fs.stat(path.join(folder, "Tired Of It.mp3"))).rejects.toThrow();
    const binned = await fs.readFile(path.join(dir, "bin", "files", "Tired Of It.mp3"));
    expect(Buffer.compare(binned, await fs.readFile(original))).toBe(0);
    expect((await request(app).get(`/api/music/${tired.id}`)).status).toBe(404);
    expect((await request(app).delete(`/api/music/${tired.id}`).send({})).status).toBe(404);

    // For good, when the page says so.
    const forGood = await request(app).delete(`/api/music/${gone.id}`).send({ permanently: true });
    expect(forGood.status).toBe(200);
    expect(forGood.body.trashed).toBe(false);
    await expect(fs.stat(path.join(folder, "Gone For Good.mp3"))).rejects.toThrow();
    await expect(fs.stat(path.join(dir, "bin", "files", "Gone For Good.mp3"))).rejects.toThrow();

    const after = musicLibrarySchema.parse((await request(app).get("/api/music")).body).tracks;
    expect(after.map((track) => track.path).sort()).toEqual([
      "Old Song.wma",
      path.join("Sine Wave", "Test Tone.mp3"),
      "With Cover.mp3",
    ]);
  });

  it("spots a song that's another kind of audio than its name says, and a file that isn't audio", async () => {
    // An M4A named .mp3 (the kind of file that plays wrong), and a program named .mp3.
    await tone(path.join(folder, "Really M4A.mp3"), 2, ["-c:a", "aac", "-f", "mp4"]);
    await fs.writeFile(
      path.join(folder, "Not A Song.mp3"),
      Buffer.concat([Buffer.from("MZ"), Buffer.alloc(4000)]),
    );
    const listed = musicLibrarySchema.parse((await request(app).get("/api/music")).body).tracks;
    const m4a = listed.find((track) => track.path === "Really M4A.mp3")!;
    const program = listed.find((track) => track.path === "Not A Song.mp3")!;
    expect(m4a).toMatchObject({ realType: ".m4a", notAudio: null });
    expect(program).toMatchObject({ realType: null, notAudio: "a Windows program" });
    expect(tracks[path.join("Sine Wave", "Test Tone.mp3")]).toMatchObject({
      realType: null,
      notAudio: null,
    });

    // The M4A is sent as what it is; the program isn't sent, converted or read at all.
    const played = await get(`/api/music/${m4a.id}`);
    expect(played.status).toBe(200);
    expect(played.headers["content-type"]).toBe("audio/mp4");
    for (const url of [
      `/api/music/${program.id}`,
      `/api/music/${program.id}/flac`,
      `/api/music/${program.id}/cover`,
    ]) {
      const res = await request(app).get(url);
      expect(res.status).toBe(415);
      expect(res.body.message).toMatch(/a Windows program/);
    }
    expect((await request(app).post(`/api/music/${program.id}/fix-name`).send({})).status).toBe(
      415,
    );

    // Fix name: the M4A gets its own extension — and only from this computer's page.
    const otherDevice = await request(app)
      .post(`/api/music/${m4a.id}/fix-name`)
      .set("X-Forwarded-For", "192.168.1.20")
      .send({});
    expect(otherDevice.status).toBe(403);
    const fixed = await request(app).post(`/api/music/${m4a.id}/fix-name`).send({});
    expect(fixed.status).toBe(200);
    expect(fixed.body.path).toBe("Really M4A.m4a");
    await expect(fs.stat(path.join(folder, "Really M4A.mp3"))).rejects.toThrow();
    const after = musicLibrarySchema.parse((await request(app).get("/api/music")).body).tracks;
    expect(after.find((track) => track.id === fixed.body.id)).toMatchObject({
      path: "Really M4A.m4a",
      realType: null,
    });
    const again = await request(app).post(`/api/music/${fixed.body.id}/fix-name`).send({});
    expect(again.status).toBe(409);

    // The program can still be deleted.
    expect(
      (await request(app).delete(`/api/music/${program.id}`).send({ permanently: true })).status,
    ).toBe(200);
    await expect(fs.stat(path.join(folder, "Not A Song.mp3"))).rejects.toThrow();
    await fs.rm(path.join(folder, "Really M4A.m4a"));
  });

  it("renames a song for Sanitize Filename: its extension kept, a taken name numbered, a case change as it is", async () => {
    const source = path.join(folder, "Sine Wave", "Test Tone.mp3");
    const sub = path.join(folder, "Sanitize");
    await fs.mkdir(sub);
    for (const name of ["Junoon - Heer (Official Audio).mp3", "Junoon - Heer.mp3", "lithium.mp3"]) {
      await fs.copyFile(source, path.join(sub, name));
    }
    const listed = musicLibrarySchema.parse((await request(app).get("/api/music")).body).tracks;
    const idOf = (name: string) => listed.find((t) => t.path === path.join("Sanitize", name))!.id;
    const rename = (id: string, name: unknown) =>
      request(app).post(`/api/music/${id}/rename`).send({ name });

    const noisy = idOf("Junoon - Heer (Official Audio).mp3");
    expect(
      (await rename(noisy, "Junoon - Heer").set("X-Forwarded-For", "192.168.1.20")).status,
    ).toBe(403);
    expect((await rename(noisy, "  ")).status).toBe(400);
    const renamed = await rename(noisy, "Junoon - Heer");
    expect(renamed.status).toBe(200);
    // "Junoon - Heer.mp3" is taken: a number, never over the other song.
    expect(renamed.body.track).toMatchObject({
      path: path.join("Sanitize", "Junoon - Heer (1).mp3"),
    });
    expect(renamed.body.track.id).not.toBe(noisy);
    expect((await fs.readdir(sub)).sort()).toEqual([
      "Junoon - Heer (1).mp3",
      "Junoon - Heer.mp3",
      "lithium.mp3",
    ]);

    const caseOnly = await rename(idOf("lithium.mp3"), "Lithium.mp3");
    expect(caseOnly.body.track.path).toBe(path.join("Sanitize", "Lithium.mp3"));
    expect(await fs.readdir(sub)).toContain("Lithium.mp3");
    expect((await rename(caseOnly.body.track.id, "Lithium")).status).toBe(409);
    expect((await rename(noisy, "Gone")).status).toBe(404);

    // Rename: a new title and artist over the ones it has, and a new file name, at once.
    const both = await request(app)
      .post(`/api/music/${caseOnly.body.track.id}/rename`)
      .send({ name: "Nirvana - Lithium", title: "Lithium", artist: "Nirvana" });
    expect(both.status).toBe(200);
    expect(both.body.track).toMatchObject({
      path: path.join("Sanitize", "Nirvana - Lithium.mp3"),
      title: "Lithium",
      artist: "Nirvana",
    });
    const { common } = await parseFile(path.join(sub, "Nirvana - Lithium.mp3"));
    expect([common.title, common.artist]).toEqual(["Lithium", "Nirvana"]);
    const same = await request(app)
      .post(`/api/music/${both.body.track.id}/rename`)
      .send({ title: "Lithium" });
    expect(same.status).toBe(409);
    expect(
      (await request(app).post(`/api/music/${both.body.track.id}/rename`).send({})).status,
    ).toBe(400);
    await fs.rm(sub, { recursive: true });
  });

  it("forgets the old folder's songs when the Save to folder changes", async () => {
    const song = tracks[path.join("Sine Wave", "Test Tone.mp3")];
    const other = path.join(dir, "Other");
    await fs.mkdir(other);
    await request(app).put("/api/settings").send({ saveFolder: other }).expect(200);
    expect((await request(app).get(`/api/music/${song.id}`)).status).toBe(404);
    expect((await request(app).get("/api/music")).body.tracks).toEqual([]);
  });
});
