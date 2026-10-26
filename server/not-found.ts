import { promises as fs } from "fs";
import path from "path";
import { retryWhenBusy } from "./retry-when-busy";

/**
 * Fill in details' "Not found": the folder songs no music catalogue has —
 * every one of them answered and none had the song (a catalogue that was busy
 * or out of reach doesn't count). Your music can show just these, and Fill in
 * details leaves them out unless they're what's shown. Kept by each song's
 * place in the folder and its size, so a song that's changed (new tags, a new
 * name) is no longer marked, in data/details-not-found.json (or wherever
 * DETAILS_NOT_FOUND_FILE points).
 */

export function notFoundFilePath(): string {
  return path.resolve(
    process.env.DETAILS_NOT_FOUND_FILE ||
      path.join(process.cwd(), "data", "details-not-found.json"),
  );
}

type Song = { relative: string; size: number };

// The marked songs: place in the folder → size. Read from the file once.
let marked: Map<string, number> | undefined;
let loading: Promise<Map<string, number>> | undefined;
// Each write waits for the previous one to finish.
let writing: Promise<unknown> = Promise.resolve();

/** Reads the marks from the file, once (a missing or damaged file: none). */
export function loadNotFound(): Promise<Map<string, number>> {
  if (marked) return Promise.resolve(marked);
  loading ??= fs
    .readFile(notFoundFilePath(), "utf8")
    .then((text) => {
      const parsed: unknown = JSON.parse(text);
      return new Map(
        Object.entries(parsed && typeof parsed === "object" ? parsed : {}).filter(
          (entry): entry is [string, number] => typeof entry[1] === "number",
        ),
      );
    })
    .catch(() => new Map<string, number>())
    .then((read) => (marked = read));
  return loading;
}

/** Is this song marked Not found (and unchanged since)? False until the marks are loaded. */
export const isNotFound = (song: Song) => marked?.get(song.relative) === song.size;

/** Marks a song Not found, or (`notFound` false) takes the mark off. */
export async function setNotFound(song: Song, notFound: boolean): Promise<void> {
  const marks = await loadNotFound();
  if (notFound ? marks.get(song.relative) === song.size : !marks.has(song.relative)) return;
  if (notFound) marks.set(song.relative, song.size);
  else marks.delete(song.relative);
  const save = async () => {
    const file = notFoundFilePath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(Object.fromEntries(marks), null, 2) + "\n", "utf8");
    await retryWhenBusy(() => fs.rename(tmp, file));
  };
  const result = writing.then(save, save);
  writing = result.catch((err) => console.error("Couldn't save the Not found songs", err));
  await writing;
}

/** Forgets the marks read (for tests, after pointing DETAILS_NOT_FOUND_FILE elsewhere). */
export function resetNotFound() {
  marked = undefined;
  loading = undefined;
}
