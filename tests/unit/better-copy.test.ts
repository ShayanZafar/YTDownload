import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import type { SearchResult } from "../../shared/schema";
import type { AudioLink } from "../../shared/soundcloud-link";
import { FFMPEG_PATH, kbpsOfStream, type AudioInfo } from "../../server/audio";
import {
  BetterCopyError,
  betterCopyArgs,
  betterCopyQuery,
  codecName,
  findBetterCopy,
  replaceWithBetterCopy,
} from "../../server/better-copy";
import { parseFile, type AudioFile } from "../../server/library";
import { readCover } from "../../server/music";
import { sameSongAs } from "../../server/search";

// Housekeeping's better copies (server/better-copy.ts), on songs ffmpeg makes
// here: the search and the look-ups are stand-ins, and yt-dlp's audio stream
// is a Node process playing an ffmpeg-made file. No network.

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

let root: string;
let folder: string;
let cover: string;
/** What "YouTube" sends: Opus in WebM, as its best audio is, 20 s and 10 s long. */
let opus20: string;
let opus10: string;

const tone = (seconds: number) => `sine=frequency=440:duration=${seconds}`;

/** A song in the folder: `seconds` of a tone at `kbps`, tagged, with a cover. */
async function song(name: string, kbps: number, seconds = 20): Promise<AudioFile> {
  const absolute = path.join(folder, name);
  const ext = path.extname(name);
  await ffmpeg([
    ...["-f", "lavfi", "-i", tone(seconds)],
    ...(ext === ".mp3" ? ["-i", cover, "-map", "0:a", "-map", "1:v", "-c:v", "copy"] : []),
    ...(ext === ".mp3" ? ["-disposition:v", "attached_pic", "-id3v2_version", "3"] : []),
    ...(ext === ".mp3" ? ["-c:a", "libmp3lame"] : ext === ".flac" ? [] : ["-c:a", "libopus"]),
    ...(ext === ".flac" ? [] : ["-b:a", `${kbps}k`]),
    ...["-metadata", "title=Low Tone", "-metadata", "artist=Sine Wave"],
    ...["-metadata", "album=Tests", "-metadata", "genre=Electronic", absolute],
  ]);
  // An old song: its dates are kept by the copy that replaces it.
  const old = new Date("2024-03-01T12:00:00Z");
  await fs.utimes(absolute, old, old);
  const stat = await fs.stat(absolute);
  return {
    absolute,
    relative: name,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    addedMs: stat.mtimeMs,
  };
}

/** yt-dlp's audio stream, played by a Node process sending `file`. */
const playing = (file: string) => () =>
  spawn(
    process.execPath,
    ["-e", "require('fs').createReadStream(process.argv[1]).pipe(process.stdout)", file],
    { windowsHide: true },
  );

const result = (
  id: string,
  title: string,
  duration: number | null,
  channel = "",
): SearchResult => ({
  id,
  url: `https://www.youtube.com/watch?v=${id}`,
  title,
  channel,
  duration,
  thumbnail: "",
  official: false,
  source: "youtube",
});

const opusInfo = (abr: number): AudioInfo => ({
  title: "Low Tone",
  formatId: "251",
  acodec: "opus",
  abr,
});

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-better-copy-"));
  folder = path.join(root, "Music");
  await fs.mkdir(folder, { recursive: true });
  process.env.TRASH_DIR = path.join(root, "trash");
  cover = path.join(root, "cover.jpg");
  await ffmpeg(["-f", "lavfi", "-i", "color=c=red:s=32x32", "-frames:v", "1", cover]);
  opus20 = path.join(root, "youtube-20.webm");
  opus10 = path.join(root, "youtube-10.webm");
  for (const [file, seconds] of [
    [opus20, 20],
    [opus10, 10],
  ] as const) {
    await ffmpeg(["-f", "lavfi", "-i", tone(seconds), "-c:a", "libopus", "-b:a", "128k", file]);
  }
});

afterAll(async () => {
  delete process.env.TRASH_DIR;
  await fs.rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.rm(process.env.TRASH_DIR!, { recursive: true, force: true });
});

describe("Better copies: the pure parts", () => {
  it("names a stream's codec and bitrate as yt-dlp gives them", () => {
    expect(codecName("opus")).toBe("Opus");
    expect(codecName("mp4a.40.2")).toBe("AAC");
    expect(codecName("mp3")).toBe("MP3");
    expect(codecName(undefined)).toBe(null);
    expect(kbpsOfStream({ abr: 129.478 })).toEqual({ abr: 129 });
    expect(kbpsOfStream({ tbr: 128 })).toEqual({ abr: 128 });
    expect(kbpsOfStream({})).toEqual({});
  });

  it("searches for the artist and title, and takes only the same song at its length", () => {
    expect(betterCopyQuery({ artist: "Linkin Park", title: "Numb" })).toEqual({
      youtube: "Linkin Park Numb audio",
      soundCloud: "Linkin Park Numb",
      words: "Linkin Park Numb",
    });
    expect(betterCopyQuery({ artist: null, title: "Numb" }).youtube).toBe("Numb audio");
    const words = "Linkin Park Numb";
    expect(sameSongAs(words, result("a", "Numb (Official Audio)", 187, "Linkin Park"), 185)).toBe(
      true,
    );
    expect(sameSongAs(words, result("b", "Linkin Park - Numb", 195, ""), 185)).toBe(false);
    expect(sameSongAs(words, result("c", "Numb (Live in Texas)", 186, "Linkin Park"), 185)).toBe(
      false,
    );
    expect(sameSongAs(words, result("d", "Numb", 185, "Some Covers"), 185)).toBe(false);
    expect(sameSongAs(words, result("e", "Linkin Park - Numb", null, ""), 185)).toBe(false);
  });

  it("writes the song's own type with its tags and cover: an MP3 at 320 kbps, Opus copied as it is", () => {
    const mp3 = betterCopyArgs("old.mp3", "new.part", ".mp3", "opus").join(" ");
    expect(mp3).toBe(
      "-hide_banner -loglevel error -i pipe:0 -i old.mp3 -map 0:a:0 -map 1:v? -c:v copy -disposition:v attached_pic -c:a libmp3lame -b:a 320k -map_metadata 1 -map_metadata:s:a:0 1:s:a:0 -id3v2_version 3 -f mp3 -y new.part",
    );
    expect(betterCopyArgs("old.opus", "new.part", ".opus", "opus").join(" ")).toContain(
      "-map 0:a:0 -c:a copy -map_metadata 1",
    );
    expect(betterCopyArgs("old.m4a", "new.part", ".m4a", "opus").join(" ")).toContain(
      "-c:a aac -b:a 320k",
    );
    expect(betterCopyArgs("old.m4a", "new.part", ".m4a", "mp4a.40.2").join(" ")).toContain(
      "-c:a copy",
    );
    expect(() => betterCopyArgs("old.ape", "new.part", ".ape", "opus")).toThrow();
  });
});

describe("findBetterCopy", () => {
  it("offers the same song at its length with the highest bitrate, if it's higher than the song's", async () => {
    const file = await song("Sine Wave - Low Tone.mp3", 64);
    const search = vi.fn(async () => ({
      source: "youtube" as const,
      results: [
        result("aaaaaaaaaaa", "Sine Wave - Low Tone (Live)", 20),
        result("bbbbbbbbbbb", "Sine Wave - Low Tone (Extended)", 300),
        result("ccccccccccc", "Low Tone", 21, "Sine Wave"),
        result("ddddddddddd", "Sine Wave - Low Tone", 19),
      ],
    }));
    const asked: string[] = [];
    const lookUp = vi.fn(async (link: AudioLink) => {
      asked.push(link.url);
      return opusInfo(link.url.endsWith("ccccccccccc") ? 70 : 130);
    });
    expect(await findBetterCopy(file, { search, lookUp })).toEqual({
      kbps: 64,
      copy: {
        url: "https://www.youtube.com/watch?v=ddddddddddd",
        title: "Sine Wave - Low Tone",
        channel: "",
        source: "youtube",
        seconds: 19,
        kbps: 130,
        codec: "Opus",
      },
      reason: null,
    });
    expect(search).toHaveBeenCalledWith("Sine Wave Low Tone audio", {
      targetDuration: expect.closeTo(20, 0),
      soundCloudQuery: "Sine Wave Low Tone",
    });
    // Only the same song at its length is looked up: not the live one, nor the extended one.
    expect(asked.sort()).toEqual([
      "https://www.youtube.com/watch?v=ccccccccccc",
      "https://www.youtube.com/watch?v=ddddddddddd",
    ]);
  });

  it("says why there's none: no better bitrate, no same length, nothing found, lossless", async () => {
    const file = await song("Sine Wave - Low Tone.mp3", 160);
    const found = async () => ({
      source: "youtube" as const,
      results: [result("ddddddddddd", "Sine Wave - Low Tone", 20)],
    });
    expect(
      await findBetterCopy(file, { search: found, lookUp: async () => opusInfo(130) }),
    ).toEqual({
      kbps: 160,
      copy: null,
      reason: "The best copy found (YouTube) is 130 kbps: no better than this one's 160 kbps.",
    });
    const longer = async () => ({
      source: "youtube" as const,
      results: [result("ddddddddddd", "Sine Wave - Low Tone", 200)],
    });
    expect((await findBetterCopy(file, { search: longer })).reason).toBe(
      "No upload of “Sine Wave Low Tone” found is the same length (0:20).",
    );
    const nothing = async () => ({ source: "youtube" as const, results: [] });
    expect((await findBetterCopy(file, { search: nothing })).reason).toBe(
      "Nothing was found for “Sine Wave Low Tone”.",
    );
    const search = vi.fn(found);
    const flac = await song("Lossless.flac", 0);
    expect(await findBetterCopy(flac, { search })).toMatchObject({
      kbps: null,
      copy: null,
      reason: "It's lossless already: no copy online is better.",
    });
    expect(search).not.toHaveBeenCalled();
  });

  it("fails only when every look-up failed, with the first one's error", async () => {
    const file = await song("Sine Wave - Low Tone.mp3", 64);
    const search = async () => ({
      source: "youtube" as const,
      results: [result("ddddddddddd", "Sine Wave - Low Tone", 20)],
    });
    await expect(
      findBetterCopy(file, {
        search,
        lookUp: async () => {
          throw new Error("Video unavailable");
        },
      }),
    ).rejects.toThrow("Video unavailable");
  });
});

describe("replaceWithBetterCopy", () => {
  it("makes an MP3 a 320 kbps MP3 with its tags, cover and dates, the old one to the bin", async () => {
    const file = await song("Sine Wave - Low Tone.mp3", 64);
    const before = await fs.readFile(file.absolute);
    const check = await replaceWithBetterCopy(file, "https://youtu.be/ddddddddddd", {
      lookUp: async () => opusInfo(130),
      spawnSource: playing(opus20),
    });
    expect(check).toMatchObject({ cutShort: null, damaged: null, kbps: 320, lossless: false });
    expect(check.seconds).toBeCloseTo(20, 0);

    const { common, format } = await parseFile(file.absolute, { duration: true });
    expect(format.codec).toMatch(/MPEG 1 Layer 3/);
    expect(Math.round(format.bitrate! / 1000)).toBe(320);
    expect(common).toMatchObject({
      title: "Low Tone",
      artist: "Sine Wave",
      album: "Tests",
      genre: ["Electronic"],
    });
    expect(await readCover(file)).toMatchObject({ type: "image/jpeg" });
    expect((await fs.stat(file.absolute)).mtime.toISOString()).toBe("2024-03-01T12:00:00.000Z");
    // The old song is in the bin, as it was; nothing else is left in the folder.
    const binned = await fs.readFile(
      path.join(process.env.TRASH_DIR!, "files", "Sine Wave - Low Tone.mp3"),
    );
    expect(binned.equals(before)).toBe(true);
    expect((await fs.readdir(folder)).filter((name) => name.includes("Low Tone"))).toEqual([
      "Sine Wave - Low Tone.mp3",
    ]);
  });

  it("copies Opus into an .opus song as it is, keeping its tags", async () => {
    const file = await song("Low Tone.opus", 48);
    const check = await replaceWithBetterCopy(file, "https://youtu.be/ddddddddddd", {
      lookUp: async () => opusInfo(130),
      spawnSource: playing(opus20),
    });
    expect(check.codec).toBe("Opus");
    expect(check.kbps).toBeGreaterThan(100);
    const { common } = await parseFile(file.absolute, { duration: true });
    expect(common).toMatchObject({ title: "Low Tone", artist: "Sine Wave", album: "Tests" });
  });

  it("lets one change at a time at a song: a second replace while one runs gets a 409", async () => {
    const file = await song("Busy Tone.opus", 48);
    const deps = { lookUp: async () => opusInfo(130), spawnSource: playing(opus20) };
    const first = replaceWithBetterCopy(file, "https://youtu.be/ddddddddddd", deps);
    await expect(
      replaceWithBetterCopy(file, "https://youtu.be/ddddddddddd", deps),
    ).rejects.toMatchObject({ status: 409, message: "That song is being changed already." });
    expect((await first).codec).toBe("Opus");
  });

  it("leaves the song as it was when the copy isn't its length, or the link isn't one", async () => {
    const file = await song("Sine Wave - Low Tone.mp3", 64);
    const before = await fs.readFile(file.absolute);
    const replacing = replaceWithBetterCopy(file, "https://youtu.be/ddddddddddd", {
      lookUp: async () => opusInfo(130),
      spawnSource: playing(opus10),
    });
    await expect(replacing).rejects.toThrow(
      "The copy is 0:10 long, not 0:20, so the song was left as it was.",
    );
    await expect(replacing).rejects.toBeInstanceOf(BetterCopyError);
    expect((await fs.readFile(file.absolute)).equals(before)).toBe(true);
    expect((await fs.readdir(folder)).filter((name) => name.endsWith(".part"))).toEqual([]);
    await expect(fs.readdir(process.env.TRASH_DIR!)).rejects.toThrow();

    await expect(replaceWithBetterCopy(file, "https://example.com/song.mp3")).rejects.toThrow(
      "That isn't a YouTube video or a SoundCloud track.",
    );
    const flac = await song("Lossless.flac", 0);
    await expect(replaceWithBetterCopy(flac, "https://youtu.be/ddddddddddd")).rejects.toThrow(
      "It's lossless already.",
    );
  });
});
