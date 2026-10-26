/**
 * The music player's side of the app: the songs in the "Save to" folder, for
 * a browser on this computer (see the routes). On a phone the player plays
 * songs stored on the phone instead — they never reach the app.
 *
 * - `listMusic()` lists the folder's songs with their tags (read once and
 *   kept until a file changes — the same scan and cache as library.ts).
 * - Each song has an id made from where it is in the folder, and the page
 *   asks for songs by id, never by path: only a file the folder scan found
 *   can ever be played.
 * - A song can be deleted from the folder (`deleteMusicFile()`): to the
 *   Recycle Bin / Trash, unless asked to delete it for good.
 * - A song is sent as it is, untouched. One the browser can't play (WMA, APE,
 *   AIFF in Chrome…) is converted to FLAC first: lossless, so it sounds just
 *   like the file. Conversions are kept in a cache folder, so that's once per
 *   song.
 */
import type { ChildProcess } from "child_process";
import { createHash, randomBytes } from "crypto";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { songNameOf } from "@shared/audio-types";
import type { Download, HistoryInFolder, MusicLibrary, MusicTrack } from "@shared/schema";
import type { ArtistSong } from "./artist-genre";
import { mapAtOnce } from "./cpu-cores";
import { isNotFound, loadNotFound } from "./not-found";
import {
  findAudioFiles,
  findDownloads,
  forgetTags,
  parseFile,
  readFolderTags,
  readTags,
  type AudioFile,
  type FileTags,
} from "./library";
import { FolderError, nameTaken } from "./folders";
import { runFfmpeg } from "./ffmpeg";
import { retryWhenBusy } from "./retry-when-busy";
import { moveToTrash } from "./trash";

// --- Songs, and finding one by its id -------------------------------------------

/** A song's id: where it is in the folder, hashed — 22 letters, digits, "-" and "_". */
export function musicTrackId(folder: string, relative: string): string {
  return createHash("sha256").update(`${folder}\0${relative}`).digest("base64url").slice(0, 22);
}

/** A song as the player lists it: its tags, or its file name when it has no title tag. */
export function toMusicTrack(folder: string, file: AudioFile, tags: FileTags): MusicTrack {
  return {
    id: musicTrackId(folder, file.relative),
    path: file.relative,
    title: tags.title ?? songNameOf(file.relative),
    artist: tags.trackArtist ?? null,
    album: tags.album ?? null,
    genres: tags.genres ?? [],
    year: tags.year ?? null,
    duration: tags.duration ?? null,
    addedAt: new Date(file.addedMs).toISOString(),
    size: file.size,
    realType: tags.realType ?? null,
    notAudio: tags.notAudio ?? null,
    detailsNotFound: isNotFound(file),
  };
}

// The songs the folder had when last looked through, by id.
let known: { folder: string; files: Map<string, AudioFile> } | undefined;

function remember(folder: string, files: AudioFile[]): Map<string, AudioFile> {
  const byId = new Map(files.map((file) => [musicTrackId(folder, file.relative), file]));
  known = { folder, files: byId };
  return byId;
}

/** The songs in `folder` and its subfolders, in the order they were found. */
export async function listMusic(folder: string): Promise<MusicLibrary> {
  const [{ files, complete }] = await Promise.all([readFolderTags(folder), loadNotFound()]);
  remember(folder, files);
  return { folder, complete, tracks: files.map((file) => toMusicTrack(folder, file, file.tags)) };
}

/**
 * Which of the history's downloads are in `folder` still (see
 * `findDownloads()`), each as the song the player knows it by.
 */
export async function historyInFolder(
  folder: string,
  entries: Download[],
): Promise<HistoryInFolder> {
  const { files, complete } = await readFolderTags(folder);
  remember(folder, files);
  // A file that isn't audio (whatever its name) isn't the download.
  const found = findDownloads(
    entries,
    files
      .filter((file) => !file.tags.notAudio)
      .map((file) => ({ path: file.relative, ...file.tags })),
  );
  return {
    folder,
    complete,
    found: Object.fromEntries(
      Object.entries(found).map(([entry, { file, by }]) => [
        entry,
        { song: musicTrackId(folder, file), file, by },
      ]),
    ),
  };
}

/**
 * Each song's artist and genres in `folder`, for a genre guessed from the
 * artist: the songs the folder had when last looked through (their tags are
 * read once and kept), or looked through now.
 */
export async function folderArtistSongs(folder: string): Promise<ArtistSong[]> {
  const files =
    known?.folder === folder ? [...known.files.values()] : (await findAudioFiles(folder)).files;
  const tags = await mapAtOnce(files, (file) => readTags(file).catch(() => undefined));
  return tags.flatMap((tag) =>
    tag ? [{ artist: tag.trackArtist ?? null, genres: tag.genres ?? [] }] : [],
  );
}

/**
 * The song with this id in `folder`, or undefined if there's none (any more).
 * One the last look didn't see — added since, or the app was restarted — is
 * found by looking through the folder again.
 */
export async function findMusicFile(folder: string, id: string): Promise<AudioFile | undefined> {
  let file = known?.folder === folder ? known.files.get(id) : undefined;
  if (!file) file = remember(folder, (await findAudioFiles(folder)).files).get(id);
  if (!file) return undefined;
  // Still there? (Its size and time may have changed: a new conversion, then.)
  const stat = await fs.stat(file.absolute).catch(() => undefined);
  return stat?.isFile() ? { ...file, size: stat.size, mtimeMs: stat.mtimeMs } : undefined;
}

/**
 * Deletes a song from the folder: to the Recycle Bin / Trash (see trash.ts),
 * or for good when `permanently` says so. Rejects with `NoBinError` when its
 * drive has no bin (the file stays).
 */
export async function deleteMusicFile(
  file: AudioFile,
  { permanently = false } = {},
): Promise<void> {
  if (permanently) await retryWhenBusy(() => fs.rm(file.absolute));
  else await moveToTrash(file.absolute);
  if (known) known.files.delete(musicTrackId(known.folder, file.relative));
}

/**
 * Renames a song to the extension its content says it should have
 * (`realType`, from its tags): "Song.mp3" → "Song.m4a". Refused (NameTakenError)
 * if that's taken: an existing file is never replaced. Returns its new place.
 */
export function fixSongName(
  folder: string,
  file: AudioFile,
  realType: string,
): Promise<{ id: string; path: string }> {
  const name = path.basename(file.absolute);
  return renameSong(
    folder,
    file,
    `${name.slice(0, name.length - path.extname(name).length)}${realType}`,
  );
}

/** Are these one file (or is there nothing at `b`)? */
async function sameFile(a: string, b: string): Promise<boolean> {
  const [first, second] = await Promise.all([fs.stat(a), fs.stat(b).catch(() => undefined)]);
  return !second || (first.ino === second.ino && first.dev === second.dev);
}

/**
 * Another file in the folder has the name a song was to be renamed to: likely
 * the same song twice (a copy's "Song (1).mp3" beside "Song.mp3"). Nothing is
 * renamed — no "(1)", "(2)" of our own — so the person can delete one.
 */
export class NameTakenError extends FolderError {
  constructor(readonly fileName: string) {
    super(
      409,
      `“${fileName}” is in the folder already — if it's the same song, delete one of them.`,
    );
  }
}

/** Throws NameTakenError if a file other than `file` has the name `fileName` in its folder. */
export async function assertNameFree(file: AudioFile, fileName: string): Promise<void> {
  if (!(await sameFile(file.absolute, path.join(path.dirname(file.absolute), fileName)))) {
    throw new NameTakenError(fileName);
  }
}

/**
 * Renames a song, in its own folder, to `fileName` (made safe already).
 * Refused (NameTakenError) if another file has that name: an existing file is
 * never replaced, nor is a number added. A change of case only ("song.mp3" →
 * "Song.mp3") is made as it is. Returns its new place.
 */
export async function renameSong(
  folder: string,
  file: AudioFile,
  fileName: string,
): Promise<{ id: string; path: string }> {
  const dir = path.dirname(file.absolute);
  // A change of case on a drive that ignores case: the "other" file is this one.
  // (Where case counts, "Song.mp3" beside "song.mp3" is another song, and claimed around.)
  const sameName =
    fileName.toLowerCase() === path.basename(file.absolute).toLowerCase() &&
    (await sameFile(file.absolute, path.join(dir, fileName)));
  const target = path.join(dir, fileName);
  // Claimed first ("wx": the system refuses a name that's taken), then renamed over.
  if (!sameName) {
    await fs.open(target, "wx").then(
      (handle) => handle.close(),
      async (err: unknown) => {
        throw (await nameTaken(err, target)) ? new NameTakenError(fileName) : err;
      },
    );
  }
  try {
    await retryWhenBusy(() => fs.rename(file.absolute, target));
  } catch (err) {
    // The empty name it had claimed.
    if (!sameName) await fs.rm(target, { force: true }).catch(() => {});
    throw err;
  }
  forgetTags(file.absolute);
  if (known) known.files.delete(musicTrackId(known.folder, file.relative));
  const relative = path.relative(folder, target);
  return { id: musicTrackId(folder, relative), path: relative };
}

// --- Cover pictures ---------------------------------------------------------------

// Only pictures go out as pictures: a damaged or crafted file could claim to
// hold "text/html", which a browser would run if the address were opened.
const PICTURE_TYPES: Record<string, string> = {
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  "image/png": "image/png",
  png: "image/png",
  "image/gif": "image/gif",
  "image/webp": "image/webp",
  "image/bmp": "image/bmp",
};

/** The song's cover picture (the front cover, if it says), or undefined if it has none. */
export async function readCover(
  file: AudioFile,
): Promise<{ data: Uint8Array; type: string } | undefined> {
  const { common } = await parseFile(file.absolute, { duration: false, skipCovers: false });
  const pictures = (common.picture ?? []).filter(
    (picture) => PICTURE_TYPES[picture.format.toLowerCase()] && picture.data.length > 0,
  );
  const cover = pictures.find((picture) => /front/i.test(picture.type ?? "")) ?? pictures[0];
  return cover && { data: cover.data, type: PICTURE_TYPES[cover.format.toLowerCase()] };
}

// --- Converting what a browser can't play -------------------------------------------

/** Where conversions are kept: the system's temp folder, unless PLAYER_CACHE_DIR says. */
export function conversionCacheDir(): string {
  return path.resolve(process.env.PLAYER_CACHE_DIR || path.join(os.tmpdir(), "yt-audio-player"));
}

/** The most the cache keeps; the conversions played longest ago go first. */
export const MAX_CACHE_BYTES = 2 * 1024 ** 3;
const DAY_MS = 24 * 60 * 60_000;

/**
 * ffmpeg arguments that turn a song into FLAC: lossless, so the converted song
 * sounds exactly like the file (ffmpeg keeps 24 bits for a lossy file's
 * decoded audio). Just the first audio stream — no cover picture or tags.
 */
export function ffmpegFlacArgs(input: string, output: string): string[] {
  return [
    ...["-hide_banner", "-loglevel", "error", "-nostdin"],
    ...["-i", input],
    ...["-map", "0:a:0", "-vn", "-sn", "-dn", "-map_metadata", "-1"],
    ...["-c:a", "flac", "-f", "flac", "-y", output],
  ];
}

const abortError = () => new DOMException("The conversion was cancelled", "AbortError");

/** Waits for `promise`, unless `signal` gives up first. */
function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

const isFile = (file: string) =>
  fs.stat(file).then(
    (stat) => stat.isFile(),
    () => false,
  );

type Conversion = {
  result: Promise<string>;
  /** Requests waiting for it. */
  waiting: number;
  finished: boolean;
  stop: () => void;
};

// Conversions under way, by the file they'll make.
const conversions = new Map<string, Conversion>();

function startConversion(input: string, target: string): Conversion {
  // Its own unfinished file, so a conversion being stopped can't get in the
  // way of one started afresh.
  const part = `${target}.${randomBytes(4).toString("hex")}.part`;
  let child: ChildProcess | undefined;
  let stopped = false;
  const forget = () => {
    if (conversions.get(target) === conversion) conversions.delete(target);
  };

  const convert = async (): Promise<string> => {
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      if (stopped) throw abortError();
      await runFfmpeg(ffmpegFlacArgs(input, part), (started) => {
        child = started;
        if (stopped) started.kill();
      });
      if (stopped) throw abortError();
      await retryWhenBusy(() => fs.rename(part, target)).catch(async (err: unknown) => {
        // Another conversion of the same song got there first: use that one.
        if (!(await isFile(target))) throw err;
      });
      return target;
    } catch (err) {
      throw stopped ? abortError() : err;
    } finally {
      conversion.finished = true;
      forget();
      await fs.rm(part, { force: true }).catch(() => {});
      void pruneConversionCache(path.dirname(target));
    }
  };

  const conversion: Conversion = {
    result: Promise.resolve(target), // replaced just below
    waiting: 0,
    finished: false,
    stop: () => {
      stopped = true;
      forget(); // a request from now on starts afresh
      child?.kill();
    },
  };
  conversion.result = convert();
  // Nobody may be waiting by the time it fails (everyone gave up): that's fine.
  conversion.result.catch(() => {});
  return conversion;
}

/**
 * The song converted to FLAC, for a browser that can't play the file itself:
 * from the cache, or converted now (a few seconds for a song). Requests for
 * the same song share one conversion; if all of them give up before it's
 * done (the player moved on), the conversion stops.
 */
export async function convertedForBrowser(file: AudioFile, signal?: AbortSignal): Promise<string> {
  const key = createHash("sha256")
    .update(`${file.absolute}\0${file.size}\0${file.mtimeMs}`)
    .digest("hex")
    .slice(0, 32);
  const target = path.join(conversionCacheDir(), `${key}.flac`);
  if (await isFile(target)) {
    // Played just now: the last to go when the cache is full.
    const now = new Date();
    await fs.utimes(target, now, now).catch(() => {});
    return target;
  }

  let conversion = conversions.get(target);
  if (!conversion) {
    conversion = startConversion(file.absolute, target);
    conversions.set(target, conversion);
  }
  conversion.waiting++;
  try {
    return await untilAborted(conversion.result, signal);
  } finally {
    conversion.waiting--;
    if (conversion.waiting === 0 && !conversion.finished) conversion.stop();
  }
}

let pruning: Promise<void> | undefined;

/**
 * Keeps the cache under `maxBytes`, deleting the conversions played longest
 * ago (never the newest one), and unfinished ones left behind a day ago or more.
 */
export function pruneConversionCache(dir: string, maxBytes = MAX_CACHE_BYTES): Promise<void> {
  pruning ??= (async () => {
    const names = await fs.readdir(dir).catch((): string[] => []);
    const files = await Promise.all(
      names.map(async (name) => {
        const file = path.join(dir, name);
        const stat = await fs.stat(file).catch(() => undefined);
        return stat?.isFile() ? { file, name, size: stat.size, mtimeMs: stat.mtimeMs } : undefined;
      }),
    );
    const now = Date.now();
    const byNewest = files
      .filter((f): f is NonNullable<typeof f> => f !== undefined)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    const unwanted: string[] = [];
    let total = 0;
    let keptNewest = false;
    byNewest.forEach(({ file, name, size, mtimeMs }) => {
      if (name.endsWith(".part")) {
        if (now - mtimeMs > DAY_MS) unwanted.push(file);
      } else if (name.endsWith(".flac")) {
        total += size;
        if (keptNewest && total > maxBytes) unwanted.push(file);
        keptNewest = true;
      }
    });
    await Promise.all(unwanted.map((file) => fs.rm(file, { force: true }).catch(() => {})));
  })().finally(() => {
    pruning = undefined;
  });
  return pruning;
}
