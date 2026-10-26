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
import { lookUpSongNoted } from "./catalogues";
import { fetchCover } from "./cover";
import { forgetTags, parseFile, readTags, type AudioFile } from "./library";
import { spawnFfmpeg } from "./audio";
import { runFfmpeg } from "./music";
import { retryWhenBusy } from "./retry-when-busy";
import { withFramesFrom } from "./id3-frames";
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

// --- What a file really is -----------------------------------------------------------

/**
 * A file's container and audio codec, as ffmpeg sees them ("mp3" and "mp3";
 * "mov,mp4,m4a,3gp,3g2,mj2" and "aac"), from what `ffmpeg -i` prints.
 */
export function parseProbe(stderr: string): { container?: string; codec?: string } {
  return {
    container: /^Input #0, (.+?), from /m.exec(stderr)?.[1],
    codec: /^\s*Stream #0:\d+\S*: Audio: ([A-Za-z0-9_]+)/m.exec(stderr)?.[1],
  };
}

const PROBE_TIMEOUT_MS = 15_000;

/** What ffmpeg finds `file` really is (it reads only the start). */
export function probeFile(file: string): Promise<{ container?: string; codec?: string }> {
  return new Promise((resolve) => {
    let stderr = "";
    let child: ReturnType<typeof spawnFfmpeg>;
    try {
      child = spawnFfmpeg(["-hide_banner", "-nostdin", "-i", file]);
    } catch {
      return resolve({});
    }
    const timer = setTimeout(() => child.kill(), PROBE_TIMEOUT_MS);
    child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk).slice(0, 20_000)));
    child.stdout.resume();
    child.stdin.on("error", () => {});
    child.on("error", () => {
      clearTimeout(timer);
      resolve({});
    });
    // ffmpeg exits with an error here (no output was asked for): what it printed is the answer.
    child.on("close", () => {
      clearTimeout(timer);
      resolve(parseProbe(stderr));
    });
  });
}

/** The file name ending for what a file really holds, when the app can tag that. */
function rightExtension(container: string, codec: string): string | undefined {
  if (container === "mp3" && codec === "mp3") return ".mp3";
  if (container.includes("mp4") && (codec === "aac" || codec === "alac")) return ".m4a";
  if (container === "flac" && codec === "flac") return ".flac";
  if (container === "ogg" && codec === "opus") return ".opus";
  if (container === "ogg" && (codec === "vorbis" || codec === "flac")) return ".ogg";
  return undefined;
}

const KINDS: Record<string, string> = {
  ".mp3": "an MP3",
  ".m4a": "an M4A (AAC or Apple Lossless)",
  ".flac": "a FLAC",
  ".opus": "an Opus",
  ".ogg": "an Ogg",
};

/**
 * The muxer to write a file with — or, for a file whose name says one kind
 * and whose contents are another (an M4A or Ogg file named ".mp3", MP2 audio
 * in an ".mp3"), what's wrong, to tell the person: copied into the kind its
 * name says, ffmpeg would refuse ("Invalid argument").
 */
export function muxerFor(
  ext: string,
  probed: { container?: string; codec?: string },
): { muxer: string } | { problem: string } {
  const { container, codec } = probed;
  if (!container || !codec)
    return { problem: "ffmpeg couldn't tell what kind of audio file it is" };
  const right = rightExtension(container, codec);
  // An .ogg or .oga file may hold any of Ogg's codecs; an .opus file only Opus.
  const fits = ext === ".ogg" || ext === ".oga" ? [".ogg", ".opus"] : [ext];
  if (right && fits.includes(right)) return { muxer: MUXERS[ext] };
  const what = `${codec.toUpperCase()} audio${right ? "" : ` in a file ffmpeg calls “${container.split(",")[0]}”`}`;
  return {
    problem: right
      ? `it's really ${KINDS[right]} file (${what}) named ${ext}: rename it to end in ${right}, then try again`
      : `it's really ${what}, though it's named ${ext}, and the app can't add tags to that`,
  };
}

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
  let writable = metadata !== undefined && canWriteDetails(file.relative);
  let problem: string | null = metadata ? null : "the app couldn't read the file's tags";
  if (writable && missing.length > 0) {
    // A file whose name says one kind and whose contents are another can't be written.
    const muxed = muxerFor(extensionOf(file.relative), await probeFile(file.absolute));
    if ("problem" in muxed) {
      writable = false;
      problem = muxed.problem;
    }
  }
  const none = { missing, writable, problem, notes: [], found: null, match: null, source: null };
  if (missing.length === 0 || !writable) return none;

  const tags = await readTags(file);
  const { match, notes } = await lookUpSongNoted({
    title: tags.title ?? songNameOf(file.relative),
    artist: tags.trackArtist,
    duration: tags.duration,
  });
  if (!match) return { ...none, notes };
  const { song, source } = match;
  const found = detailsFor(missing, song);
  if (Object.keys(found).length === 0) {
    const catalogue = source === "itunes" ? "iTunes" : "Deezer";
    return {
      ...none,
      notes: [
        `${catalogue} has it (“${song.title}” by ${song.artist}) but not what it lacks (${missing.join(", ")})`,
      ],
    };
  }
  return {
    missing,
    writable,
    problem,
    notes: [],
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

/** The tags ("ID3v2.3:WOAS") `before` has more of than `after`. */
function lostTags(before: IAudioMetadata, after: IAudioMetadata): string[] {
  const has = tagCounts(after);
  return Array.from(tagCounts(before))
    .filter(([key, count]) => (has.get(key) ?? 0) < count)
    .map(([key]) => key);
}

/**
 * The ID3v2 frames ffmpeg dropped from an MP3's copy (it can't copy web
 * addresses, play counts, ratings…), put back into the copy from the
 * original. Returns the copy's tags afterwards.
 */
async function putBackFrames(
  original: string,
  copy: string,
  before: IAudioMetadata,
  after: IAudioMetadata,
) {
  const has = tagCounts(after);
  const ids = lostTags(before, after)
    .filter((key) => !has.has(key))
    .flatMap((key) => /^ID3v2\.[34]:([A-Z0-9]{4})$/.exec(key)?.[1] ?? []);
  if (ids.length === 0) return after;
  const fixed = withFramesFrom(await fs.readFile(original), await fs.readFile(copy), ids);
  if (!fixed) return after;
  await fs.writeFile(copy, fixed);
  return parseFile(copy, { duration: false, skipCovers: false }).catch(() => undefined);
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
  const lost = lostTags(before, after);
  if (lost.length > 0) return `it would lose some of its tags (${lost[0]})`;
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
  muxer = MUXERS[ext],
  replace = {},
}: {
  input: string;
  output: string;
  ext: string;
  /** The muxer for what the file really is (muxerFor()); by default, its name's. */
  muxer?: string;
  /** ffmpeg's metadata file with the new tags. */
  metadata: string;
  /** A new cover picture's file, for a file that holds one as a picture stream. */
  cover?: string;
  /** An MP3's ID3v2 version (3 or 4), and whether it has an ID3v1 tag at its end. */
  id3?: { version: 3 | 4; v1: boolean };
  /** Tags to set over the ones the file has (a renamed title or artist). */
  replace?: Partial<Record<"title" | "artist", string>>;
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
  // The file's own tags would win over the metadata file's: these win over both.
  for (const [key, value] of Object.entries(replace)) args.push("-metadata", `${key}=${value}`);
  if (id3) {
    args.push("-id3v2_version", String(id3.version));
    if (id3.v1) args.push("-write_id3v1", "1");
  }
  args.push("-f", muxer, "-y", output);
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
  { replace = {} }: { replace?: Partial<Record<"title" | "artist", string>> } = {},
): Promise<SongDetailField[]> {
  const ext = extensionOf(file.relative);
  if (!canWriteDetails(file.relative)) {
    throw new SongDetailsError(400, `The app can't write tags into ${ext || "these"} files.`);
  }
  const muxed = muxerFor(ext, await probeFile(file.absolute));
  if ("problem" in muxed) {
    throw new SongDetailsError(422, `The song was left as it was: ${muxed.problem}.`);
  }
  let before: IAudioMetadata;
  try {
    before = await readWithCovers(file);
  } catch {
    throw new SongDetailsError(422, "The app couldn't read that song's tags.");
  }
  const missing = missingFrom(detailsPresent(before));
  const adding = detailsFor(missing, details);
  // A new title or artist the person typed (Rename), over the one it has.
  const replacing = Object.fromEntries(
    Object.entries(replace).filter(
      ([field, value]) => value && value !== before.common[field as "title" | "artist"],
    ),
  );
  Object.assign(adding, replacing);
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
        detailsArgs({
          input: file.absolute,
          output,
          ext,
          metadata,
          cover: coverFile,
          id3,
          muxer: muxed.muxer,
          replace: replacing,
        }),
      );
    } catch (err) {
      throw new SongDetailsError(
        422,
        `ffmpeg couldn't add the tags: ${err instanceof Error ? err.message : err}`,
      );
    }

    let after = await parseFile(output, { duration: false, skipCovers: false }).catch(
      () => undefined,
    );
    if (after && ext === ".mp3") after = await putBackFrames(file.absolute, output, before, after);
    const wrong = Object.keys(replacing).find(
      (field) => after?.common[field as "title" | "artist"] !== replacing[field],
    );
    const problem = !after
      ? "the copy couldn't be read"
      : (rewriteProblem(before, after, added) ??
        (wrong ? `the new ${wrong} didn't go in` : undefined));
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
