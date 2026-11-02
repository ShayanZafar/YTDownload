/**
 * Changing a song's file in the Save to folder, for every feature that does:
 * Fill in details and Rename (tags written into it, its name changed), Trim
 * and its Undo, and Housekeeping's better copies. One change to a song at a
 * time (`whileBusy()`), and the ways a finished new version takes the song's
 * place — never half a song.
 */
import { promises as fs } from "fs";
import path from "path";
import { FolderError } from "./folders";
import { retryWhenBusy } from "./retry-when-busy";
import { binName, moveToTrash } from "./trash";

export const SONG_BUSY = "That song is being changed already.";

// Songs being changed now, by their full path, so two changes can't overlap.
const busy = new Set<string>();

/** Runs `work` on a song no other change is making now; a 409 if one is. */
export async function whileBusy<T>(file: string, work: () => Promise<T>): Promise<T> {
  if (busy.has(file)) throw new FolderError(409, SONG_BUSY);
  busy.add(file);
  try {
    return await work();
  } finally {
    busy.delete(file);
  }
}

/**
 * Puts `part` in `target`'s place (Trim, its Undo). If Windows won't let the
 * file be replaced (the player or another program still has it open), it's
 * written over instead: the app opens files so that others may write to them.
 */
export async function swapIn(part: string, target: string): Promise<void> {
  try {
    await retryWhenBusy(() => fs.rename(part, target));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") throw err;
    await fs.copyFile(part, target);
  }
}

/** Where a song's original waits while it's written over: data/unfinished-tag-writes, unless TAG_WRITE_BACKUP_DIR says. */
export function tagWriteBackupDir(): string {
  return path.resolve(
    process.env.TAG_WRITE_BACKUP_DIR || path.join(process.cwd(), "data", "unfinished-tag-writes"),
  );
}

/** What a backup's info.json says: the song it's the original of, and its dates. */
type BackupInfo = { song: string; atimeMs: number; mtimeMs: number };

/** Writes `data` into `file` itself (same file, same creation date) and puts its times back. */
async function writeInPlace(
  file: string,
  data: Buffer,
  times: { atimeMs: number; mtimeMs: number },
): Promise<void> {
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
 * Writes `data` over `file` in place, so it keeps its creation date, then puts
 * its times back (Fill in details, Rename's new title or artist). Writing in
 * place can't be undone half-way by a rename, so the original is copied into
 * the backup folder first (`tagWriteBackupDir()`) and deleted once the new
 * one is complete. If the write fails, the original is put back at once; if
 * the app stops part-way (closed, crashed, power cut), the next start puts it
 * back (`restoreUnfinishedTagWrites()`).
 */
export async function writeOver(
  file: string,
  data: Buffer,
  times: { atimeMs: number; mtimeMs: number },
  backupRoot = tagWriteBackupDir(),
): Promise<void> {
  await fs.mkdir(backupRoot, { recursive: true });
  const backup = await fs.mkdtemp(path.join(backupRoot, "song-"));
  const original = path.join(backup, "original");
  try {
    await retryWhenBusy(() => fs.copyFile(file, original));
    const info: BackupInfo = { song: file, atimeMs: times.atimeMs, mtimeMs: times.mtimeMs };
    await fs.writeFile(path.join(backup, "info.json"), JSON.stringify(info));
  } catch (err) {
    // No backup, no write: the song is left as it was.
    await fs.rm(backup, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  try {
    await writeInPlace(file, data, times);
  } catch (err) {
    // Half written, perhaps: the original goes back. If even that fails, the
    // backup stays for the next start.
    const restored = await fs
      .readFile(original)
      .then((old) => writeInPlace(file, old, times))
      .then(() => true)
      .catch(() => false);
    if (restored) await fs.rm(backup, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  await fs.rm(backup, { recursive: true, force: true }).catch(() => {});
}

/**
 * At the app's start: puts back every song whose tags were being written when
 * the app last stopped (a backup that was never deleted), so none is left
 * half written. Answers with the songs put back. A backup whose song is gone
 * is left where it is, and said in the log.
 */
export async function restoreUnfinishedTagWrites(
  backupRoot = tagWriteBackupDir(),
): Promise<string[]> {
  const names = await fs.readdir(backupRoot).catch((): string[] => []);
  const restored: string[] = [];
  for (const name of names) {
    const backup = path.join(backupRoot, name);
    const infoText = await fs.readFile(path.join(backup, "info.json"), "utf8").catch(() => null);
    if (infoText === null) {
      // The app stopped before the write began: the song is untouched.
      await fs.rm(backup, { recursive: true, force: true }).catch(() => {});
      continue;
    }
    try {
      const info = JSON.parse(infoText) as BackupInfo;
      const original = await fs.readFile(path.join(backup, "original"));
      const there = await fs.stat(info.song).catch(() => undefined);
      if (!there?.isFile()) {
        console.warn(
          `An unfinished tag write's original is kept in ${backup}: its song ${info.song} isn't there any more.`,
        );
        continue;
      }
      await writeInPlace(info.song, original, info);
      await fs.rm(backup, { recursive: true, force: true });
      restored.push(info.song);
      console.warn(`Put back ${info.song}: the app stopped while writing its tags.`);
    } catch (err) {
      console.error(`Couldn't put back the song backed up in ${backup}:`, err);
    }
  }
  return restored;
}

/** The old song is in the bin, but `part` couldn't take its name: it's left for the person. */
export class PartKeptError extends FolderError {
  constructor(part: string, err: unknown) {
    super(
      500,
      `The old song went to the ${binName()}, but its copy couldn't take its name (${(err as Error).message}): it's “${path.basename(part)}” in the same folder.`,
    );
  }
}

/**
 * Sends `target` to the bin, then puts `part` in its place with its dates (a
 * better copy). Rejects with NoBinError (its drive has no bin: nothing
 * changed) or PartKeptError.
 */
export async function binAndSwapIn(part: string, target: string): Promise<void> {
  const times = await fs.stat(target);
  await moveToTrash(target);
  try {
    await retryWhenBusy(() => fs.rename(part, target));
  } catch (err) {
    throw new PartKeptError(part, err);
  }
  await fs.utimes(target, times.atime, times.mtime).catch(() => {});
}
