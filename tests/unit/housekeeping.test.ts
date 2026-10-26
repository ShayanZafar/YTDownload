import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { FFMPEG_PATH } from "../../server/audio";
import {
  checkSong,
  decodeResultOf,
  describeFile,
  ffmpegCheckArgs,
  kbpsOf,
  otherFiles,
  resetHousekeeping,
  songCheckOf,
} from "../../server/housekeeping";
import { findAudioFiles, type AudioFile } from "../../server/library";
import { markBeingSaved } from "../../server/save";
import { songProblem } from "../../client/src/lib/housekeeping";
import type { SongCheck } from "../../shared/schema";

// Housekeeping: songs ffmpeg makes — whole, cut short, damaged, low bitrate,
// lossless, not audio at all — read the way the app reads them.

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

let folder: string;
const files: Record<string, AudioFile> = {};

beforeAll(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-housekeeping-"));
  const at = (name: string) => path.join(folder, name);
  await tone(at("Good.mp3"), 20, ["-c:a", "libmp3lame", "-b:a", "192k"]);
  await tone(at("Low.mp3"), 20, ["-c:a", "libmp3lame", "-b:a", "64k"]);
  await tone(at("Lossless.flac"), 5, ["-c:a", "flac"]);
  // A download cut short: its header (the Info frame) still says 20 seconds.
  await tone(at("Cut.mp3"), 20, ["-c:a", "libmp3lame", "-b:a", "128k"]);
  const whole = await fs.readFile(at("Cut.mp3"));
  await fs.writeFile(at("Cut.mp3"), whole.subarray(0, Math.floor(whole.length * 0.4)));
  // An M4A cut short before its index (ffmpeg writes it at the end): unreadable.
  await tone(at("Broken.m4a"), 10, ["-c:a", "aac", "-f", "mp4"]);
  const m4a = await fs.readFile(at("Broken.m4a"));
  await fs.writeFile(at("Broken.m4a"), m4a.subarray(0, Math.floor(m4a.length / 2)));
  // A program named like a song.
  await fs.writeFile(at("Fake.mp3"), Buffer.concat([Buffer.from("MZ"), Buffer.alloc(4000)]));
  // Files that aren't songs, and ones Housekeeping leaves out.
  await fs.writeFile(at("cover.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]));
  await fs.writeFile(at("notes.txt"), "a note");
  await fs.writeFile(at("Song.mp3.part"), Buffer.alloc(100));
  await fs.writeFile(at("desktop.ini"), "[.ShellClassInfo]");
  await fs.writeFile(at("Mix.m3u8"), "#EXTM3U\n");
  const { files: found } = await findAudioFiles(folder);
  for (const file of found) files[file.relative] = file;
  resetHousekeeping();
});

afterAll(async () => {
  await fs.rm(folder, { recursive: true, force: true });
});

describe("checkSong", () => {
  it("finds what's wrong with a song: cut short, damaged, not audio — and how it's encoded", async () => {
    const good = await checkSong(files["Good.mp3"]);
    expect(good).toMatchObject({ notAudio: null, cutShort: null, damaged: null, lossless: false });
    expect(good.seconds).toBeCloseTo(20, 0);
    expect(good.kbps).toBe(192);

    expect((await checkSong(files["Low.mp3"])).kbps).toBe(64);

    const lossless = await checkSong(files["Lossless.flac"]);
    expect(lossless).toMatchObject({ lossless: true, kbps: null, damaged: null, cutShort: null });

    const cut = await checkSong(files["Cut.mp3"]);
    expect(cut.cutShort?.says).toBeCloseTo(20, 0);
    expect(cut.cutShort?.plays).toBeLessThan(10);
    expect(cut.damaged).toBeNull();

    const broken = await checkSong(files["Broken.m4a"]);
    expect(broken.damaged).toBeTruthy();

    expect(await checkSong(files["Fake.mp3"])).toMatchObject({
      notAudio: "a Windows program",
      seconds: null,
    });
  });

  it("checks a song once, until it changes", async () => {
    const first = checkSong(files["Good.mp3"]);
    expect(checkSong(files["Good.mp3"])).toBe(first);
    expect(checkSong({ ...files["Good.mp3"], mtimeMs: 1 })).not.toBe(first);
  });
});

describe("what decoding found", () => {
  it("decodes the first audio stream to nothing, saying how far it got", () => {
    const args = ffmpegCheckArgs("in.mp3");
    expect(args).toEqual(expect.arrayContaining(["-i", "in.mp3", "-f", "null", "-progress"]));
    expect(args.at(-1)).toBe("-");
  });

  it("reads ffmpeg's progress and counts its errors, repeated ones too", () => {
    const progress = "out_time_us=1000000\nprogress=continue\nout_time_us=44120000\nprogress=end\n";
    expect(decodeResultOf(progress, "", 0)).toEqual({ seconds: 44.12, errors: 0, failed: null });
    expect(
      decodeResultOf(progress, "bad frame\n    Last message repeated 41 times\n", 0).errors,
    ).toBe(42);
    expect(decodeResultOf("", "moov atom not found\nin.m4a: Invalid data\n", 1)).toEqual({
      seconds: null,
      errors: 2,
      failed: "in.m4a: Invalid data",
    });
  });

  it("calls a song cut short only when it's well short of what it says", () => {
    const format = { kbps: 128, lossless: false, codec: "MPEG 1 Layer 3" };
    const ok = { seconds: 239, errors: 0, failed: null };
    expect(songCheckOf(240, ok, format).cutShort).toBeNull(); // a second: encoder padding
    expect(songCheckOf(470, { ...ok, seconds: 44 }, format).cutShort).toEqual({
      plays: 44,
      says: 470,
    });
    expect(songCheckOf(240, { ...ok, errors: 3 }, format).damaged).toBeNull();
    expect(songCheckOf(240, { ...ok, errors: 50 }, format).damaged).toMatch(/^50 errors/);
    expect(songCheckOf(null, { seconds: 0, errors: 0, failed: null }, format).damaged).toBe(
      "it has no audio to play",
    );
  });

  it("takes the bitrate the file gives, else its size over its length", () => {
    expect(kbpsOf(320_000, 0, null)).toBe(320);
    expect(kbpsOf(undefined, 4_000_000, 250)).toBe(128);
    expect(kbpsOf(undefined, 4_000_000, null)).toBeNull();
  });
});

describe("songProblem: the quality bar", () => {
  const check = (extra: Partial<SongCheck>): SongCheck => ({
    notAudio: null,
    cutShort: null,
    damaged: null,
    seconds: 200,
    kbps: 160,
    lossless: false,
    codec: "MPEG 1 Layer 3",
    ...extra,
  });

  it("lists a song below the bar chosen, and never a lossless one", () => {
    expect(songProblem(check({}), "128")).toBeNull();
    expect(songProblem(check({ kbps: 96 }), "128")).toEqual({
      kind: "lowQuality",
      text: "96 kbps: below 128 kbps.",
    });
    expect(songProblem(check({}), "192")?.kind).toBe("lowQuality");
    expect(songProblem(check({ kbps: 320 }), "lossless")?.text).toBe(
      "320 kbps MPEG 1 Layer 3: not lossless.",
    );
    expect(songProblem(check({ kbps: null, lossless: true }), "lossless")).toBeNull();
    expect(songProblem(check({ kbps: 32 }), "off")).toBeNull();
    // An unknown bitrate passes a bitrate bar.
    expect(songProblem(check({ kbps: null }), "256")).toBeNull();
  });

  it("puts the worst first: not audio, then cut short, then damaged", () => {
    expect(songProblem(check({ cutShort: { plays: 44, says: 470 }, kbps: 64 }), "128")).toEqual({
      kind: "cutShort",
      text: "Plays 0:44 of the 7:50 it says it is: the rest is missing.",
    });
    expect(songProblem(check({ damaged: "moov atom not found" }), "off")?.kind).toBe("damaged");
    expect(songProblem(check({ notAudio: "a picture" }), "off")?.text).toBe(
      "It's a picture, not audio.",
    );
  });
});

describe("otherFiles", () => {
  it("lists the files that aren't songs, but not playlists or the system's own", async () => {
    const { files: listed } = await otherFiles(folder);
    expect(listed.map(({ path: where, what, leftover }) => ({ where, what, leftover }))).toEqual([
      { where: "Song.mp3.part", what: "a download that didn't finish", leftover: true },
      { where: "cover.jpg", what: "a picture", leftover: false },
      { where: "notes.txt", what: "a TXT file", leftover: false },
    ]);
    expect(listed[0].id).toMatch(/^[\w-]{22}$/);
  });

  it("leaves out a download that's being saved now", async () => {
    const saved = markBeingSaved(path.join(folder, "Song.mp3.part"));
    try {
      const { files: listed } = await otherFiles(folder);
      expect(listed.map((file) => file.path)).toEqual(["cover.jpg", "notes.txt"]);
    } finally {
      saved();
    }
    expect((await otherFiles(folder)).files).toHaveLength(3);
  });

  it("says what a file is", () => {
    expect(describeFile("Song.webm.part", undefined)).toBe("a download that didn't finish");
    expect(describeFile("setup.exe", "a Windows program")).toBe("a Windows program");
    expect(describeFile("README", undefined)).toBe("a file with no extension");
  });
});
