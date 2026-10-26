/**
 * Better copies (Housekeeping; the owner's ask, October 2026): a song in the
 * "Save to" folder that sounds worse than the quality bar is replaced by a
 * better copy of the same recording, instead of only being deleted.
 *
 * - `findBetterCopy()` searches for the song by its artist and title
 *   (`searchSongs()`: YouTube, else SoundCloud), keeps the uploads that are
 *   the same song at the same length (`sameSongAs()`), and looks the best few
 *   up for the bitrate of the audio each would give. The best is offered only
 *   when that's higher than the song's own.
 * - `replaceWithBetterCopy()` downloads it through the usual yt-dlp → ffmpeg
 *   pipeline into the song's own file type (the owner's pick: an MP3 stays an
 *   MP3, made at 320 kbps; audio that already is the file's kind, such as
 *   Opus for an .opus file, is copied as it is), with the old file's tags and
 *   cover, next to the song as a ".part". The copy is read all the way
 *   through and must be the song's length; only then does the old song go to
 *   the Recycle Bin / Trash and the copy take its name and dates. If any step
 *   fails — the drive has no bin, say — the song is left as it was.
 */
import { randomBytes } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { extensionOf, songNameOf } from "@shared/audio-types";
import { clock } from "@shared/clock";
import {
  SAME_LENGTH_SECONDS,
  type BetterCopy,
  type BetterCopyLookup,
  type SongCheck,
} from "@shared/schema";
import { audioLinkOf, type AudioLink } from "@shared/soundcloud-link";
import { folderArtistsOf, tidiedSong, type SongName } from "@shared/song-name";
import { spawnYtDlpAudio, startAudioPipeline, type AudioInfo } from "./audio";
import { audioEnded, lookUpAudio, sourceName } from "./audio-source";
import { mapAtOnce } from "./cpu-cores";
import { FolderError } from "./folders";
import { decodeThrough, kbpsOf, songCheckOf } from "./housekeeping";
import { parseFile, readTags, type AudioFile } from "./library";
import { retryWhenBusy } from "./retry-when-busy";
import { markBeingSaved } from "./save";
import { sameSongAs, searchSongs, type SongSearchAnswer, type SongSearchOptions } from "./search";
import { binName, moveToTrash } from "./trash";
import { ENCODINGS, whileBusy } from "./trim";

/** A request the app can't carry out, with the status to answer with. */
export class BetterCopyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Uploads of the same song looked up for their bitrate: the best-ranked few. */
export const CANDIDATES = 3;

/** What a re-encoded copy is made at: the most an MP3 holds, so as little as possible is lost. */
export const BETTER_KBPS = 320;

/** Files that are lossless: nothing online is better. */
const LOSSLESS = new Set([".flac", ".wav", ".aif", ".aiff", ".wv", ".ape", ".alac"]);

/** The source's stream goes into a file of this type as it is when its codec matches. */
const COPIES_AS_IS: Record<string, RegExp> = {
  ".mp3": /^mp3/,
  ".m4a": /^mp4a/,
  ".aac": /^mp4a/,
  ".opus": /^opus/,
  ".webm": /^opus/,
  ".mka": /./,
};

/** A stream's codec as people know it: "opus" → "Opus", "mp4a.40.2" → "AAC". */
export function codecName(acodec: string | undefined): string | null {
  if (!acodec) return null;
  if (acodec.startsWith("opus")) return "Opus";
  if (acodec.startsWith("mp4a")) return "AAC";
  if (acodec.startsWith("mp3")) return "MP3";
  if (acodec.startsWith("vorbis")) return "Vorbis";
  return acodec;
}

/** What's known about a folder song before looking for a better copy of it. */
type OwnAudio = SongName & { seconds: number | null; kbps: number | null; lossless: boolean };

async function ownAudioOf(file: AudioFile): Promise<OwnAudio> {
  const tags = await readTags(file);
  const { format } = await parseFile(file.absolute, { duration: true, skipCovers: true });
  const seconds = format.duration ?? tags.duration ?? null;
  // Its artist and title, tidied ("Linkin Park - Numb (Official Video)" with no tags is Numb).
  const song = tidiedSong(
    { title: tags.title ?? songNameOf(file.relative), artist: tags.trackArtist ?? null },
    folderArtistsOf([]),
  );
  const lossless = format.lossless === true || LOSSLESS.has(extensionOf(file.relative));
  return {
    ...song,
    seconds,
    kbps: lossless ? null : kbpsOf(format.bitrate, file.size, seconds),
    lossless,
  };
}

/** What to search for: "Artist Title audio" on YouTube (as for a Spotify song), "Artist Title" on SoundCloud. */
export function betterCopyQuery({ artist, title }: SongName) {
  const words = [artist, title].filter(Boolean).join(" ");
  return { youtube: `${words} audio`, soundCloud: words, words };
}

export type BetterCopyDeps = {
  search?: (query: string, options: SongSearchOptions) => Promise<SongSearchAnswer>;
  lookUp?: (link: AudioLink) => Promise<AudioInfo>;
};

/**
 * A better copy of the song, or why there's none (see the top of this file).
 * Rejects only when the search, or every look-up, failed: a `YouTubeRefused`
 * when YouTube refused it.
 */
export async function findBetterCopy(
  file: AudioFile,
  { search = searchSongs, lookUp = lookUpAudio }: BetterCopyDeps = {},
): Promise<BetterCopyLookup> {
  const own = await ownAudioOf(file);
  const none = (reason: string): BetterCopyLookup => ({ kbps: own.kbps, copy: null, reason });
  if (own.lossless) return none("It's lossless already: no copy online is better.");
  if (own.kbps === null)
    return none("Its bitrate isn't known, so no copy can be said to be better.");
  if (own.seconds === null) {
    return none("Its length isn't known, so no upload can be matched to it.");
  }
  const seconds = own.seconds;
  const query = betterCopyQuery(own);
  const { results } = await search(query.youtube, {
    targetDuration: seconds,
    soundCloudQuery: query.soundCloud,
  });
  const same = results
    .filter((result) => sameSongAs(query.words, result, seconds))
    .slice(0, CANDIDATES);
  if (same.length === 0) {
    return none(
      results.length === 0
        ? `Nothing was found for “${query.words}”.`
        : `No upload of “${query.words}” found is the same length (${clock(seconds)}).`,
    );
  }

  // Each one's audio, looked up at once (one per CPU core): its bitrate, and its codec.
  const looked = await mapAtOnce(same, async (result) => {
    const link = audioLinkOf(result.url);
    if (!link) return { result, error: new Error("Not a link the app can download.") };
    try {
      return { result, link, info: await lookUp(link) };
    } catch (error) {
      return { result, error };
    }
  });
  let best:
    { result: (typeof same)[number]; link: AudioLink; kbps: number; info: AudioInfo } | undefined;
  for (const each of looked) {
    if (!("info" in each) || !each.link || !each.info?.abr) continue;
    if (!best || each.info.abr > best.kbps) {
      best = { result: each.result, link: each.link, kbps: each.info.abr, info: each.info };
    }
  }
  if (!best) {
    const failed = looked.find((each) => "error" in each);
    if (failed && looked.every((each) => "error" in each)) throw failed.error;
    return none("No upload of it said what bitrate its audio is.");
  }
  if (best.kbps <= own.kbps) {
    return none(
      `The best copy found (${sourceName(best.link)}) is ${best.kbps} kbps: no better than this one's ${own.kbps} kbps.`,
    );
  }
  const copy: BetterCopy = {
    url: best.link.url,
    title: best.result.title,
    channel: best.result.channel,
    source: best.link.source,
    seconds: best.result.duration,
    kbps: best.kbps,
    codec: codecName(best.info.acodec),
  };
  return { kbps: own.kbps, copy, reason: null };
}

/**
 * ffmpeg arguments that write the audio on stdin into `output`, a file of the
 * song's type (`ext`), with the tags and cover of `old`: the stream copied as
 * it is when it's that kind of audio already (`acodec`), else encoded at
 * BETTER_KBPS (lossy formats; an .mka becomes FLAC, as trim.ts writes one).
 */
export function betterCopyArgs(
  old: string,
  output: string,
  ext: string,
  acodec: string | undefined,
): string[] {
  const encoding = ENCODINGS[ext];
  if (!encoding) throw new Error(`The app can't write ${ext} files.`);
  const asIs = acodec !== undefined && COPIES_AS_IS[ext]?.test(acodec);
  return [
    ...["-hide_banner", "-loglevel", "error"],
    ...["-i", "pipe:0", "-i", old],
    ...["-map", "0:a:0"],
    // The old song's cover: a picture stream, where the file holds one (Ogg keeps it in a tag).
    ...(encoding.cover ? ["-map", "1:v?", "-c:v", "copy", "-disposition:v", "attached_pic"] : []),
    ...["-c:a", ...(asIs ? ["copy"] : encoding.codec({ bitrate: BETTER_KBPS * 1000 }))],
    // The old song's tags: the file's own, and its audio stream's (where Ogg keeps them).
    ...["-map_metadata", "1", "-map_metadata:s:a:0", "1:s:a:0"],
    // ID3v2.3, which Windows Explorer and car stereos read (like the downloads).
    ...(encoding.format === "mp3" ? ["-id3v2_version", "3"] : []),
    ...["-f", encoding.format, "-y", output],
  ];
}

/** The copy, read all the way through: it must play through and be the song's length. */
async function checkCopy(file: string, own: OwnAudio): Promise<SongCheck> {
  const [format, decoded, { size }] = await Promise.all([
    parseFile(file, { duration: false, skipCovers: true })
      .then((metadata) => metadata.format)
      .catch(() => undefined),
    decodeThrough(file),
    fs.stat(file),
  ]);
  const check = songCheckOf(format?.duration ?? null, decoded, {
    kbps: format?.lossless ? null : kbpsOf(format?.bitrate, size, decoded.seconds),
    lossless: format?.lossless === true,
    codec: format?.codec ?? null,
  });
  if (check.cutShort || check.damaged) {
    throw new BetterCopyError(
      422,
      `The copy didn't play through (${check.damaged ?? "it's cut short"}), so the song was left as it was.`,
    );
  }
  if (
    own.seconds !== null &&
    check.seconds !== null &&
    Math.abs(check.seconds - own.seconds) > SAME_LENGTH_SECONDS
  ) {
    throw new BetterCopyError(
      422,
      `The copy is ${clock(check.seconds)} long, not ${clock(own.seconds)}, so the song was left as it was.`,
    );
  }
  return check;
}

export type ReplaceDeps = {
  lookUp?: (link: AudioLink) => Promise<AudioInfo>;
  /** Plays yt-dlp's audio stream (tests). */
  spawnSource?: typeof spawnYtDlpAudio;
};

/**
 * Replaces the song with the copy at `url` (see the top of this file) and
 * answers with the new copy's check. Rejects with `BetterCopyError`, a
 * `YouTubeRefused`, a `NoBinError` (its drive has no bin) or a `FolderError`,
 * the song left as it was.
 */
export async function replaceWithBetterCopy(
  file: AudioFile,
  url: string,
  { lookUp = lookUpAudio, spawnSource = spawnYtDlpAudio }: ReplaceDeps = {},
): Promise<SongCheck> {
  const link = audioLinkOf(url);
  if (!link) {
    throw new BetterCopyError(400, "That isn't a YouTube video or a SoundCloud track.");
  }
  const ext = extensionOf(file.relative);
  if (LOSSLESS.has(ext)) throw new BetterCopyError(409, "It's lossless already.");
  if (!ENCODINGS[ext]) {
    throw new BetterCopyError(400, `The app can't make ${ext || "these"} files.`);
  }
  return whileBusy(file.absolute, async () => {
    const own = await ownAudioOf(file);
    if (own.lossless) throw new BetterCopyError(409, "It's lossless already.");
    const info = await lookUp(link);
    // Written next to the song, never over it; Housekeeping doesn't list it meanwhile.
    const part = `${file.absolute}.${randomBytes(4).toString("hex")}.part`;
    const doneWriting = markBeingSaved(part);
    let keepPart = false;
    try {
      const pipeline = startAudioPipeline(
        link.url,
        info.formatId,
        betterCopyArgs(file.absolute, part, ext, info.acodec),
        undefined,
        { spawnSource },
      );
      // ffmpeg writes the file itself: its own output is nothing, but must be read to end.
      pipeline.audio.resume();
      const { ok, reason } = await pipeline.finished;
      const refused = audioEnded(link, ok, reason);
      if (refused) throw refused;
      if (!ok) {
        throw new BetterCopyError(
          502,
          `Couldn't download the copy: ${reason || `${sourceName(link)} sent no audio`}.`,
        );
      }
      const check = await checkCopy(part, own);

      // The old song to the bin (none: NoBinError, nothing changed), then the copy in its place.
      const times = await fs.stat(file.absolute);
      await moveToTrash(file.absolute);
      try {
        await retryWhenBusy(() => fs.rename(part, file.absolute));
      } catch (err) {
        keepPart = true;
        throw new FolderError(
          500,
          `The old song went to the ${binName()}, but its copy couldn't take its name (${(err as Error).message}): it's “${path.basename(part)}” in the same folder.`,
        );
      }
      // Its dates, as the old song's.
      await fs.utimes(file.absolute, times.atime, times.mtime).catch(() => {});
      return check;
    } finally {
      if (!keepPart) await fs.rm(part, { force: true }).catch(() => {});
      doneWriting();
    }
  });
}
