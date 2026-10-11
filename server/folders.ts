import { execFile } from "child_process";
import { constants, promises as fs, type WriteStream } from "fs";
import type { FileHandle } from "fs/promises";
import os from "os";
import path from "path";
import { safeFileName } from "@shared/filename";

/**
 * The folder browser behind "Save to": lets the page (which can't see the
 * disk itself) list folders on this computer, make a new one, and check that
 * a chosen folder can be written to. Only ever reached from this computer —
 * see localOnly in server/local-only.ts.
 */

export type FolderEntry = { name: string; path: string };

export class FolderError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// Folders nobody saves music into: system and "hidden" ones.
const HIDDEN_NAMES = new Set([
  "$recycle.bin",
  "system volume information",
  "config.msi",
  "recovery",
  "appdata",
  "node_modules",
  "__pycache__",
]);
const MAX_ENTRIES = 1000;

/** A system or "hidden" folder, which nobody saves music into: .git, $RECYCLE.BIN, AppData… */
export const isHiddenFolder = (name: string) =>
  name.startsWith(".") || name.startsWith("$") || HIDDEN_NAMES.has(name.toLowerCase());

// --- Quick links ---------------------------------------------------------------

const QUICK_LINKS = ["Music", "Downloads", "Desktop", "Documents"] as const;
type QuickLink = (typeof QUICK_LINKS)[number];

// Windows keeps where these folders really are in the registry: they can be
// moved (Properties → Location) or backed up to OneDrive, and then the
// folder of that name in your home folder is empty or gone.
const SHELL_FOLDERS_KEY =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders";
const SHELL_FOLDER_NAMES: Record<string, QuickLink> = {
  "My Music": "Music",
  "{374DE290-123F-4565-9164-39C4925E467B}": "Downloads",
  Desktop: "Desktop",
  Personal: "Documents",
};

/**
 * Reads `reg query` output for the shell folders key into where each quick-link
 * folder is, with variables like %USERPROFILE% filled in.
 */
export function parseShellFolders(
  output: string,
  env: Record<string, string | undefined> = process.env,
): Partial<Record<QuickLink, string>> {
  const found: Partial<Record<QuickLink, string>> = {};
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s+(.+?)\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/.exec(line);
    const link = match && SHELL_FOLDER_NAMES[match[1]];
    if (!match || !link) continue;
    found[link] = match[2].replace(/%([^%]+)%/g, (whole, name: string) => {
      const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
      return (key && env[key]) || whole;
    });
  }
  return found;
}

function windowsShellFolders(): Promise<Partial<Record<QuickLink, string>>> {
  return new Promise((resolve) => {
    execFile(
      "reg",
      ["query", SHELL_FOLDERS_KEY],
      { windowsHide: true, timeout: 5_000 },
      (err, stdout) => resolve(err ? {} : parseShellFolders(stdout)),
    );
  });
}

const isFolder = (dir: string) =>
  fs.stat(dir).then(
    (s) => s.isDirectory(),
    () => false,
  );

/**
 * Resolves to `value`, or to `fallback` if that takes longer than `ms` — for a
 * disconnected network drive, which can keep a check hanging for many seconds.
 */
function within<T>(ms: number, value: Promise<T>, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([value, timeout]).finally(() => clearTimeout(timer));
}

async function findQuickLinks(): Promise<FolderEntry[]> {
  const home = os.homedir();
  const moved = process.platform === "win32" ? await windowsShellFolders() : {};
  const links = await Promise.all(
    QUICK_LINKS.map(async (name): Promise<FolderEntry | undefined> => {
      for (const dir of [moved[name], path.join(home, name)]) {
        if (dir && path.isAbsolute(dir) && (await within(1_500, isFolder(dir), false))) {
          return { name, path: path.normalize(dir) };
        }
      }
      return undefined;
    }),
  );
  const places = links.filter((link): link is FolderEntry => link !== undefined);
  places.push({ name: "Home", path: home });

  if (process.platform === "win32") {
    const letters = Array.from("CDEFGHIJKLMNOPQRSTUVWXYZ");
    const present = await Promise.all(
      letters.map((letter) => within(1_000, isFolder(`${letter}:\\`), false)),
    );
    letters.forEach((letter, i) => {
      if (present[i]) places.push({ name: `${letter}:`, path: `${letter}:\\` });
    });
  } else {
    places.push({ name: "Computer", path: "/" });
  }
  return places;
}

// Looked up at most once a minute: the folder browser asks every time it opens.
let placesCache: { at: number; places: Promise<FolderEntry[]> } | undefined;

/** Quick links: Music, Downloads, Desktop, Documents, your home folder, and each drive on Windows. */
export function placesToSave(): Promise<FolderEntry[]> {
  if (!placesCache || Date.now() - placesCache.at > 60_000) {
    placesCache = { at: Date.now(), places: findQuickLinks() };
  }
  return placesCache.places;
}

/** Where the folder browser opens when nothing's been chosen yet: Music, else home. */
export async function defaultFolder(): Promise<string> {
  const places = await placesToSave();
  return (places.find((p) => p.name === "Music") ?? places.find((p) => p.name === "Home"))!.path;
}

// --- Folders --------------------------------------------------------------------

/** Turns what was typed or sent into a clean absolute path; rejects relative paths. */
export function normalizeFolder(input: string): string {
  const text = input.trim().replace(/^"(.*)"$/, "$1"); // a path pasted from Explorer's "Copy as path"
  if (!text || !path.isAbsolute(text)) {
    throw new FolderError(
      400,
      process.platform === "win32"
        ? "Enter a full folder path, like C:\\Users\\you\\Music."
        : "Enter a full folder path, like /home/you/Music.",
    );
  }
  const resolved = path.resolve(text);
  // "C:" alone means "the current folder on drive C" to Windows; make it the drive's root.
  return /^[A-Za-z]:$/.test(resolved) ? `${resolved}\\` : resolved;
}

/** The folders inside `dir` (hidden and system ones left out), A to Z. */
export async function listFolders(
  dir: string,
): Promise<{ path: string; parent: string | null; folders: FolderEntry[] }> {
  const folder = normalizeFolder(dir);
  let entries;
  try {
    entries = await fs.readdir(folder, { withFileTypes: true });
  } catch (err) {
    throw folderError(err, folder, "open");
  }
  const folders = entries
    .filter((e) => e.isDirectory() && !isHiddenFolder(e.name))
    .map((e) => ({ name: e.name, path: path.join(folder, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }))
    .slice(0, MAX_ENTRIES);
  const parent = path.dirname(folder);
  return { path: folder, parent: parent === folder ? null : parent, folders };
}

/** Makes a new folder inside `parent` (its name cleaned up like a file name) and returns it. */
export async function createFolder(parent: string, name: string): Promise<FolderEntry> {
  const base = normalizeFolder(parent);
  const clean = safeFileName(name, "");
  if (!clean) throw new FolderError(400, "Give the new folder a name.");
  const dir = path.join(base, clean);
  try {
    await fs.mkdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new FolderError(409, `There's already something called “${clean}” here.`);
    }
    throw folderError(err, base, "write");
  }
  return { name: clean, path: dir };
}

/**
 * Throws unless `dir` is an existing folder the app can write into, and returns
 * its clean path. With `tryWriting`, it makes (and removes) a small file there
 * to be sure: on Windows the permission check alone misses folders that only
 * an administrator may change, like C:\ or Program Files.
 */
export async function assertWritableFolder(
  dir: string,
  { tryWriting = false } = {},
): Promise<string> {
  const folder = normalizeFolder(dir);
  try {
    const stat = await fs.stat(folder);
    if (!stat.isDirectory()) throw new FolderError(400, `“${folder}” isn't a folder.`);
    await fs.access(folder, constants.W_OK);
    if (tryWriting) {
      const probe = path.join(folder, `.yt-audio-write-test-${process.pid}-${Date.now()}`);
      await (await fs.open(probe, "wx")).close();
      await fs.rm(probe, { force: true });
    }
  } catch (err) {
    if (err instanceof FolderError) throw err;
    throw folderError(err, folder, "write");
  }
  return folder;
}

// --- Files ----------------------------------------------------------------------

/** "Song.mp3", 2 → "Song (2).mp3" — the way browsers name a second copy. */
export function numberedName(fileName: string, n: number): string {
  if (n === 0) return fileName;
  const ext = path.extname(fileName);
  return `${fileName.slice(0, fileName.length - ext.length)} (${n})${ext}`;
}

/**
 * Did opening `candidate` with "wx" fail because something already has that
 * name? EEXIST says so — but for a folder of that name Windows may answer
 * "access denied" instead, so then look.
 */
async function nameTaken(err: unknown, candidate: string): Promise<boolean> {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "EEXIST") return true;
  if (code !== "EPERM" && code !== "EACCES" && code !== "EISDIR") return false;
  return fs.lstat(candidate).then(
    () => true,
    () => false,
  );
}

/**
 * Opens a new, empty file — `name`, or `name (1)`, `name (2)`… if that's
 * taken (by a file or a folder). The system itself refuses to open an
 * existing name this way ("wx"), so two saves at once can never get the same
 * file, and neither waits for the other.
 */
async function openNewFile(
  folder: string,
  fileName: string,
): Promise<{ path: string; handle: FileHandle }> {
  for (let n = 0; n < 1000; n++) {
    const candidate = path.join(folder, numberedName(fileName, n));
    try {
      return { path: candidate, handle: await fs.open(candidate, "wx") };
    } catch (err) {
      if (!(await nameTaken(err, candidate))) throw folderError(err, folder, "write");
    }
  }
  throw new FolderError(409, `Too many files named “${fileName}” in that folder.`);
}

/** Creates a new, empty file for writing — `name`, or `name (1)`… if that's taken. */
export async function createNewFile(
  folder: string,
  fileName: string,
): Promise<{ path: string; stream: WriteStream }> {
  const { path: file, handle } = await openNewFile(folder, fileName);
  return { path: file, stream: handle.createWriteStream() };
}

/**
 * Claims the name a finished file is to have: makes it, empty — `name`, or
 * `name (1)`… if that's taken — and returns its path, for the finished file
 * to be renamed over. Saves finishing at the same moment each claim a
 * different name, without a lock: the system decides ("wx").
 */
export async function claimNewName(folder: string, fileName: string): Promise<string> {
  const { path: file, handle } = await openNewFile(folder, fileName);
  await handle.close();
  return file;
}

/** A file-system error as a message for the page, with a fitting HTTP status. */
export function folderError(err: unknown, folder: string, doing: "open" | "write"): FolderError {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return new FolderError(404, `The folder “${folder}” doesn't exist.`);
  if (code === "ENOTDIR") return new FolderError(400, `“${folder}” isn't a folder.`);
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
    return new FolderError(
      403,
      doing === "open"
        ? `The app isn't allowed to open “${folder}”.`
        : `The app isn't allowed to save into “${folder}”. Pick another folder.`,
    );
  }
  if (code === "ENOSPC") return new FolderError(507, `The drive with “${folder}” is full.`);
  return new FolderError(500, err instanceof Error ? err.message : `Couldn't open “${folder}”.`);
}
