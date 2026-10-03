/**
 * Which of a playlist's songs are already in the "Save to" folder — so the
 * playlist panel can mark them "In folder" and offer to download the rest.
 *
 * The folder and its subfolders (Artist\Album, say) are looked through for
 * audio files, and each file's tags are read: title, artist, and the Spotify
 * song this app writes into every file it downloads for a Spotify song (see
 * `ffmpegInputAndTags` in audio.ts). A file's tags are read once and
 * remembered until the file changes, so looking again after each download is
 * quick. Only the folder chosen in "Save to" is ever read (see the route).
 *
 * A song counts as in the folder when a file:
 * 1. carries its Spotify id (or link) in its tags — files from this app, or
 *    tools that tag files the same way;
 * 2. has its title and one of its artists, in the tags, the file name or the
 *    folders it's in ("Queen\Greatest Hits\Bohemian Rhapsody.mp3");
 * 3. or is named exactly like the song ("Bohemian Rhapsody.mp3"), with no
 *    artist tag that says it's someone else's.
 */
import { promises as fs, type Dirent } from "fs";
import path from "path";
import type { IAudioMetadata, IOptions } from "music-metadata";
import { AUDIO_TYPES } from "@shared/audio-types";
import { foundByValues, type SongToFind, type SongsInFolder } from "@shared/schema";
import { cleanTrackTitle } from "@shared/spotify-names";
import { folderError, isHiddenFolder } from "./folders";

/** Files looked at as songs: .mp3, .m4a, .opus, .flac… (see shared/audio-types.ts). */
export const AUDIO_EXTENSIONS = new Set(Object.keys(AUDIO_TYPES));

/** The most audio files looked at in one folder (a whole music library can be bigger). */
export const MAX_SONG_FILES = 5_000;
/** How deep into subfolders to look: Artist\Album\Disc 1 is three deep. */
const MAX_DEPTH = 6;
/** Folder entries looked at in all, files and folders alike — a limit for a folder like C:\. */
const MAX_ENTRIES = 50_000;
/** Files whose tags are read at the same time. */
const READ_AT_ONCE = 8;

export type FoundBy = (typeof foundByValues)[number];

/** An audio file in the folder, with what its tags say. */
export type SongFile = {
  /** Where it is inside the folder: "Queen\Greatest Hits\Bohemian Rhapsody.mp3". */
  path: string;
  title?: string;
  /** The artist tags (track and album artist) as one string. */
  artist?: string;
  /** Spotify songs named in its tags. */
  spotifyIds: string[];
  /** For the music player: the song's own artists ("Daft Punk, Pharrell Williams"), else the album artist. */
  trackArtist?: string;
  album?: string;
  /** Length in seconds, when the file says without being read all the way through. */
  duration?: number;
};

export type FileTags = Omit<SongFile, "path">;

// --- Looking through the folder --------------------------------------------------

export type AudioFile = {
  absolute: string;
  /** Where it is inside the folder: "Queen\Greatest Hits\Bohemian Rhapsody.mp3". */
  relative: string;
  size: number;
  mtimeMs: number;
  /** When it arrived: made in the folder (a copied file keeps its old change time), or changed since. */
  addedMs: number;
};

/**
 * The audio files in `folder` and its subfolders (not hidden or system ones,
 * and not through shortcuts/links), in the same order every time. `complete`
 * is false if there were more than the app looks at.
 */
export async function findAudioFiles(
  folder: string,
  { maxFiles = MAX_SONG_FILES } = {},
): Promise<{ files: AudioFile[]; complete: boolean }> {
  const files: AudioFile[] = [];
  let complete = true;
  let entries = 0;
  const queue = [{ dir: folder, depth: 0 }];

  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;
    let items: Dirent[];
    try {
      items = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (dir === folder) throw folderError(err, folder, "open");
      continue; // a subfolder the app may not open: leave it out
    }
    items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    const audio: string[] = [];
    for (const item of items) {
      if (++entries > MAX_ENTRIES) {
        complete = false;
        break;
      }
      if (item.isDirectory()) {
        if (isHiddenFolder(item.name)) continue;
        if (depth < MAX_DEPTH) queue.push({ dir: path.join(dir, item.name), depth: depth + 1 });
        else complete = false;
      } else if (item.isFile() && AUDIO_EXTENSIONS.has(path.extname(item.name).toLowerCase())) {
        audio.push(path.join(dir, item.name));
      }
    }

    const stats = await Promise.all(audio.map((file) => fs.stat(file).catch(() => undefined)));
    audio.forEach((absolute, i) => {
      const stat = stats[i];
      if (!stat) return; // gone already
      if (files.length >= maxFiles) {
        complete = false;
        return;
      }
      files.push({
        absolute,
        relative: path.relative(folder, absolute),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        addedMs: Math.max(stat.birthtimeMs || 0, stat.mtimeMs),
      });
    });
    if (entries > MAX_ENTRIES || files.length >= maxFiles) {
      if (queue.length > 0) complete = false;
      break;
    }
  }
  return { files, complete };
}

// --- Reading tags -------------------------------------------------------------------

// music-metadata is only loaded when a folder is first checked. Its package
// only describes parseFile for Node (an "exports" condition TypeScript's
// "bundler" resolution doesn't look at), so the type is spelled out here.
type ParseFile = (filePath: string, options?: IOptions) => Promise<IAudioMetadata>;
let parser: Promise<ParseFile> | undefined;
export const parseFile: ParseFile = async (file, options) => {
  parser ??= import("music-metadata").then(
    (mm) => (mm as unknown as { parseFile: ParseFile }).parseFile,
  );
  return (await parser)(file, options);
};

// Tags already read, by file — kept until the file changes (its size or time).
const tagCache = new Map<string, { size: number; mtimeMs: number; tags: Promise<FileTags> }>();
const MAX_CACHED = 20_000;

export function readTags(file: AudioFile): Promise<FileTags> {
  const cached = tagCache.get(file.absolute);
  if (cached && cached.size === file.size && cached.mtimeMs === file.mtimeMs) return cached.tags;
  const tags = parseFile(file.absolute, { duration: false, skipCovers: true, mkvUseIndex: true })
    .then(async (metadata) => {
      const found = tagsFrom(metadata);
      const { container, codec, sampleRate } = metadata.format;
      // An Ogg file (.opus, .ogg) only says how long it is at its very end.
      if (found.duration === undefined && /ogg/i.test(container ?? "")) {
        // Opus counts in 48 kHz samples, whatever the audio's rate.
        const rate = /opus/i.test(codec ?? "") ? 48_000 : sampleRate;
        if (rate) found.duration = await oggDuration(file.absolute, rate).catch(() => undefined);
      }
      return found;
    })
    // Unreadable or damaged: the file still counts by its name.
    .catch((): FileTags => ({ spotifyIds: [] }));
  if (tagCache.size >= MAX_CACHED) tagCache.clear();
  tagCache.set(file.absolute, { size: file.size, mtimeMs: file.mtimeMs, tags });
  return tags;
}

/** How much of an Ogg file's end is read to find its last page (a page is at most ~64 KB). */
const OGG_TAIL_BYTES = 70_000;

/**
 * An Ogg file's length in seconds, from its last page — the position there
 * counts samples at `rate` — or undefined if the end doesn't look like one.
 * (music-metadata would read the whole file for this.)
 */
export async function oggDuration(file: string, rate: number): Promise<number | undefined> {
  const handle = await fs.open(file, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, OGG_TAIL_BYTES);
    const tail = Buffer.alloc(length);
    await handle.read(tail, 0, length, size - length);
    // The last real page ends exactly where the file does ("OggS" can turn up
    // inside the audio too, so check each candidate from the end).
    for (let at = tail.lastIndexOf("OggS"); at >= 0; at = tail.lastIndexOf("OggS", at - 1)) {
      if (at + 27 > length || tail[at + 4] !== 0) continue;
      const segments = tail[at + 26];
      if (at + 27 + segments > length) continue;
      let pageEnd = at + 27 + segments;
      for (let i = 0; i < segments; i++) pageEnd += tail[at + 27 + i];
      if (pageEnd !== length) continue;
      const samples = Number(tail.readBigInt64LE(at + 6));
      return samples > 0 ? samples / rate : undefined;
    }
    return undefined;
  } finally {
    await handle.close();
  }
}

type TagValue = unknown;

/** The text of a tag value: a plain string, a comment's text, or a link's address. */
function tagText(value: TagValue): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const { text, url } = value as { text?: unknown; url?: unknown };
    if (typeof text === "string") return text;
    if (typeof url === "string") return url;
  }
  return undefined;
}

const SPOTIFY_SONG_LINK_RE =
  /(?:open\.spotify\.com\/(?:intl-[a-z]{2}(?:-[a-z]{2,4})?\/)?track\/|spotify:track:)([A-Za-z0-9]{22})/g;
const BARE_SPOTIFY_ID_RE = /(?:^|[^A-Za-z0-9])([A-Za-z0-9]{22})(?![A-Za-z0-9])/g;
// A tag that holds just a song's id: TXXX:spotify_id (ours), SPOTIFY_ID, SPOTIFY_TRACK_ID…
const SPOTIFY_ID_TAG_RE = /spotify[^a-z0-9]?(track[^a-z0-9]?)?id$/i;

/**
 * The Spotify songs a file's tags name: an id tag of its own (what this app
 * writes), or a song link anywhere (in a comment, say).
 */
export function spotifyIdsInTags(native: Record<string, { id: string; value: TagValue }[]>) {
  const ids = new Set<string>();
  Object.keys(native).forEach((tagType) => {
    // ID3v2.3 splits text at "/" (its separator for several values), which
    // cuts a link apart: put each tag's pieces back together first.
    const byId = new Map<string, string[]>();
    native[tagType].forEach(({ id, value }) => {
      const text = tagText(value);
      if (text !== undefined) byId.set(id, [...(byId.get(id) ?? []), text]);
    });
    byId.forEach((values, id) => {
      const text = values.join("/");
      Array.from(text.matchAll(SPOTIFY_SONG_LINK_RE)).forEach((m) => ids.add(m[1]));
      if (SPOTIFY_ID_TAG_RE.test(id)) {
        Array.from(text.matchAll(BARE_SPOTIFY_ID_RE)).forEach((m) => ids.add(m[1]));
      }
    });
  });
  return Array.from(ids);
}

/** What the matching (and the music player) needs from a file's tags. */
export function tagsFrom({
  common,
  native,
  format,
}: Pick<IAudioMetadata, "common" | "native"> & {
  format?: Pick<IAudioMetadata["format"], "duration">;
}): FileTags {
  const trackArtist = common.artists?.length ? common.artists.join(", ") : common.artist;
  const artist = [trackArtist, common.albumartist]
    .filter((a): a is string => !!a?.trim())
    .join(" / ");
  const duration = format?.duration;
  return {
    title: common.title?.trim() || undefined,
    artist: artist || undefined,
    spotifyIds: spotifyIdsInTags(native),
    trackArtist: trackArtist?.trim() || common.albumartist?.trim() || undefined,
    album: common.album?.trim() || undefined,
    duration:
      duration !== undefined && Number.isFinite(duration) && duration > 0 ? duration : undefined,
  };
}

/** Runs `fn` on every item, at most `limit` at a time. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** The audio files in `folder` (and its subfolders), each with its tags. */
export async function readFolderTags(
  folder: string,
): Promise<{ files: (AudioFile & { tags: FileTags })[]; complete: boolean }> {
  const { files, complete } = await findAudioFiles(folder);
  const tags = await mapLimit(files, READ_AT_ONCE, readTags);
  return { files: files.map((file, i) => ({ ...file, tags: tags[i] })), complete };
}

/** The audio files in `folder` (and its subfolders), with their tags. */
export async function readSongFiles(
  folder: string,
): Promise<{ files: SongFile[]; complete: boolean }> {
  const { files, complete } = await readFolderTags(folder);
  return { files: files.map((file) => ({ path: file.relative, ...file.tags })), complete };
}

// --- Matching songs to files ------------------------------------------------------

// Built with `new RegExp`: TypeScript refuses the "u" flag in a regex literal
// at this project's default (ES5) target, though Node runs it fine.
const ACCENTS_RE = new RegExp("\\p{M}+", "gu");
const NOT_LETTERS_RE = new RegExp("[^\\p{L}\\p{N}]+", "gu");

/**
 * Text reduced to its words, in any alphabet: lowercase, accents gone, and
 * anything that isn't a letter or digit a space. "Beyoncé — Halo!" → "beyonce halo".
 */
export function words(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(ACCENTS_RE, "")
    .replace(NOT_LETTERS_RE, " ")
    .trim();
}

/** Does `text` have `phrase` in it, as whole words? */
const hasWords = (text: string, phrase: string) =>
  phrase !== "" && ` ${text} `.includes(` ${phrase} `);

/**
 * A song title's words without versions and extras, as a file may name it:
 * "Sweet Dreams (Are Made of This) - 2005 Remaster" → "sweet dreams".
 */
export function titleWords(title: string): string {
  const clean = cleanTrackTitle(title);
  const core = clean.replace(/[([{][^)\]}]*[)\]}]/g, " ").replace(/\s[-–—]\s.*$/, "");
  return words(core) || words(clean);
}

/**
 * Each of a song's artists, and duos' names on their own too:
 * "Daryl Hall & John Oates, Someone" → the duo, "daryl hall", "john oates", "someone".
 */
export function artistWords(artists: string): string[] {
  const names = artists.split(",").flatMap((name) => [name, ...name.split(/\s(?:&|and|\+)\s/i)]);
  return Array.from(new Set(names.map(words).filter((name) => name.length >= 2)));
}

/** A file, as words to look for a song in. */
type FileWords = {
  file: SongFile;
  /** The file's own name: "06 Billie Jean (1).mp3" → "billie jean". */
  name: string;
  tagTitle: string;
  /** Where a song's title can be: the title tag and the file name. */
  titleText: string;
  /** Where its artist can be: those, the artist tags and the folders it's in. */
  artistText: string;
  hasArtistTag: boolean;
};

function fileWords(file: SongFile): FileWords {
  const parts = file.path.split(/[\\/]+/);
  const fileName = parts.pop() ?? "";
  const name = words(
    fileName
      .replace(/\.[^.]+$/, "") // extension
      .replace(/\s\(\d+\)$/, "") // "Song (1)": a second copy
      .replace(/^\d{1,3}(?:[-.]\d{1,3})?(?:\s*[-.]\s*|\s+)/, ""), // "06 ", "1-06. ", "06 - "
  );
  const tagTitle = words(file.title ?? "");
  const artistTag = words(file.artist ?? "");
  return {
    file,
    name,
    tagTitle,
    titleText: `${tagTitle} ${name}`,
    artistText: [artistTag, tagTitle, name, ...parts.map(words)].join(" "),
    hasArtistTag: artistTag !== "",
  };
}

/** Is one of the artists named in `text`? ("AC/DC" is found in "ACDC - Back in Black" too.) */
function hasArtist(text: string, artists: string[]): boolean {
  const compact = text.replace(/ /g, "");
  return artists.some(
    (artist) =>
      hasWords(text, artist) ||
      (artist.replace(/ /g, "").length >= 4 && compact.includes(artist.replace(/ /g, ""))),
  );
}

/** How well a file is the song, or undefined if it isn't. */
function matchFile(
  song: { id: string; title: string; artists: string[] },
  f: FileWords,
): FoundBy | undefined {
  if (f.file.spotifyIds.includes(song.id)) return "spotify";
  if (!song.title || !hasWords(f.titleText, song.title)) return undefined;
  if (hasArtist(f.artistText, song.artists)) return "title-artist";
  // Named just like the song, and no artist tag saying it's someone else's.
  if (!f.hasArtistTag && (f.name === song.title || f.tagTitle === song.title)) return "title";
  return undefined;
}

const RANK: Record<FoundBy, number> = { spotify: 3, "title-artist": 2, title: 1 };

/** For each song that's in the folder: the file that is it, and how it was recognised. */
export function findSongs(
  songs: SongToFind[],
  files: SongFile[],
): Record<string, { file: string; by: FoundBy }> {
  const prepared = files.map(fileWords);
  const found: Record<string, { file: string; by: FoundBy }> = {};
  for (const song of songs) {
    const wanted = {
      id: song.id,
      title: titleWords(song.title),
      artists: artistWords(song.artists),
    };
    for (const f of prepared) {
      const by = matchFile(wanted, f);
      if (by && (!found[song.id] || RANK[by] > RANK[found[song.id].by])) {
        found[song.id] = { file: f.file.path, by };
        if (by === "spotify") break;
      }
    }
  }
  return found;
}

/** Which of `songs` are in `folder` (or its subfolders). */
export async function songsInFolder(folder: string, songs: SongToFind[]): Promise<SongsInFolder> {
  const { files, complete } = await readSongFiles(folder);
  return { folder, files: files.length, complete, found: findSongs(songs, files) };
}
