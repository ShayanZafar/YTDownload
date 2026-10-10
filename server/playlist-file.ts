import { randomBytes } from "crypto";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { safeFileName } from "@shared/filename";
import type { PlaylistFileSong, SavedPlaylistFile } from "@shared/schema";
import { FolderError, folderError, numberedName } from "./folders";
import { songsInFolder } from "./library";
import { retryWhenBusy } from "./retry-when-busy";

/**
 * "Save playlist file": the playlist panel's songs that are in the "Save to"
 * folder, written into that folder as an .m3u8 playlist (UTF-8 M3U) in the
 * playlist's order, so VLC, Windows Media Player, foobar2000 or a phone that
 * syncs the folder can play the same playlist. The page sends the songs,
 * never a path: which file each song is comes from the folder itself
 * (`songsInFolder()`), and the songs are listed by where they are inside it.
 */

/** The line that marks a playlist file as the app's own — the only kind it ever replaces. */
export const PLAYLIST_FILE_MARK = "# Written by YouTube Audio Extractor";

/** One song in the playlist file: its file inside the folder, and what to show for it. */
export type PlaylistEntry = {
  file: string;
  title: string;
  artists: string;
  duration?: number | null;
};

/** "Road Trip" → "Road Trip.m3u8" (with what Windows can't store in a name swapped out). */
export function playlistFileName(name: string): string {
  return `${safeFileName(name, "Playlist")}.m3u8`;
}

/** Text that goes on one line of the file: no line breaks (they'd start a new entry). */
const oneLine = (text: string) => text.replace(/[\r\n]+/g, " ").trim();

/**
 * The playlist's files, in its order: each song that was found in the folder,
 * once (a playlist can have a song twice, and two songs can be one file).
 */
export function playlistEntries(
  songs: PlaylistFileSong[],
  found: Record<string, { file: string }>,
): PlaylistEntry[] {
  const seen = new Set<string>();
  const entries: PlaylistEntry[] = [];
  for (const song of songs) {
    const file = found[song.id]?.file;
    if (!file || seen.has(file)) continue;
    seen.add(file);
    entries.push({ file, title: song.title, artists: song.artists, duration: song.duration });
  }
  return entries;
}

/**
 * The .m3u8 file's text: a header naming the playlist, then for each song a
 * `#EXTINF` line (length and "Artists - Title", which players show before
 * reading the file) and its place relative to the playlist file.
 */
export function playlistFileText(name: string, entries: PlaylistEntry[], eol = os.EOL): string {
  const lines = ["#EXTM3U", `#PLAYLIST:${oneLine(name)}`, PLAYLIST_FILE_MARK];
  for (const entry of entries) {
    const seconds = entry.duration != null ? Math.round(entry.duration) : -1;
    const shown = [oneLine(entry.artists), oneLine(entry.title)].filter(Boolean).join(" - ");
    lines.push(`#EXTINF:${seconds},${shown}`);
    // A line starting with "#" is a comment: a file named "#1 Hit.mp3" is "./#1 Hit.mp3".
    lines.push(entry.file.startsWith("#") ? `.${path.sep}${entry.file}` : entry.file);
  }
  return lines.join(eol) + eol;
}

/** Is the file at `file` a playlist this app wrote (and so fine to replace with a newer one)? */
export async function isAppPlaylistFile(file: string): Promise<boolean> {
  const stat = await fs.lstat(file).catch(() => undefined);
  if (!stat?.isFile()) return false;
  const handle = await fs.open(file, "r").catch(() => undefined);
  if (!handle) return false;
  try {
    const start = Buffer.alloc(1024);
    const { bytesRead } = await handle.read(start, 0, start.length, 0);
    const lines = start.subarray(0, bytesRead).toString("utf8").split(/\r?\n/);
    return lines[0] === "#EXTM3U" && lines.slice(1, 4).includes(PLAYLIST_FILE_MARK);
  } finally {
    await handle.close();
  }
}

/** Writes `text` over `file`: into a file beside it first, then renamed, so it's never half-written. */
async function replaceFile(file: string, text: string): Promise<void> {
  const temp = `${file}.${randomBytes(4).toString("hex")}.part`;
  try {
    await fs.writeFile(temp, text, { flag: "wx" });
    await retryWhenBusy(() => fs.rename(temp, file));
  } catch (err) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * Writes `text` as `fileName` in `folder` — or `fileName (1)`… if that's
 * another file — replacing a playlist file the app wrote under that name.
 * Returns where it went, and whether it replaced the app's earlier file.
 */
async function writeOver(
  folder: string,
  fileName: string,
  text: string,
): Promise<{ file: string; replaced: boolean }> {
  for (let n = 0; n < 1000; n++) {
    const file = path.join(folder, numberedName(fileName, n));
    if (await isAppPlaylistFile(file)) {
      await replaceFile(file, text);
      return { file, replaced: true };
    }
    try {
      // "wx": never into a file that's there already (made since, even).
      await fs.writeFile(file, text, { flag: "wx" });
      return { file, replaced: false };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        await fs.rm(file, { force: true }).catch(() => undefined); // not left half-written
        throw err;
      }
    }
  }
  throw new FolderError(409, `Too many files named “${fileName}” in that folder.`);
}

/**
 * Writes the playlist `name` into `folder` as "<name>.m3u8", listing its songs
 * that are in the folder (or its subfolders). A file of that name that the app
 * wrote before is replaced — saving again after downloading more songs brings
 * it up to date — but any other file is kept, and this one is "<name> (1).m3u8"
 * (or the app's own "<name> (1).m3u8", replaced in turn).
 */
export async function writePlaylistFile(
  folder: string,
  name: string,
  songs: PlaylistFileSong[],
): Promise<SavedPlaylistFile> {
  const { found } = await songsInFolder(folder, songs);
  const entries = playlistEntries(songs, found);
  if (entries.length === 0) {
    throw new FolderError(409, "None of these songs are in the folder yet.");
  }
  const text = playlistFileText(name, entries);
  const fileName = playlistFileName(name);
  const songCount = new Set(songs.map((song) => song.id)).size;
  try {
    const { file, replaced } = await writeOver(folder, fileName, text);
    return {
      file: path.basename(file),
      songs: entries.length,
      missing: songCount - Object.keys(found).length,
      replaced,
    };
  } catch (err) {
    if (err instanceof FolderError) throw err;
    throw folderError(err, folder, "write");
  }
}
