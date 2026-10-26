import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { FFMPEG_PATH } from "../../server/audio";
import { parseFile, readTags, type AudioFile } from "../../server/library";
import { readCover } from "../../server/music";
import {
  BACKUP_DAYS,
  SILENCE_LEVEL,
  WINDOW_SECONDS,
  WindowPeaks,
  barsOf,
  canTrim,
  ffmpegTrimArgs,
  pruneTrimBackups,
  readWaveform,
  silencesIn,
  trimBackupDir,
  trimFilter,
  trimSong,
  undoTrim,
} from "../../server/trim";
import {
  MIN_CUT,
  canTrimFile,
  clampCut,
  formatCutTime,
  lengthWithout,
  parseCutTime,
  skipCut,
} from "../../client/src/lib/trim";

// Cutting a part out of a song (dead air), on songs ffmpeg makes here: no network.

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

// 10 seconds: quiet, a tone (2–5 s), quiet (5–7 s), a tone (7–10 s).
const WITH_GAPS =
  "aevalsrc=exprs='(between(t,2,5)+between(t,7,10))*0.5*sin(2*PI*440*t)':d=10:s=44100";
const SPOTIFY_ID = "4uLU6hMCjMI75M1A2tKUQC";

let root: string;
let folder: string;
let cover: string;

const audioFile = async (relative: string): Promise<AudioFile> => {
  const absolute = path.join(folder, relative);
  const stat = await fs.stat(absolute);
  return { absolute, relative, size: stat.size, mtimeMs: stat.mtimeMs, addedMs: stat.mtimeMs };
};

/** An MP3 the way the app saves them: 320 kbps, ID3v2.3 tags, a Spotify id and a cover. */
const appMp3 = (file: string) =>
  ffmpeg([
    ...["-f", "lavfi", "-i", WITH_GAPS, "-i", cover],
    ...["-map", "0:a", "-map", "1:v", "-c:a", "libmp3lame", "-b:a", "320k"],
    ...["-c:v", "copy", "-disposition:v", "attached_pic", "-id3v2_version", "3"],
    ...["-metadata", "title=Gaps", "-metadata", "artist=Sine Wave", "-metadata", "album=Tests"],
    ...["-metadata", `spotify_id=${SPOTIFY_ID}`, path.join(folder, file)],
  ]);

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-trim-"));
  folder = path.join(root, "Music");
  await fs.mkdir(folder, { recursive: true });
  process.env.TRIM_BACKUP_DIR = path.join(root, "backups");
  cover = path.join(root, "cover.jpg");
  await ffmpeg(["-f", "lavfi", "-i", "color=c=red:s=32x32", "-frames:v", "1", cover]);
});

afterAll(async () => {
  delete process.env.TRIM_BACKUP_DIR;
  await fs.rm(root, { recursive: true, force: true });
});

describe("Finding dead air", () => {
  /** `seconds` of 8 kHz 16-bit mono at this level (0 to 1). */
  const level = (seconds: number, amplitude: number) => {
    const samples = Buffer.alloc(Math.round(seconds * 8000) * 2);
    for (let i = 0; i < samples.length / 2; i++) {
      samples.writeInt16LE(Math.round((i % 2 ? 1 : -1) * amplitude * 32767), i * 2);
    }
    return samples;
  };

  it("measures each slice's loudest sample, however the chunks are split", () => {
    const audio = Buffer.concat([level(0.1, 0.5), level(0.1, 0)]);
    const windows = new WindowPeaks();
    // An odd split cuts a sample in two.
    windows.add(audio.subarray(0, 333));
    windows.add(audio.subarray(333));
    expect(windows.finish().map((p) => Math.round(p * 10) / 10)).toEqual([0.5, 0.5, 0, 0]);
    expect(windows.samples).toBe(1600);
  });

  it("finds quiet stretches a second or longer, up to the end of the song", () => {
    const loud = Array(20).fill(0.5);
    const quiet = (seconds: number) => Array(seconds / WINDOW_SECONDS).fill(SILENCE_LEVEL / 2);
    const windows = [...quiet(2), ...loud, ...quiet(0.5), ...loud, ...quiet(1.5)];
    const duration = windows.length * WINDOW_SECONDS;
    expect(silencesIn(windows, duration)).toEqual([
      { start: 0, end: 2 },
      { start: 4.5, end: 6 },
    ]);
  });

  it("draws at most so many bars, each as loud as the loudest slice in it", () => {
    expect(barsOf([0.1, 0.9, 0.2, 0.3, 0.5, 0.4], 3)).toEqual([0.9, 0.3, 0.5]);
    expect(barsOf([0.1, 0.2], 3)).toEqual([0.1, 0.2]);
  });

  it("reads a song's waveform and its quiet stretches with ffmpeg", async () => {
    await appMp3("waveform.mp3");
    const waveform = await readWaveform(await audioFile("waveform.mp3"));
    expect(waveform.duration).toBeCloseTo(10, 0);
    expect(waveform.peaks.length).toBeGreaterThan(100);
    expect(waveform.silences).toHaveLength(2);
    expect(waveform.silences[0].start).toBe(0);
    expect(waveform.silences[0].end).toBeCloseTo(2, 0);
    expect(waveform.silences[1].start).toBeCloseTo(5, 0);
    expect(waveform.silences[1].end).toBeCloseTo(7, 0);
  });

  it("stops reading the waveform when the page gives up", async () => {
    await appMp3("waveform-stopped.mp3");
    await expect(
      readWaveform(await audioFile("waveform-stopped.mp3"), AbortSignal.abort()),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("says what ffmpeg said when a file has no waveform to read", async () => {
    await fs.writeFile(path.join(folder, "not-audio.mp3"), "not a song at all");
    await expect(readWaveform(await audioFile("not-audio.mp3"))).rejects.toThrow(/\S/);
  });
});

describe("Cutting a part out", () => {
  it("keeps what's before and after the cut and joins them, fading 5 ms each side", () => {
    expect(trimFilter({ start: 5, end: 7 }, 10)).toBe(
      "[0:a:0]atrim=end=5,asetpts=N/SR/TB,afade=t=out:st=4.995:d=0.005[a];" +
        "[0:a:0]atrim=start=7,asetpts=N/SR/TB,afade=t=in:d=0.005[b];" +
        "[a][b]concat=n=2:v=0:a=1[out]",
    );
  });

  it("keeps just one part when the cut is at the start or the end", () => {
    expect(trimFilter({ start: 0, end: 2 }, 10)).toBe("[0:a:0]atrim=start=2,asetpts=N/SR/TB[out]");
    expect(trimFilter({ start: 8, end: 10 }, 10)).toBe("[0:a:0]atrim=end=8,asetpts=N/SR/TB[out]");
  });

  it("encodes in the song's own format: its bitrate, tags (ID3v2.3) and cover", () => {
    const args = ffmpegTrimArgs(
      "in.mp3",
      "out.part",
      { start: 1, end: 2 },
      { bitrate: 320_000 },
      ".mp3",
    );
    expect(args.join(" ")).toContain("-map 0:v? -c:v copy -disposition:v attached_pic");
    expect(args.join(" ")).toContain("-c:a libmp3lame -b:a 320k");
    expect(args.join(" ")).toContain("-map_metadata 0 -map_metadata:s:a:0 0:s:a:0");
    expect(args.join(" ")).toContain("-id3v2_version 3 -f mp3 -y out.part");
  });

  it("keeps lossless songs lossless, and uncompressed ones at their sample size", () => {
    const flac = ffmpegTrimArgs("a.flac", "b", { start: 1, end: 2 }, {}, ".flac").join(" ");
    expect(flac).toContain("-c:a flac -map_metadata");
    const wav = ffmpegTrimArgs("a.wav", "b", { start: 1, end: 2 }, { bitsPerSample: 24 }, ".wav");
    expect(wav.join(" ")).toContain("-c:a pcm_s24le");
    expect(canTrim("Song.APE")).toBe(false);
    expect(() => ffmpegTrimArgs("a.ape", "b", { start: 1, end: 2 }, {}, ".ape")).toThrow(/\.ape/);
  });

  it("cuts the dead air out of an MP3, keeping its tags, Spotify id and cover, and Undo puts the original back", async () => {
    await appMp3("song.mp3");
    const original = await fs.readFile(path.join(folder, "song.mp3"));

    const trimmed = await trimSong(folder, await audioFile("song.mp3"), { start: 5, end: 7 });
    expect(trimmed.removed).toBe(2);
    expect(trimmed.duration).toBeCloseTo(8, 0);

    const after = await audioFile("song.mp3");
    const { format } = await parseFile(after.absolute, { duration: true });
    expect(format.duration).toBeCloseTo(8, 0);
    expect(format.bitrate).toBeGreaterThan(300_000);
    expect(await readTags(after)).toMatchObject({
      title: "Gaps",
      trackArtist: "Sine Wave",
      album: "Tests",
      spotifyIds: [SPOTIFY_ID],
    });
    expect((await readCover(after))?.type).toBe("image/jpeg");
    // The waveform shows the quiet stretch at the start, and no longer the one in the middle.
    const waveform = await readWaveform(after);
    expect(waveform.silences).toHaveLength(1);
    // Nothing left over next to it.
    expect((await fs.readdir(folder)).filter((name) => name.startsWith("song"))).toEqual([
      "song.mp3",
    ]);
    // The original is in the backup folder, as it was.
    const kept = await fs.readFile(path.join(trimBackupDir(), trimmed.undo, "song.mp3"));
    expect(kept.equals(original)).toBe(true);

    expect(await undoTrim(folder, trimmed.undo)).toEqual({
      id: trimmed.id,
      duration: expect.any(Number),
    });
    expect((await fs.readFile(path.join(folder, "song.mp3"))).equals(original)).toBe(true);
    await expect(fs.stat(path.join(trimBackupDir(), trimmed.undo))).rejects.toThrow();
    await expect(undoTrim(folder, trimmed.undo)).rejects.toMatchObject({ status: 404 });
  });

  it("cuts from the very start, and keeps a 24-bit FLAC lossless at 24 bits", async () => {
    await ffmpeg([
      ...["-f", "lavfi", "-i", WITH_GAPS, "-c:a", "flac", "-sample_fmt", "s32"],
      ...["-bits_per_raw_sample", "24", "-metadata", "title=Lossless"],
      path.join(folder, "hi-res.flac"),
    ]);
    const trimmed = await trimSong(folder, await audioFile("hi-res.flac"), { start: 0, end: 2 });
    expect(trimmed.duration).toBeCloseTo(8, 1);
    const { format, common } = await parseFile(path.join(folder, "hi-res.flac"), {
      duration: true,
    });
    expect(format.lossless).toBe(true);
    expect(format.bitsPerSample).toBe(24);
    expect(common.title).toBe("Lossless");
  });

  it("refuses to cut out the whole song, or past its end", async () => {
    await appMp3("whole.mp3");
    const file = await audioFile("whole.mp3");
    await expect(trimSong(folder, file, { start: 0, end: 12 })).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/whole song/),
    });
    await expect(trimSong(folder, file, { start: 11, end: 12 })).rejects.toMatchObject({
      status: 400,
    });
    expect((await fs.stat(file.absolute)).size).toBe(file.size);
  });

  it("leaves a song changed since its trim alone on Undo, and won't restore into another folder", async () => {
    await appMp3("changed.mp3");
    const trimmed = await trimSong(folder, await audioFile("changed.mp3"), { start: 5, end: 7 });
    await expect(undoTrim(path.join(root, "Elsewhere"), trimmed.undo)).rejects.toMatchObject({
      status: 409,
    });
    await fs.appendFile(path.join(folder, "changed.mp3"), Buffer.alloc(10));
    await expect(undoTrim(folder, trimmed.undo)).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/changed since/),
    });
    // Its original is still kept.
    await fs.stat(path.join(trimBackupDir(), trimmed.undo, "changed.mp3"));
  });

  it(`keeps originals for ${BACKUP_DAYS} days`, async () => {
    const dir = path.join(root, "old-backups");
    await fs.mkdir(path.join(dir, "old"), { recursive: true });
    await fs.mkdir(path.join(dir, "new"), { recursive: true });
    const longAgo = new Date(Date.now() - (BACKUP_DAYS + 1) * 24 * 60 * 60_000);
    await fs.utimes(path.join(dir, "old"), longAgo, longAgo);
    await pruneTrimBackups(dir);
    expect(await fs.readdir(dir)).toEqual(["new"]);
  });
});

describe("The trim window", () => {
  it("shows times with tenths, and reads them typed as a clock or in seconds", () => {
    expect(formatCutTime(83.45)).toBe("1:23.5");
    expect(formatCutTime(3723)).toBe("1:02:03.0");
    expect(formatCutTime(2)).toBe("0:02.0");
    expect(parseCutTime("1:23.5")).toBeCloseTo(83.5);
    expect(parseCutTime(" 83,5 ")).toBeCloseTo(83.5);
    expect(parseCutTime("1:02:03")).toBe(3723);
    expect(parseCutTime("1.5:00")).toBeUndefined();
    expect(parseCutTime("soon")).toBeUndefined();
  });

  it("keeps the cut inside the song, a moved handle pushing the other along", () => {
    expect(clampCut({ start: -1, end: 300 }, 200, "end")).toEqual({ start: 0, end: 200 });
    expect(clampCut({ start: 50, end: 40 }, 200, "start")).toEqual({
      start: 50,
      end: 50 + MIN_CUT,
    });
    expect(clampCut({ start: 50, end: 40 }, 200, "end")).toEqual({ start: 40 - MIN_CUT, end: 40 });
  });

  it("skips the cut while previewing, and says how long the song will be", () => {
    const cut = { start: 5, end: 7 };
    expect(skipCut(4.9, cut)).toBeUndefined();
    expect(skipCut(5, cut)).toBe(7);
    expect(skipCut(7, cut)).toBeUndefined();
    expect(lengthWithout(cut, 10)).toBe(8);
    expect(canTrimFile("Queen/Song.MP3")).toBe(true);
    expect(canTrimFile("Song.ape")).toBe(false);
  });
});
