/**
 * "Fill in details" for the songs in the Save to folder: what a song's tags
 * lack (title, artist, album, genre, year, track number, cover), what the
 * music catalogues have for it (catalogues.ts), and writing just those into
 * the file.
 *
 * Writing never changes a tag the file already has, and never touches the
 * audio: ffmpeg copies the file's streams and tags as they are (`-c copy`)
 * and adds the new tags, into a temp file. That copy is checked — the same
 * audio, every tag the file had, and the new ones — before it's written over
 * the song, in place, so the file keeps its creation date, and its changed
 * date is put back: the song stays where it was in "Recently added".
 */
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import type { IAudioMetadata } from "music-metadata";
import { extensionOf, songNameOf } from "@shared/audio-types";
import type { SongDetailField, SongDetails, SongLookup } from "@shared/schema";
import { lookUpSong } from "./catalogues";
import { fetchCover } from "./cover";
import { forgetTags, parseFile, readTags, type AudioFile } from "./library";
import { runFfmpeg } from "./music";
import { retryWhenBusy } from "./retry-when-busy";
import { ffmetadataValue, flacPictureBlock } from "./tags";

/** Something about writing a song's details to tell the person (a 4xx, not the app failing). */
export class SongDetailsError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The kinds of file the app writes tags into, and ffmpeg's muxer for each. */
const MUXERS: Record<string, string> = {
  ".mp3": "mp3",
  ".m4a": "ipod",
  ".flac": "flac",
  ".ogg": "ogg",
  ".oga": "ogg",
  ".opus": "opus",
};
// Ogg files keep their cover in a comment, not as a picture stream.
const OGG = new Set([".ogg", ".oga", ".opus"]);

/** Can the app write tags into this kind of file? */
export const canWriteDetails = (fileName: string) =>
  Object.prototype.hasOwnProperty.call(MUXERS, extensionOf(fileName));

/** Which of the details a file's tags have. */
export function detailsPresent({ common }: Pick<IAudioMetadata, "common">) {
  const has = (text: string | undefined) => !!text?.trim();
  return {
    title: has(common.title),
    artist: has(common.artist) || !!common.artists?.some(has) || has(common.albumartist),
    album: has(common.album),
    genre: !!common.genre?.some(has),
    year: !!common.year || has(common.date),
    track: !!common.track?.no,
    cover: (common.picture ?? []).some((picture) => picture.data.length > 0),
  } satisfies Record<SongDetailField, boolean>;
}

const missingFrom = (present: Record<SongDetailField, boolean>) =>
  (Object.keys(present) as SongDetailField[]).filter((field) => !present[field]);

const readWithCovers = (file: AudioFile) =>
  parseFile(file.absolute, { duration: false, skipCovers: false });

/** The catalogue's values for `fields`, leaving out what it doesn't have. */
function detailsFor(fields: SongDetailField[], found: SongDetails): SongDetails {
  const details: SongDetails = {};
  for (const field of fields) {
    if (field === "cover") {
      if (found.coverUrl) details.coverUrl = found.coverUrl;
    } else if (found[field] !== undefined) {
      Object.assign(details, { [field]: found[field] });
    }
  }
  return details;
}

/**
 * What a folder song lacks, and what the catalogues have for it: looked up
 * by its title and artist tags, or, for a song without them, its file name
 * ("Artist - Song.mp3"). Throws CatalogueError if neither catalogue can be reached.
 */
export async function lookUpDetails(file: AudioFile): Promise<SongLookup> {
  const metadata = await readWithCovers(file).catch(() => undefined);
  const missing = metadata ? missingFrom(detailsPresent(metadata)) : [];
  const writable = metadata !== undefined && canWriteDetails(file.relative);
  const none = { missing, writable, found: null, match: null, source: null };
  if (missing.length === 0 || !writable) return none;

  const tags = await readTags(file);
  const match = await lookUpSong({
    title: tags.title ?? songNameOf(file.relative),
    artist: tags.trackArtist,
    duration: tags.duration,
  });
  if (!match) return none;
  const { song, source } = match;
  const found = detailsFor(missing, song);
  if (Object.keys(found).length === 0) return none;
  return {
    missing,
    writable,
    found,
    match: { title: song.title, artist: song.artist, album: song.album ?? null },
    source,
  };
}

// --- Writing ------------------------------------------------------------------------

// Tags a muxer writes of its own (the encoder's name), which may come and go.
const OWN_TAGS = new Set(["TSSE", "©too", "ENCODER", "encoder", "TENC"]);

/** Every tag a file has, by type and id ("ID3v2.3:TIT2"), and how many of each. */
function tagCounts({ native }: Pick<IAudioMetadata, "native">): Map<string, number> {
  const counts = new Map<string, number>();
  Object.entries(native).forEach(([type, tags]) =>
    tags.forEach(({ id }) => {
      if (OWN_TAGS.has(id)) return;
      const key = `${type}:${id}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }),
  );
  return counts;
}

/**
 * Is `after` the same song as `before`, with every tag it had and the new
 * details? Undefined if so, or what's wrong.
 */
export function rewriteProblem(
  before: IAudioMetadata,
  after: IAudioMetadata,
  added: SongDetailField[],
): string | undefined {
  const { format: a, common } = after;
  const { format: b } = before;
  if (a.codec !== b.codec || a.numberOfChannels !== b.numberOfChannels) {
    return "the audio came out different";
  }
  if (a.duration !== undefined && b.duration !== undefined) {
    if (Math.abs(a.duration - b.duration) > Math.max(1, b.duration * 0.01)) {
      return "the song came out a different length";
    }
  }
  const had = tagCounts(before);
  const has = tagCounts(after);
  const lost = Array.from(had).filter(([key, count]) => (has.get(key) ?? 0) < count);
  if (lost.length > 0) return `it would lose some of its tags (${lost[0][0]})`;
  const present = detailsPresent({ common });
  const notAdded = added.filter((field) => !present[field]);
  if (notAdded.length > 0) return `the ${notAdded[0]} didn't go in`;
  return undefined;
}

/** ffmpeg's metadata file: the new tags, and an Ogg file's cover. */
function metadataFile(details: SongDetails, oggCover?: { data: Buffer; type: string }) {
  const lines = [";FFMETADATA1"];
  const add = (key: string, value: string | number | undefined) => {
    if (value !== undefined) lines.push(`${key}=${ffmetadataValue(String(value))}`);
  };
  add("title", details.title);
  add("artist", details.artist);
  add("album", details.album);
  add("genre", details.genre);
  add("date", details.year);
  add("track", details.track);
  if (oggCover) add("METADATA_BLOCK_PICTURE", flacPictureBlock(oggCover.data, oggCover.type));
  return `${lines.join("\n")}\n`;
}

/** The ffmpeg arguments that copy `input` into `output` with the new tags (and cover). */
export function detailsArgs({
  input,
  output,
  ext,
  metadata,
  cover,
  id3,
}: {
  input: string;
  output: string;
  ext: string;
  /** ffmpeg's metadata file with the new tags. */
  metadata: string;
  /** A new cover picture's file, for a file that holds one as a picture stream. */
  cover?: string;
  /** An MP3's ID3v2 version (3 or 4), and whether it has an ID3v1 tag at its end. */
  id3?: { version: 3 | 4; v1: boolean };
}): string[] {
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", input];
  if (cover) args.push("-i", cover);
  const metadataInput = cover ? 2 : 1;
  args.push("-f", "ffmetadata", "-i", metadata, "-map", "0:a");
  // A cover it has already is a picture stream (except in Ogg, which keeps it in a comment).
  if (!OGG.has(ext)) args.push("-map", "0:v?");
  if (cover) args.push("-map", "1:v");
  args.push("-map_metadata", "0", "-map_metadata", String(metadataInput), "-c", "copy");
  if (cover) args.push("-disposition:v:0", "attached_pic");
  if (id3) {
    args.push("-id3v2_version", String(id3.version));
    if (id3.v1) args.push("-write_id3v1", "1");
  }
  args.push("-f", MUXERS[ext], "-y", output);
  return args;
}

/** Writes `data` over `file` in place (so it keeps its creation date), then puts its times back. */
async function overwrite(file: string, data: Buffer, times: { atimeMs: number; mtimeMs: number }) {
  const handle = await retryWhenBusy(() => fs.open(file, "r+"));
  try {
    await handle.writeFile(data);
    await handle.truncate(data.length);
  } finally {
    await handle.close();
  }
  await fs.utimes(file, times.atimeMs / 1000, times.mtimeMs / 1000);
}

/**
 * Writes the details the song still lacks into its file, from `details`;
 * tags it has already stay as they are. The cover is fetched from the
 * catalogue's address (only theirs: see cover.ts). Returns what was added —
 * nothing, if the song has all of those already.
 */
export async function writeSongDetails(
  file: AudioFile,
  details: SongDetails,
): Promise<SongDetailField[]> {
  const ext = extensionOf(file.relative);
  if (!canWriteDetails(file.relative)) {
    throw new SongDetailsError(400, `The app can't write tags into ${ext || "these"} files.`);
  }
  let before: IAudioMetadata;
  try {
    before = await readWithCovers(file);
  } catch {
    throw new SongDetailsError(422, "The app couldn't read that song's tags.");
  }
  const missing = missingFrom(detailsPresent(before));
  const adding = detailsFor(missing, details);
  const cover =
    adding.coverUrl !== undefined
      ? await fetchCover({ kind: "catalogue", url: adding.coverUrl })
      : undefined;
  delete adding.coverUrl;
  const added = [
    ...(Object.keys(adding) as SongDetailField[]),
    ...(cover ? (["cover"] as const) : []),
  ];
  if (added.length === 0) return [];

  const stat = await fs.stat(file.absolute);
  // Named unlike the tests' temp files, so `npm run clean` leaves it alone.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ytdownload-details-"));
  let keepCopy = false;
  try {
    const output = path.join(dir, `song${ext}`);
    const metadata = path.join(dir, "tags.txt");
    let coverFile: string | undefined;
    let oggCover: { data: Buffer; type: string } | undefined;
    if (OGG.has(ext)) {
      // Copying an Ogg file leaves its cover behind: put it back, or the new one in.
      const own = (before.common.picture ?? []).find((picture) => picture.data.length > 0);
      if (cover) oggCover = { data: cover, type: "image/jpeg" };
      else if (own) oggCover = { data: Buffer.from(own.data), type: own.format };
    } else if (cover) {
      coverFile = path.join(dir, "cover.jpg");
      await fs.writeFile(coverFile, cover);
    }
    await fs.writeFile(metadata, metadataFile(adding, oggCover));
    const id3Version = Object.keys(before.native).find((type) => /^ID3v2\.[234]$/.test(type));
    const id3 =
      ext === ".mp3"
        ? {
            version: (id3Version === "ID3v2.4" ? 4 : 3) as 3 | 4,
            v1: Object.keys(before.native).some((type) => type.startsWith("ID3v1")),
          }
        : undefined;
    try {
      await runFfmpeg(
        detailsArgs({ input: file.absolute, output, ext, metadata, cover: coverFile, id3 }),
      );
    } catch (err) {
      throw new SongDetailsError(
        422,
        `ffmpeg couldn't add the tags: ${err instanceof Error ? err.message : err}`,
      );
    }

    const after = await parseFile(output, { duration: false, skipCovers: false }).catch(
      () => undefined,
    );
    const problem = after ? rewriteProblem(before, after, added) : "the copy couldn't be read";
    if (problem) {
      throw new SongDetailsError(422, `The song was left as it was: ${problem}.`);
    }

    const data = await fs.readFile(output);
    try {
      await overwrite(file.absolute, data, stat);
    } catch {
      // Once more (a moment's lock); if that fails too, the finished copy stays for the person.
      try {
        await overwrite(file.absolute, data, stat);
      } catch (err) {
        keepCopy = true;
        throw new SongDetailsError(
          500,
          `Couldn't write the song (${(err as NodeJS.ErrnoException).code ?? err}). A copy with the new tags is in ${output}.`,
        );
      }
    }
    forgetTags(file.absolute);
    return added;
  } finally {
    if (!keepCopy) {
      await retryWhenBusy(() => fs.rm(dir, { recursive: true, force: true })).catch(() => {});
    }
  }
}
