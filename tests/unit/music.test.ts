import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { FFMPEG_PATH } from "../../server/audio";
import type { AudioFile } from "../../server/library";
import {
  convertedForBrowser,
  ffmpegFlacArgs,
  findMusicFile,
  listMusic,
  musicTrackId,
  pruneConversionCache,
  readCover,
  toMusicTrack,
} from "../../server/music";
import { audioTypeOf, extensionOf, songNameOf } from "../../shared/audio-types";
import { musicIdSchema } from "../../shared/schema";

/** Runs ffmpeg with `args` (no output expected on stdout). */
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

/** `seconds` of tone, encoded by ffmpeg as `codecArgs` say, at `file`. */
const tone = (file: string, seconds: number, codecArgs: string[]) =>
  ffmpeg(["-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`, ...codecArgs, file]);

const audioFile = (relative: string, extra: Partial<AudioFile> = {}): AudioFile => ({
  absolute: path.join("C:\\Music", relative),
  relative,
  size: 1000,
  mtimeMs: 0,
  addedMs: Date.UTC(2026, 9, 2, 12),
  ...extra,
});

let root: string;
let cache: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-music-"));
  cache = path.join(root, "cache");
  process.env.PLAYER_CACHE_DIR = cache;
});

afterAll(async () => {
  delete process.env.PLAYER_CACHE_DIR;
  await fs.rm(root, { recursive: true, force: true });
});

describe("audio types", () => {
  it("knows audio files by their extension, in any case", () => {
    expect(extensionOf("Queen\\Song.MP3")).toBe(".mp3");
    expect(extensionOf("no extension")).toBe("");
    expect(audioTypeOf("a.opus")).toEqual({ mime: "audio/ogg", check: 'audio/ogg; codecs="opus"' });
    expect(audioTypeOf("a.WMA")?.mime).toBe("audio/x-ms-wma");
    expect(audioTypeOf("notes.txt")).toBeUndefined();
    expect(audioTypeOf("a.constructor")).toBeUndefined();
  });

  it("names a song with no title tag after its file", () => {
    expect(songNameOf("Queen\\Greatest Hits\\Bohemian Rhapsody.mp3")).toBe("Bohemian Rhapsody");
    expect(songNameOf("jawed - Me at the zoo.opus")).toBe("jawed - Me at the zoo");
    expect(songNameOf(".mp3")).toBe(".mp3");
  });
});

describe("musicTrackId", () => {
  it("is the same for the same file, different for another, and safe in a URL", () => {
    const id = musicTrackId("C:\\Music", "Queen\\Song.mp3");
    expect(id).toBe(musicTrackId("C:\\Music", "Queen\\Song.mp3"));
    expect(id).not.toBe(musicTrackId("C:\\Music", "Queen\\Other.mp3"));
    expect(id).not.toBe(musicTrackId("D:\\Music", "Queen\\Song.mp3"));
    expect(musicIdSchema.safeParse(id).success).toBe(true);
  });
});

describe("toMusicTrack", () => {
  it("shows a song's tags, or its file name when it has no title", () => {
    const file = audioFile("Queen\\Bohemian Rhapsody.mp3");
    expect(
      toMusicTrack("C:\\Music", file, {
        title: "Bohemian Rhapsody",
        trackArtist: "Queen",
        album: "A Night at the Opera",
        duration: 354.3,
        spotifyIds: [],
      }),
    ).toEqual({
      id: musicTrackId("C:\\Music", file.relative),
      path: file.relative,
      title: "Bohemian Rhapsody",
      artist: "Queen",
      album: "A Night at the Opera",
      duration: 354.3,
      addedAt: "2026-10-02T12:00:00.000Z",
      size: 1000,
    });
    expect(toMusicTrack("C:\\Music", file, { spotifyIds: [] })).toMatchObject({
      title: "Bohemian Rhapsody",
      artist: null,
      album: null,
      duration: null,
    });
  });
});

describe("listMusic and findMusicFile", () => {
  it("list the folder's songs with their tags, and find each one by its id", async () => {
    const folder = path.join(root, "library");
    await fs.mkdir(path.join(folder, "Sine Wave"), { recursive: true });
    await tone(path.join(folder, "Sine Wave", "a.mp3"), 2, [
      ...["-c:a", "libmp3lame", "-b:a", "128k", "-id3v2_version", "3"],
      ...["-metadata", "title=Test Tone", "-metadata", "artist=Sine Wave"],
      ...["-metadata", "album=Tests"],
    ]);
    await tone(path.join(folder, "Old Song.wma"), 1, ["-c:a", "wmav2"]);
    // Long enough that its length is only at the end of the file.
    await tone(path.join(folder, "Original.opus"), 40, ["-c:a", "libopus"]);
    await fs.writeFile(path.join(folder, "cover.jpg"), "not a song");

    const library = await listMusic(folder);
    expect(library.folder).toBe(folder);
    expect(library.complete).toBe(true);
    const byPath = Object.fromEntries(library.tracks.map((t) => [t.path, t]));
    expect(Object.keys(byPath).sort()).toEqual([
      "Old Song.wma",
      "Original.opus",
      path.join("Sine Wave", "a.mp3"),
    ]);
    expect(byPath["Original.opus"].duration).toBeCloseTo(40, 0);
    const mp3 = byPath[path.join("Sine Wave", "a.mp3")];
    expect(mp3).toMatchObject({ title: "Test Tone", artist: "Sine Wave", album: "Tests" });
    expect(mp3.duration).toBeCloseTo(2, 0);
    expect(byPath["Old Song.wma"]).toMatchObject({ title: "Old Song", artist: null });
    expect(Date.parse(mp3.addedAt)).toBeGreaterThan(Date.now() - 60_000);

    const found = await findMusicFile(folder, mp3.id);
    expect(found?.absolute).toBe(path.join(folder, "Sine Wave", "a.mp3"));
    // Only ever a song the scan found, in the folder asked about.
    expect(await findMusicFile(folder, musicTrackId(folder, "cover.jpg"))).toBeUndefined();
    expect(await findMusicFile(path.join(root, "elsewhere"), mp3.id).catch(() => "no folder")).toBe(
      "no folder",
    );

    // A song added since the list was made is found by looking again; a
    // deleted one isn't found any more.
    await tone(path.join(folder, "new.mp3"), 1, ["-c:a", "libmp3lame"]);
    expect((await findMusicFile(folder, musicTrackId(folder, "new.mp3")))?.relative).toBe(
      "new.mp3",
    );
    await fs.rm(path.join(folder, "Sine Wave", "a.mp3"));
    expect(await findMusicFile(folder, mp3.id)).toBeUndefined();
  });
});

describe("readCover", () => {
  it("finds the picture a song carries, and nothing in one without", async () => {
    const dir = path.join(root, "covers");
    await fs.mkdir(dir, { recursive: true });
    const picture = path.join(dir, "cover.png");
    await ffmpeg(["-f", "lavfi", "-i", "color=c=red:s=16x16", "-frames:v", "1", picture]);
    const plain = path.join(dir, "plain.mp3");
    await tone(plain, 1, ["-c:a", "libmp3lame"]);
    const withCover = path.join(dir, "with cover.mp3");
    await ffmpeg([
      ...["-i", plain, "-i", picture, "-map", "0:a", "-map", "1:v", "-c", "copy"],
      ...["-id3v2_version", "3", "-metadata:s:v", "comment=Cover (front)", withCover],
    ]);

    const cover = await readCover(audioFile("with cover.mp3", { absolute: withCover }));
    expect(cover?.type).toBe("image/png");
    expect(Buffer.from(cover!.data).subarray(1, 4).toString()).toBe("PNG");
    expect(await readCover(audioFile("plain.mp3", { absolute: plain }))).toBeUndefined();
  });
});

describe("converting a song a browser can't play", () => {
  it("makes FLAC of the first audio stream only", () => {
    const args = ffmpegFlacArgs("C:\\Music\\a.wma", "C:\\cache\\a.flac.part");
    expect(args[args.indexOf("-i") + 1]).toBe("C:\\Music\\a.wma");
    expect(args[args.indexOf("-c:a") + 1]).toBe("flac");
    expect(args[args.indexOf("-map") + 1]).toBe("0:a:0");
    expect(args.at(-1)).toBe("C:\\cache\\a.flac.part");
  });

  it("converts once, keeps the result, and shares the work between requests", async () => {
    const source = path.join(root, "convert", "song.wma");
    await fs.mkdir(path.dirname(source), { recursive: true });
    await tone(source, 3, ["-c:a", "wmav2"]);
    const stat = await fs.stat(source);
    const file = audioFile("song.wma", {
      absolute: source,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });

    const [first, second] = await Promise.all([
      convertedForBrowser(file),
      convertedForBrowser(file),
    ]);
    expect(second).toBe(first);
    expect(path.dirname(first)).toBe(cache);
    const flac = await fs.readFile(first);
    expect(flac.subarray(0, 4).toString()).toBe("fLaC");
    // No unfinished files left behind.
    expect((await fs.readdir(cache)).filter((name) => name.endsWith(".part"))).toEqual([]);

    // Again: straight from the cache.
    const started = Date.now();
    expect(await convertedForBrowser(file)).toBe(first);
    expect(Date.now() - started).toBeLessThan(1000);

    // A changed file is converted afresh.
    expect(await convertedForBrowser({ ...file, mtimeMs: file.mtimeMs + 1 })).not.toBe(first);
  });

  it("stops when nobody wants it any more, leaving nothing behind", async () => {
    const source = path.join(root, "convert", "long.wma");
    await tone(source, 60, ["-c:a", "wmav2"]);
    const file = audioFile("long.wma", { absolute: source, size: 1, mtimeMs: 1 });
    const before = await fs.readdir(cache);

    const controller = new AbortController();
    const converting = convertedForBrowser(file, controller.signal);
    controller.abort();
    await expect(converting).rejects.toMatchObject({ name: "AbortError" });

    // ffmpeg is stopped and its unfinished file removed.
    await expect
      .poll(async () => (await fs.readdir(cache)).filter((name) => !before.includes(name)))
      .toEqual([]);
  });

  it("explains a song ffmpeg can't read", async () => {
    const broken = path.join(root, "convert", "broken.wma");
    await fs.writeFile(broken, "not really audio");
    await expect(
      convertedForBrowser(audioFile("broken.wma", { absolute: broken, size: 16, mtimeMs: 2 })),
    ).rejects.toThrow(/./);
  });
});

describe("pruneConversionCache", () => {
  it("deletes the conversions played longest ago once it holds too much, and old leftovers", async () => {
    const dir = path.join(root, "prune");
    await fs.mkdir(dir, { recursive: true });
    const make = async (name: string, bytes: number, minutesAgo: number) => {
      const file = path.join(dir, name);
      await fs.writeFile(file, Buffer.alloc(bytes));
      const when = new Date(Date.now() - minutesAgo * 60_000);
      await fs.utimes(file, when, when);
    };
    await make("newest.flac", 600, 1);
    await make("older.flac", 300, 10);
    await make("oldest.flac", 300, 100);
    await make("left behind.flac.1234.part", 10, 3 * 24 * 60);
    await make("converting.flac.5678.part", 10, 0);

    await pruneConversionCache(dir, 1000);
    expect((await fs.readdir(dir)).sort()).toEqual([
      "converting.flac.5678.part",
      "newest.flac",
      "older.flac",
    ]);

    // The newest conversion stays even when it alone is too big.
    await pruneConversionCache(dir, 100);
    expect((await fs.readdir(dir)).sort()).toEqual(["converting.flac.5678.part", "newest.flac"]);
  });
});
