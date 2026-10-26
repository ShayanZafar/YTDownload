/**
 * Housekeeping: what's wrong with the files in the "Save to" folder, so the
 * person can keep it to songs that play right through and sound good.
 *
 * - `checkSong()` reads a song the way a player would — ffmpeg decodes all of
 *   it — and says whether it isn't audio at all, ends long before the length
 *   its header gives (a download cut short: "plays 0:44 of 7:50"), or can't
 *   be read through (damaged), with its bitrate and whether it's lossless for
 *   the page to weigh against the quality bar the person chose. Each answer is
 *   kept until the file changes.
 * - `otherFiles()` lists the folder's files that aren't songs at all: pictures,
 *   programs, half-finished downloads (".part")… — but not the playlists, the
 *   files Windows and macOS keep in every folder, nor a download being saved
 *   now.
 *
 * Nothing here deletes anything: the page asks, then uses the usual delete.
 */
import { promises as fs } from "fs";
import path from "path";
import type { FolderFile, SongCheck } from "@shared/schema";
import { ffmpeg } from "./ffmpeg";
import { sniffFile } from "./file-kind";
import { findAudioFiles, parseFile, readTags, type AudioFile } from "./library";
import { musicTrackId } from "./music";
import { retryWhenBusy } from "./retry-when-busy";
import { isBeingSaved } from "./save";
import { moveToTrash } from "./trash";

/** ffmpeg arguments that decode a file's first audio stream to nothing, saying how far it got. */
export function ffmpegCheckArgs(input: string): string[] {
  return [
    ...["-hide_banner", "-nostdin", "-v", "error", "-nostats"],
    ...["-i", input],
    ...["-map", "0:a:0", "-vn", "-sn", "-dn"],
    ...["-f", "null", "-progress", "pipe:1", "-"],
  ];
}

/** What decoding a file all the way through found: how far it played, and the errors on the way. */
export type DecodeResult = { seconds: number | null; errors: number; failed: string | null };

/** Reads ffmpeg's `-progress` lines and error lines into a DecodeResult. */
export function decodeResultOf(progress: string, stderr: string, code: number | null) {
  let seconds: number | null = null;
  for (const match of progress.matchAll(/^out_time_us=(\d+)$/gm)) {
    seconds = Number(match[1]) / 1e6;
  }
  const lines = stderr.split(/\r?\n/).filter((line) => line.trim());
  // "Last message repeated 41 times": each counts.
  let errors = 0;
  for (const line of lines) {
    const repeated = /Last message repeated (\d+) times/.exec(line);
    errors += repeated ? Number(repeated[1]) : 1;
  }
  const failed = code === 0 ? null : (lines.at(-1)?.trim() ?? `ffmpeg stopped (exit code ${code})`);
  return { seconds, errors, failed } satisfies DecodeResult;
}

/** Decodes the file through ffmpeg (nothing is written). */
export async function decodeThrough(file: string): Promise<DecodeResult> {
  // Only the last few kilobytes of errors are needed to count them.
  const { stdout, stderr, code } = await ffmpeg(ffmpegCheckArgs(file), {
    stderr: { keep: "last", chars: 64_000 },
  });
  return decodeResultOf(stdout.toString(), stderr, code);
}

/** A file that plays this much less than its header says is cut short. */
const SHORT_BY_SECONDS = 5;
const SHORT_BY_SHARE = 0.03;
/** More decoding errors than this and a file counts as damaged (a few are common and harmless). */
export const MAX_ERRORS = 10;

/** What's wrong with a song, from what its header says and what decoding it found. */
export function songCheckOf(
  says: number | null,
  decoded: DecodeResult,
  format: { kbps: number | null; lossless: boolean; codec: string | null },
): SongCheck {
  const plays = decoded.seconds;
  const cutShort =
    says !== null &&
    plays !== null &&
    says - plays > SHORT_BY_SECONDS &&
    says - plays > says * SHORT_BY_SHARE;
  let damaged: string | null = null;
  if (!cutShort) {
    if (decoded.failed) damaged = decoded.failed;
    else if (!plays) damaged = "it has no audio to play";
    else if (decoded.errors > MAX_ERRORS) {
      damaged = `${decoded.errors.toLocaleString("en")} errors while reading it: it may skip or crackle`;
    }
  }
  return {
    notAudio: null,
    cutShort: cutShort ? { plays: plays!, says: says! } : null,
    damaged,
    seconds: plays ?? says,
    ...format,
  };
}

/** The bitrate in kbps: what the file says, else its size over its length. */
export function kbpsOf(bitrate: number | undefined, size: number, seconds: number | null) {
  if (bitrate && Number.isFinite(bitrate) && bitrate > 0) return Math.round(bitrate / 1000);
  if (seconds && seconds > 0) return Math.round((size * 8) / seconds / 1000);
  return null;
}

// Answers kept by file, until it changes (its size or time).
const checked = new Map<string, { size: number; mtimeMs: number; check: Promise<SongCheck> }>();
const MAX_CHECKED = 20_000;

/** Checks one song (see the top of this file). */
export function checkSong(file: AudioFile): Promise<SongCheck> {
  const kept = checked.get(file.absolute);
  if (kept && kept.size === file.size && kept.mtimeMs === file.mtimeMs) return kept.check;
  const check = (async (): Promise<SongCheck> => {
    const tags = await readTags(file);
    if (tags.notAudio) {
      return {
        notAudio: tags.notAudio,
        cutShort: null,
        damaged: null,
        seconds: null,
        kbps: null,
        lossless: false,
        codec: null,
      };
    }
    const [format, decoded] = await Promise.all([
      parseFile(file.absolute, { duration: false, skipCovers: true, mkvUseIndex: true })
        .then((metadata) => metadata.format)
        .catch(() => undefined),
      decodeThrough(file.absolute),
    ]);
    return songCheckOf(tags.duration ?? null, decoded, {
      kbps: format?.lossless
        ? null
        : kbpsOf(format?.bitrate, file.size, decoded.seconds ?? tags.duration ?? null),
      lossless: format?.lossless === true,
      codec: format?.codec ?? null,
    });
  })();
  if (checked.size >= MAX_CHECKED) checked.clear();
  checked.set(file.absolute, { size: file.size, mtimeMs: file.mtimeMs, check });
  check.catch(() => checked.delete(file.absolute));
  return check;
}

// --- Files that aren't songs ---------------------------------------------------------

/** Files every folder may have, kept by the system: never listed. */
const SYSTEM_FILES = new Set(["desktop.ini", "thumbs.db", "ehthumbs.db", ".ds_store"]);
/** Playlists (the app's own .m3u8 among them): wanted, never listed. */
const PLAYLISTS = new Set([".m3u", ".m3u8", ".pls", ".wpl", ".xspf", ".cue"]);
/** What a download left half-finished: listed ticked. */
const LEFTOVERS = /\.(part|ytdl|tmp|temp|crdownload|partial)$|\.part-Frag\d+$/i;

const isListed = (name: string) =>
  !SYSTEM_FILES.has(name.toLowerCase()) &&
  !name.startsWith("._") &&
  !PLAYLISTS.has(path.extname(name).toLowerCase());

/** What a file that isn't a song is, in a few words. */
export function describeFile(name: string, sniffed: string | undefined): string {
  if (LEFTOVERS.test(name)) return "a download that didn't finish";
  if (sniffed) return sniffed;
  const ext = path.extname(name).toLowerCase();
  return ext ? `a ${ext.slice(1).toUpperCase()} file` : "a file with no extension";
}

/** The folder's files that aren't songs (see the top of this file), with ids like a song's. */
export async function otherFiles(
  folder: string,
): Promise<{ files: FolderFile[]; all: AudioFile[] }> {
  const others: AudioFile[] = [];
  await findAudioFiles(folder, { others });
  // A download being written now isn't a leftover.
  const listed = others.filter(
    (file) => isListed(path.basename(file.relative)) && !isBeingSaved(file.absolute),
  );
  const files = await Promise.all(
    listed.map(async (file): Promise<FolderFile> => {
      const name = path.basename(file.relative);
      const sniffed = await sniffFile(file.absolute)
        .then((kind) => (kind && "other" in kind ? kind.other : undefined))
        .catch(() => undefined);
      return {
        id: musicTrackId(folder, file.relative),
        path: file.relative,
        size: file.size,
        what: describeFile(name, sniffed),
        leftover: LEFTOVERS.test(name),
      };
    }),
  );
  return { files, all: listed };
}

/**
 * Deletes one of the folder's other files by its id: to the bin, or for good
 * only when asked (a drive with no bin: NoBinError). False if it isn't there.
 */
export async function deleteOtherFile(
  folder: string,
  id: string,
  { permanently = false } = {},
): Promise<boolean> {
  const { all } = await otherFiles(folder);
  const file = all.find((other) => musicTrackId(folder, other.relative) === id);
  if (!file) return false;
  if (permanently) await retryWhenBusy(() => fs.rm(file.absolute));
  else await moveToTrash(file.absolute);
  return true;
}

/** Forgets the answers kept (for tests). */
export function resetHousekeeping() {
  checked.clear();
}
