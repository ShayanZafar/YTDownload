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

/**
 * Writes `data` over `file` in place, so it keeps its creation date, then puts
 * its times back (Fill in details, Rename's new title or artist).
 */
export async function writeOver(
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
