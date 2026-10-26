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
import { promises as fs, type Dirent, type Stats } from "fs";
import path from "path";
import type { IAudioMetadata, IOptions } from "music-metadata";
import { AUDIO_TYPES, genresOf } from "@shared/audio-types";
import { safeFileName } from "@shared/filename";
import { foldWords } from "@shared/fold-text";
import {
  foundByValues,
  historyFoundByValues,
  type Download,
  type SongToFind,
  type SongsInFolder,
} from "@shared/schema";
import { cleanTrackTitle } from "@shared/spotify-names";
import { mapAtOnce } from "./cpu-cores";
import { kindProblem, sniffFile } from "./file-kind";
import { folderError, isHiddenFolder } from "./folders";

/** Files looked at as songs: .mp3, .m4a, .opus, .flac… (see shared/audio-types.ts). */
export const AUDIO_EXTENSIONS = new Set(Object.keys(AUDIO_TYPES));

/** The most audio files looked at in one folder (a whole music library can be bigger). */
export const MAX_SONG_FILES = 5_000;
/** How deep into subfolders to look: Artist\Album\Disc 1 is three deep. */
const MAX_DEPTH = 6;
/** Folder entries looked at in all, files and folders alike — a limit for a folder like C:\. */
const MAX_ENTRIES = 50_000;

export type FoundBy = (typeof foundByValues)[number];
export type HistoryFoundBy = (typeof historyFoundByValues)[number];

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
  /** Its genre tags ("Rock", "Hip-Hop/Rap"), each once. */
  genres?: string[];
  /** The year its tags give. */
  year?: number;
  /** Length in seconds, when the file says without being read all the way through. */
  duration?: number;
  /** Its content is another kind of audio than its name says: the extension it should have. */
  realType?: string;
  /** It isn't audio at all, by its content: what it is ("a Windows program"). */
  notAudio?: string;
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
 * is false if there were more than the app looks at. With `others`, every
 * other file found goes there (for Housekeeping).
 */
export async function findAudioFiles(
  folder: string,
  { maxFiles = MAX_SONG_FILES, others }: { maxFiles?: number; others?: AudioFile[] } = {},
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
    const other: string[] = [];
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
      } else if (item.isFile() && others) {
        other.push(path.join(dir, item.name));
      }
    }
    if (others) {
      const found = await Promise.all(other.map((file) => fs.stat(file).catch(() => undefined)));
      other.forEach((absolute, i) => {
        const stat = found[i];
        if (stat) others.push(audioFileOf(folder, absolute, stat));
      });
    }

    const stats = await Promise.all(audio.map((file) => fs.stat(file).catch(() => undefined)));
    audio.forEach((absolute, i) => {
      const stat = stats[i];
      if (!stat) return; // gone already
      if (files.length >= maxFiles) {
        complete = false;
        return;
      }
      files.push(audioFileOf(folder, absolute, stat));
    });
    if (entries > MAX_ENTRIES || files.length >= maxFiles) {
      if (queue.length > 0) complete = false;
      break;
    }
  }
  return { files, complete };
}

function audioFileOf(folder: string, absolute: string, stat: Stats): AudioFile {
  return {
    absolute,
    relative: path.relative(folder, absolute),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    addedMs: Math.max(stat.birthtimeMs || 0, stat.mtimeMs),
  };
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

/** Forgets a file's tags, so they're read again (after the app writes new ones). */
export function forgetTags(absolute: string) {
  tagCache.delete(absolute);
}

export function readTags(file: AudioFile): Promise<FileTags> {
  const cached = tagCache.get(file.absolute);
  if (cached && cached.size === file.size && cached.mtimeMs === file.mtimeMs) return cached.tags;
  const read = parseFile(file.absolute, { duration: false, skipCovers: true, mkvUseIndex: true })
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
  // And what its content says it is (see file-kind.ts).
  const kind = sniffFile(file.absolute).catch(() => undefined);
  const tags = Promise.all([read, kind]).then(([found, sniffed]) => ({
    ...found,
    ...kindProblem(file.relative, sniffed),
  }));
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
    genres: genresOf(common.genre).length ? genresOf(common.genre) : undefined,
    year: common.year && common.year > 0 ? common.year : undefined,
    duration:
      duration !== undefined && Number.isFinite(duration) && duration > 0 ? duration : undefined,
  };
}

/** The audio files in `folder` (and its subfolders), each with its tags. */
export async function readFolderTags(
  folder: string,
): Promise<{ files: (AudioFile & { tags: FileTags })[]; complete: boolean }> {
  const { files, complete } = await findAudioFiles(folder);
  // As many files at once as this computer has CPU cores.
  const tags = await mapAtOnce(files, readTags);
  return { files: files.map((file, i) => ({ ...file, tags: tags[i] })), complete };
}

/** The audio files in `folder` (and its subfolders), with their tags. */
export async function readSongFiles(
  folder: string,
): Promise<{ files: SongFile[]; complete: boolean }> {
  const { files, complete } = await readFolderTags(folder);
  return {
    // A file that isn't audio (whatever its name) isn't a song in the folder.
    files: files
      .filter((file) => !file.tags.notAudio)
      .map((file) => ({ path: file.relative, ...file.tags })),
    complete,
  };
}

// --- Matching songs to files ------------------------------------------------------

/**
 * Text reduced to its words, in any alphabet: lowercase, accents gone, and
 * anything that isn't a letter or digit a space. "Beyoncé — Halo!" → "beyonce halo".
 */
export function words(text: string): string {
  return foldWords(text, "all");
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

// --- Finding downloads from the history ----------------------------------------------

/**
 * A file name as it's compared: no folders, no audio extension, no " (1)"
 * a second copy got, and any case. "Shy's Tunes\Get Lucky (1).MP3" → "get lucky".
 */
export function fileNameKey(name: string): string {
  const base = name.split(/[\\/]+/).pop() ?? "";
  const ext = path.extname(base).toLowerCase();
  const stem = AUDIO_EXTENSIONS.has(ext) ? base.slice(0, -ext.length) : base;
  return stem
    .replace(/\s\(\d+\)$/, "")
    .normalize("NFC")
    .toLowerCase()
    .trim();
}

/**
 * A video's title as a song: "Daft Punk - Get Lucky (Official Video)" → the
 * title "Get Lucky (Official Video)" by "Daft Punk". Without " - ", the whole
 * title, by no one known.
 */
export function songOfVideoTitle(title: string): { title: string; artists: string } {
  const dash = /\s[-–—]\s/.exec(title);
  if (!dash) return { title, artists: "" };
  return {
    artists: title.slice(0, dash.index).trim(),
    title: title.slice(dash.index + dash[0].length).trim(),
  };
}

/**
 * For each download in the history that's in the folder: the file that is it,
 * and how it was recognised. In order:
 * 1. a file named as it was saved (`fileName`; for an older entry, its title
 *    made a file name, as the app names files), anywhere in the folder, as a
 *    second copy ("Song (1).mp3") or with another audio extension too;
 * 2. a file with its Spotify song in the tags;
 * 3. its title and artist, read from the video's "Artist - Title" — as a
 *    playlist's songs are found (`findSongs()`).
 */
export function findDownloads(
  entries: Pick<Download, "id" | "title" | "spotifyId" | "fileName">[],
  files: SongFile[],
): Record<string, { file: string; by: HistoryFoundBy }> {
  // The first file by each name: the folder itself is looked through first.
  const byName = new Map<string, string>();
  for (const file of files) {
    const key = fileNameKey(file.path);
    if (key && !byName.has(key)) byName.set(key, file.path);
  }
  const songs: SongToFind[] = [];
  const found: Record<string, { file: string; by: HistoryFoundBy }> = {};
  for (const entry of entries) {
    const named = byName.get(fileNameKey(entry.fileName ?? `${safeFileName(entry.title)}.mp3`));
    if (named) {
      found[entry.id] = { file: named, by: "file" };
      continue;
    }
    const song = songOfVideoTitle(entry.title);
    // The id only matters to a file whose tags name a Spotify song.
    songs.push({ id: entry.spotifyId ?? `history-${entry.id}`, ...song });
  }
  const bySong = findSongs(songs, files);
  for (const entry of entries) {
    if (found[entry.id]) continue;
    const match = bySong[entry.spotifyId ?? `history-${entry.id}`];
    if (match) found[entry.id] = match;
  }
  return found;
}
