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
import { facetChoicesOf, facetCounts, folderTrack, matchChoices } from "../../client/src/lib/music";
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
  process.env.DETAILS_NOT_FOUND_FILE = path.join(dir, "details-not-found.json");
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
  delete process.env.DETAILS_NOT_FOUND_FILE;
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
    // Only the title and artist went to iTunes; it has no cover, so the others were asked
    // for one too, and having none, iTunes' answer is used.
    expect(asked[0].searchParams.get("term")).toBe("Sine Wave Test Tone");
    expect(new Set(asked.map((url) => url.hostname))).toEqual(
      new Set(["itunes.apple.com", "api.deezer.com", "musicbrainz.org"]),
    );

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
    // The genre filter offers it, found by typing a few letters of it.
    const listed = Object.values(await songs()).map(folderTrack);
    const genres = facetChoicesOf("genre", facetCounts(listed, "genre"));
    expect(matchChoices(genres, "elec").map((choice) => choice.text)).toEqual(["Electronic (1)"]);
  });

  it("finds nothing for a song the catalogues don't have, writes nothing, and marks it Not found", async () => {
    const before = (await songs())["Rock Song.mp3"];
    expect(before.detailsNotFound).toBe(false);
    const res = await request(app).get(`/api/music/${before.id}/details`).expect(200);
    expect(res.body).toMatchObject({ writable: true, found: null, notFound: true });
    // Kept on disk, and in the list.
    expect((await songs())["Rock Song.mp3"].detailsNotFound).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(dir, "details-not-found.json"), "utf8"))).toEqual(
      { "Rock Song.mp3": before.size },
    );
  });

  it("takes the title and artist from an untagged “Artist - Song” name no catalogue has", async () => {
    await tone(path.join(folder, "Sine Wave - Rare Tone.mp3"), [
      ...["-c:a", "libmp3lame", "-b:a", "128k"],
    ]);
    const { id } = (await songs())["Sine Wave - Rare Tone.mp3"];
    const lookup = songLookupSchema.parse(
      (await request(app).get(`/api/music/${id}/details`).expect(200)).body,
    );
    expect(lookup).toMatchObject({
      source: "name",
      match: null,
      found: { title: "Rare Tone", artist: "Sine Wave" },
    });
    await request(app).post(`/api/music/${id}/details`).send(lookup.found).expect(200);
    expect((await songs())["Sine Wave - Rare Tone.mp3"]).toMatchObject({
      title: "Rare Tone",
      artist: "Sine Wave",
    });
    const log = (await request(app).get("/api/details-log").expect(200)).text;
    expect(log).toContain("no catalogue has it: from its file name; title Rare Tone");
    await fs.rm(path.join(folder, "Sine Wave - Rare Tone.mp3"));
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
      /look-up {2}Rock Song\.mp3 {2}not found: lacks artist, album, year, track, cover; marked Not found: no catalogue has it; iTunes, “Rock Song”: nothing came back; Deezer, “Rock Song”: nothing came back; MusicBrainz, “Rock Song”: nothing came back$/,
    );
    expect(lines.some((line) => line.includes("Misnamed.mp3  can't be written"))).toBe(true);
  });

  it("offers another version's genre, and only that, saying so", async () => {
    // Twenty seconds long: the catalogue's three-second "Test Tone" is another version of it.
    const file = path.join(folder, "Sine Wave - Test Tone (Extended).mp3");
    await ffmpeg([
      ...["-f", "lavfi", "-i", "sine=frequency=440:duration=20"],
      ...["-c:a", "libmp3lame", "-b:a", "128k", file],
    ]);
    try {
      const { id } = (await songs())["Sine Wave - Test Tone (Extended).mp3"];
      const res = await request(app).get(`/api/music/${id}/details`).expect(200);
      expect(res.body).toMatchObject({
        found: { genre: "Electronic" },
        match: { title: "Test Tone", note: "another version of it, for its genre only" },
        source: "itunes",
      });
      expect(Object.keys(res.body.found)).toEqual(["genre"]);
    } finally {
      await fs.rm(file, { force: true });
    }
  });

  it("guesses a genre no catalogue has from the artist's other songs in the folder, saying so", async () => {
    // Test Tone, by Sine Wave, is Electronic (written above); no catalogue has Low Tone.
    const file = path.join(folder, "Low Tone.mp3");
    await tone(file, [
      ...["-c:a", "libmp3lame", "-b:a", "128k", "-id3v2_version", "3"],
      ...["-metadata", "title=Low Tone", "-metadata", "artist=Sine Wave"],
    ]);
    try {
      const { id } = (await songs())["Low Tone.mp3"];
      const lookup = songLookupSchema.parse(
        (await request(app).get(`/api/music/${id}/details`).expect(200)).body,
      );
      expect(lookup).toMatchObject({
        found: { genre: "Electronic" },
        match: null,
        source: "artist",
        guess: "another song of Sine Wave's here is Electronic",
        notFound: true,
      });
      expect(Object.keys(lookup.found!)).toEqual(["genre"]);
      await request(app).post(`/api/music/${id}/details`).send(lookup.found).expect(200);
      expect((await songs())["Low Tone.mp3"].genres).toEqual(["Electronic"]);
      const log = (await request(app).get("/api/details-log").expect(200)).text;
      expect(log).toContain(
        "no catalogue has it; genre Electronic; genre guessed from the artist (another song of Sine Wave's here is Electronic)",
      );
    } finally {
      await fs.rm(file, { force: true });
    }
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
