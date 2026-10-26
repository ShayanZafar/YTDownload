/**
 * Cutting a part out of a song in the "Save to" folder — dead air before,
 * after or in the middle of it — and joining the rest back together.
 *
 * - `readWaveform()` decodes the song once (8 kHz, mono) to draw it and to
 *   find its quiet stretches, so the part to cut is easy to pick.
 * - `trimSong()` re-encodes the song with ffmpeg minus that part, in the same
 *   format (lossless files stay lossless; lossy ones keep their bitrate),
 *   with its tags and cover. The join gets a 5 ms fade on each side, so it
 *   can't click. The new file replaces the old one only once it's complete.
 * - The original is copied into the backup folder first (data/trimmed-originals,
 *   or TRIM_BACKUP_DIR), so `undoTrim()` can put it back. Backups are kept
 *   for BACKUP_DAYS days.
 */
import { randomBytes } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { z } from "zod";
import { extensionOf } from "@shared/audio-types";
import type { TimeRange, Waveform } from "@shared/schema";
import { ffmpeg, ffmpegFailure, runFfmpeg } from "./ffmpeg";
import { FolderError } from "./folders";
import { parseFile, type AudioFile } from "./library";
import { musicTrackId } from "./music";
import { retryWhenBusy } from "./retry-when-busy";

// --- The waveform, and the song's quiet stretches -------------------------------------

/** Samples a second the waveform is worked out from: plenty to see where the sound is. */
export const WAVEFORM_RATE = 8000;
/** The waveform is looked at in slices this long (seconds). */
export const WINDOW_SECONDS = 0.05;
/** Bars drawn, at most. */
export const WAVEFORM_BARS = 1000;
/** Quieter than this (−45 dBFS) counts as silence: no music, just a hiss at most. */
export const SILENCE_LEVEL = 10 ** (-45 / 20);
/** A quiet stretch must last this long (seconds) to count as dead air. */
export const MIN_SILENCE = 1;
/** The longest a waveform may take to work out (a whole audiobook takes a while). */
const WAVEFORM_TIMEOUT_MS = 5 * 60_000;

/** The loudest sample (0 to 1) in each slice of `WINDOW_SECONDS`, from signed 16-bit mono audio. */
export class WindowPeaks {
  readonly peaks: number[] = [];
  private readonly size = Math.round(WAVEFORM_RATE * WINDOW_SECONDS);
  private loudest = 0;
  private filled = 0;
  private leftover: Buffer | null = null;
  samples = 0;

  add(chunk: Buffer) {
    let data = chunk;
    if (this.leftover) {
      data = Buffer.concat([this.leftover, chunk]);
      this.leftover = null;
    }
    const usable = data.length - (data.length % 2);
    if (usable < data.length) this.leftover = data.subarray(usable);
    for (let i = 0; i < usable; i += 2) {
      const sample = Math.abs(data.readInt16LE(i)) / 32768;
      if (sample > this.loudest) this.loudest = sample;
      if (++this.filled === this.size) this.flush();
    }
    this.samples += usable / 2;
  }

  /** The slices, the last one even if it's short. */
  finish(): number[] {
    if (this.filled > 0) this.flush();
    return this.peaks;
  }

  private flush() {
    this.peaks.push(Math.min(1, this.loudest));
    this.loudest = 0;
    this.filled = 0;
  }
}

/** The slices' peaks merged into at most `bars` bars (each the loudest of its slices). */
export function barsOf(windows: readonly number[], bars = WAVEFORM_BARS): number[] {
  if (windows.length <= bars) return windows.map(round3);
  const out: number[] = [];
  for (let bar = 0; bar < bars; bar++) {
    const from = Math.floor((bar * windows.length) / bars);
    const to = Math.floor(((bar + 1) * windows.length) / bars);
    let loudest = 0;
    for (let i = from; i < to; i++) loudest = Math.max(loudest, windows[i]);
    out.push(round3(loudest));
  }
  return out;
}

/** The quiet stretches at least `minSeconds` long, from the slices' peaks; `duration` ends the last. */
export function silencesIn(
  windows: readonly number[],
  duration: number,
  { level = SILENCE_LEVEL, minSeconds = MIN_SILENCE } = {},
): TimeRange[] {
  const found: TimeRange[] = [];
  let from = -1;
  const close = (to: number) => {
    const start = from * WINDOW_SECONDS;
    const end = Math.min(duration, to * WINDOW_SECONDS);
    if (end - start >= minSeconds) found.push({ start: round3(start), end: round3(end) });
    from = -1;
  };
  windows.forEach((peak, i) => {
    if (peak < level) {
      if (from < 0) from = i;
    } else if (from >= 0) close(i);
  });
  if (from >= 0) close(windows.length);
  return found;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** ffmpeg arguments that decode a song's first audio stream to 8 kHz mono 16-bit samples on stdout. */
export function ffmpegWaveformArgs(input: string): string[] {
  return [
    ...["-hide_banner", "-loglevel", "error", "-nostdin"],
    ...["-i", input],
    ...["-map", "0:a:0", "-vn", "-sn", "-dn"],
    ...["-ac", "1", "-ar", String(WAVEFORM_RATE), "-f", "s16le", "-acodec", "pcm_s16le", "pipe:1"],
  ];
}

/** The song's waveform and quiet stretches. Stops (and rejects) if `signal` gives up. */
export async function readWaveform(file: AudioFile, signal?: AbortSignal): Promise<Waveform> {
  const windows = new WindowPeaks();
  const result = await ffmpeg(ffmpegWaveformArgs(file.absolute), {
    timeoutMs: WAVEFORM_TIMEOUT_MS,
    signal,
    onStdout: (chunk) => windows.add(chunk),
  });
  if (result.aborted) throw new DOMException("Stopped", "AbortError");
  if (result.code !== 0) throw new Error(ffmpegFailure(result));
  const peaks = windows.finish();
  const duration = round3(windows.samples / WAVEFORM_RATE);
  return { duration, peaks: barsOf(peaks), silences: silencesIn(peaks, duration) };
}

// --- Cutting a part out -------------------------------------------------------------

/** What a song turns into: its encoder and the container ffmpeg writes. */
type Encoding = {
  /** ffmpeg's -f for the file. */
  format: string;
  /** The audio encoder and its settings. */
  codec: (source: SourceAudio) => string[];
  /** Can the file hold a cover picture as a picture stream? (Ogg keeps it in a tag.) */
  cover?: boolean;
};

/** What's known about the song's audio before trimming it. */
export type SourceAudio = {
  /** Bits a second, for lossy audio. */
  bitrate?: number;
  /** Bits a sample, for uncompressed audio. */
  bitsPerSample?: number;
  /** Seconds. */
  duration?: number;
};

/** The song's own bitrate in kbps (lossy audio keeps it), within what encoders take. */
const kbps = ({ bitrate }: SourceAudio, fallback: number, most = 320) =>
  `${bitrate ? Math.min(most, Math.max(64, Math.round(bitrate / 1000))) : fallback}k`;

/** Uncompressed audio keeps its sample size: 16, 24 or 32 bits. */
const pcm = ({ bitsPerSample }: SourceAudio, endian: "le" | "be") =>
  `pcm_s${bitsPerSample === 24 || bitsPerSample === 32 ? bitsPerSample : 16}${endian}`;

/** How the app writes each kind of file it can re-encode (trimming, and better copies). */
export const ENCODINGS: Record<string, Encoding> = {
  ".mp3": { format: "mp3", codec: (s) => ["libmp3lame", "-b:a", kbps(s, 320)], cover: true },
  ".m4a": { format: "ipod", codec: (s) => ["aac", "-b:a", kbps(s, 256, 512)], cover: true },
  ".aac": { format: "adts", codec: (s) => ["aac", "-b:a", kbps(s, 256, 512)] },
  ".opus": { format: "opus", codec: (s) => ["libopus", "-b:a", kbps(s, 160, 510)] },
  ".ogg": { format: "ogg", codec: (s) => ["libvorbis", "-b:a", kbps(s, 192, 500)] },
  ".oga": { format: "ogg", codec: (s) => ["libvorbis", "-b:a", kbps(s, 192, 500)] },
  ".webm": { format: "webm", codec: (s) => ["libopus", "-b:a", kbps(s, 160, 510)] },
  ".flac": { format: "flac", codec: () => ["flac"], cover: true },
  // A Matroska file's audio could be anything: it becomes FLAC, which loses nothing.
  ".mka": { format: "matroska", codec: () => ["flac"] },
  ".wav": { format: "wav", codec: (s) => [pcm(s, "le")] },
  ".aif": { format: "aiff", codec: (s) => [pcm(s, "be")] },
  ".aiff": { format: "aiff", codec: (s) => [pcm(s, "be")] },
  ".wv": { format: "wv", codec: () => ["wavpack"] },
  ".wma": { format: "asf", codec: (s) => ["wmav2", "-b:a", kbps(s, 192)] },
};

/** Can the app trim this kind of file? (It can't write .ape.) */
export const canTrim = (fileName: string) => extensionOf(fileName) in ENCODINGS;

/** The join's fade on each side (seconds): too short to hear, long enough not to click. */
const JOIN_FADE = 0.005;

/**
 * The ffmpeg filter that keeps the song before `cut.start` and after
 * `cut.end` and joins them, fading 5 ms each side of the join. A cut from the
 * very start (or to the very end) keeps just the one part.
 */
export function trimFilter(cut: TimeRange, duration?: number): string {
  const keepsStart = cut.start > 0;
  const keepsEnd = duration === undefined || cut.end < duration;
  const fade = keepsStart && keepsEnd;
  const parts: string[] = [];
  if (keepsStart) {
    const fadeOut = fade
      ? `,afade=t=out:st=${seconds(Math.max(0, cut.start - JOIN_FADE))}:d=${JOIN_FADE}`
      : "";
    parts.push(`[0:a:0]atrim=end=${seconds(cut.start)},asetpts=N/SR/TB${fadeOut}[a]`);
  }
  if (keepsEnd) {
    const fadeIn = fade ? `,afade=t=in:d=${JOIN_FADE}` : "";
    parts.push(`[0:a:0]atrim=start=${seconds(cut.end)},asetpts=N/SR/TB${fadeIn}[b]`);
  }
  if (parts.length === 2) parts.push("[a][b]concat=n=2:v=0:a=1[out]");
  else parts[0] = parts[0].replace(/\[[ab]\]$/, "[out]");
  return parts.join(";");
}

const seconds = (n: number) => String(round3(n));

/** ffmpeg arguments that write `input` minus `cut` to `output`, in the same format, tags and cover kept. */
export function ffmpegTrimArgs(
  input: string,
  output: string,
  cut: TimeRange,
  source: SourceAudio,
  ext: string,
): string[] {
  const encoding = ENCODINGS[ext];
  if (!encoding) throw new Error(`The app can't trim ${ext} files.`);
  return [
    ...["-hide_banner", "-loglevel", "error", "-nostdin"],
    ...["-i", input],
    ...["-filter_complex", trimFilter(cut, source.duration), "-map", "[out]"],
    ...(encoding.cover ? ["-map", "0:v?", "-c:v", "copy", "-disposition:v", "attached_pic"] : []),
    ...["-c:a", ...encoding.codec(source)],
    // The tags: the file's own, and the audio stream's (where Ogg keeps them).
    ...["-map_metadata", "0", "-map_metadata:s:a:0", "0:s:a:0"],
    // ID3v2.3, which Windows Explorer and car stereos read (like the downloads).
    ...(encoding.format === "mp3" ? ["-id3v2_version", "3"] : []),
    ...["-f", encoding.format, "-y", output],
  ];
}

// --- Backups, for Undo ----------------------------------------------------------------

/** Days a trimmed song's original is kept. */
export const BACKUP_DAYS = 30;
const DAY_MS = 24 * 60 * 60_000;

/** Where originals are kept: data/trimmed-originals, unless TRIM_BACKUP_DIR says. */
export function trimBackupDir(): string {
  return path.resolve(
    process.env.TRIM_BACKUP_DIR || path.join(process.cwd(), "data", "trimmed-originals"),
  );
}

const backupInfoSchema = z.object({
  folder: z.string(),
  relative: z.string(),
  trimmedAt: z.string(),
  /** The trimmed file, as written: Undo only replaces that, not a newer change. */
  size: z.number(),
  mtimeMs: z.number(),
  duration: z.number().optional(),
});

/** Deletes backups older than BACKUP_DAYS. */
export async function pruneTrimBackups(dir = trimBackupDir(), now = Date.now()): Promise<void> {
  const names = await fs.readdir(dir).catch((): string[] => []);
  await Promise.all(
    names.map(async (name) => {
      const stat = await fs.stat(path.join(dir, name)).catch(() => undefined);
      if (stat?.isDirectory() && now - stat.mtimeMs > BACKUP_DAYS * DAY_MS) {
        await fs.rm(path.join(dir, name), { recursive: true, force: true }).catch(() => {});
      }
    }),
  );
}

// Songs being trimmed, put back or replaced now (better-copy.ts), so two changes can't overlap.
const busy = new Set<string>();

/** Runs `work` on a song no other change is making now; a 409 if one is. */
export async function whileBusy<T>(file: string, work: () => Promise<T>): Promise<T> {
  if (busy.has(file)) throw new FolderError(409, "That song is being changed already.");
  busy.add(file);
  try {
    return await work();
  } finally {
    busy.delete(file);
  }
}

/**
 * Puts `part` in `target`'s place. If Windows won't let the file be replaced
 * (the player or another program still has it open), it's written over
 * instead: the app opens files so that others may write to them.
 */
async function replaceFile(part: string, target: string): Promise<void> {
  try {
    await retryWhenBusy(() => fs.rename(part, target));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") throw err;
    await fs.copyFile(part, target);
  }
}

/** The song's audio details, to encode it the same way. */
async function sourceAudioOf(file: string): Promise<SourceAudio> {
  const { format } = await parseFile(file, { duration: true, skipCovers: true });
  return {
    bitrate: format.lossless ? undefined : format.bitrate,
    bitsPerSample: format.bitsPerSample,
    duration: format.duration,
  };
}

/** Writes `input` minus `cut` next to it and swaps it in once done; answers with the new length. */
async function cutInPlace(
  file: AudioFile,
  cut: TimeRange,
  source: SourceAudio,
): Promise<{ duration: number; stat: { size: number; mtimeMs: number } }> {
  const part = `${file.absolute}.${randomBytes(4).toString("hex")}.part`;
  try {
    await runFfmpeg(ffmpegTrimArgs(file.absolute, part, cut, source, extensionOf(file.relative)));
    const after = await sourceAudioOf(part).catch((): SourceAudio => ({}));
    await replaceFile(part, file.absolute);
    const stat = await fs.stat(file.absolute);
    return { duration: round3(after.duration ?? 0), stat };
  } finally {
    await fs.rm(part, { force: true }).catch(() => {});
  }
}

/**
 * Cuts `cut` out of the song in `folder`, keeping its original in the backup
 * folder. Answers with what Undo needs.
 */
export function trimSong(folder: string, file: AudioFile, cut: TimeRange) {
  return whileBusy(file.absolute, async () => {
    if (!canTrim(file.relative)) {
      throw new FolderError(
        400,
        `The app can't trim ${extensionOf(file.relative) || "these"} files.`,
      );
    }
    const source = await sourceAudioOf(file.absolute).catch((): SourceAudio => ({}));
    const end = source.duration === undefined ? cut.end : Math.min(cut.end, source.duration);
    if (source.duration !== undefined && cut.start >= source.duration) {
      throw new FolderError(400, "The cut starts after the song ends.");
    }
    if (source.duration !== undefined && cut.start <= 0 && end >= source.duration) {
      throw new FolderError(400, "That would cut out the whole song.");
    }

    // The original goes into the backup folder first: nothing is lost if anything fails.
    const dir = trimBackupDir();
    void pruneTrimBackups(dir);
    const undo = randomBytes(12).toString("hex");
    const backup = path.join(dir, undo);
    await fs.mkdir(backup, { recursive: true });
    try {
      await fs.copyFile(file.absolute, path.join(backup, path.basename(file.relative)));
      const { duration, stat } = await cutInPlace(file, { start: cut.start, end }, source);
      const info: z.infer<typeof backupInfoSchema> = {
        folder,
        relative: file.relative,
        trimmedAt: new Date().toISOString(),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        duration: source.duration,
      };
      await fs.writeFile(path.join(backup, "trim.json"), JSON.stringify(info, null, 2) + "\n");
      return {
        id: musicTrackId(folder, file.relative),
        removed: round3(end - cut.start),
        duration,
        undo,
      };
    } catch (err) {
      await fs.rm(backup, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  });
}

/**
 * Puts back the original of the trim `undo` names — into `folder`, the Save
 * to folder, only if the trim was made there and the song hasn't changed since.
 */
export async function undoTrim(folder: string, undo: string) {
  if (!/^[a-f0-9]{24}$/.test(undo))
    throw new FolderError(400, "That isn't a trim the app can undo.");
  const backup = path.join(trimBackupDir(), undo);
  const text = await fs.readFile(path.join(backup, "trim.json"), "utf8").catch(() => undefined);
  const parsed = text === undefined ? undefined : backupInfoSchema.safeParse(JSON.parse(text));
  if (!parsed?.success) throw new FolderError(404, "That song's original isn't kept any more.");
  const info = parsed.data;
  if (path.resolve(info.folder) !== path.resolve(folder)) {
    throw new FolderError(409, "That song was trimmed in another Save to folder.");
  }
  const target = path.resolve(folder, info.relative);
  if (!target.startsWith(path.resolve(folder) + path.sep)) {
    throw new FolderError(400, "That isn't a trim the app can undo.");
  }
  const original = path.join(backup, path.basename(info.relative));

  return whileBusy(target, async () => {
    const now = await fs.stat(target).catch(() => undefined);
    if (now && (now.size !== info.size || now.mtimeMs !== info.mtimeMs)) {
      throw new FolderError(
        409,
        `The song has changed since it was trimmed, so it's left as it is. Its original is in ${backup}.`,
      );
    }
    // Copied next to it first, then swapped in: never half a song.
    const part = `${target}.${randomBytes(4).toString("hex")}.part`;
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(original, part);
      await replaceFile(part, target);
    } catch (err) {
      await fs.rm(part, { force: true }).catch(() => {});
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new FolderError(404, "That song's original isn't kept any more.");
      }
      throw new FolderError(500, `Couldn't put the original back: ${(err as Error).message}`);
    }
    await fs.rm(backup, { recursive: true, force: true }).catch(() => {});
    return { id: musicTrackId(folder, info.relative), duration: round3(info.duration ?? 0) };
  });
}
