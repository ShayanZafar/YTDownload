import { promises as fs } from "fs";
import path from "path";
import { z } from "zod";
import { downloadSchema, type Download, type InsertDownload } from "@shared/schema";
import { oneAtATime, writeJsonFile } from "./json-file";

/**
 * Download history, kept as a small JSON file (newest first):
 * data/history.json in the project folder, or wherever HISTORY_FILE points.
 *
 * It's only a convenience list, so it stays deliberately simple: the newest
 * MAX_HISTORY entries are kept (plenty to search back through, and still only
 * a couple of hundred KB), writes go through a temp file + rename so a crash
 * can't leave half a file behind, and writes are queued one at a time so two
 * downloads finishing together can't overwrite each other's entry.
 */
export const MAX_HISTORY = 1000;

export function historyFilePath(): string {
  return path.resolve(process.env.HISTORY_FILE || path.join(process.cwd(), "data", "history.json"));
}

export interface IStorage {
  getDownloads(): Promise<Download[]>;
  createDownload(download: InsertDownload): Promise<Download>;
  /** Takes an entry out; undefined if there's no such entry. */
  removeDownload(id: number): Promise<Download | undefined>;
  /** Empties the history; answers with what it held. */
  clearDownloads(): Promise<Download[]>;
  /** Puts entries back in date order (Undo); answers with the ones put back. */
  restoreDownloads(entries: Download[]): Promise<Download[]>;
}

const historySchema = z.array(downloadSchema);

async function readHistory(file: string): Promise<Download[]> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return []; // no downloads yet
    throw err;
  }
  try {
    return historySchema.parse(JSON.parse(text));
  } catch {
    // Unreadable (e.g. edited by hand). Keep a copy and start a fresh list
    // rather than breaking the app over a convenience feature.
    const backup = `${file}.broken-${Date.now()}`;
    await fs.copyFile(file, backup).catch(() => {});
    console.warn(`History file ${file} couldn't be read; saved a copy to ${backup}.`);
    return [];
  }
}

export class FileStorage implements IStorage {
  // Each write waits for the previous one to finish.
  private readonly queue = oneAtATime();

  constructor(private readonly file: () => string = historyFilePath) {}

  async getDownloads(): Promise<Download[]> {
    return readHistory(this.file());
  }

  createDownload(insert: InsertDownload): Promise<Download> {
    return this.change((entries) => {
      const entry: Download = {
        id: entries.reduce((max, e) => Math.max(max, e.id), 0) + 1,
        url: insert.url,
        title: insert.title,
        downloadedAt: new Date().toISOString(),
        ...(insert.spotifyId ? { spotifyId: insert.spotifyId } : {}),
        // YouTube is the default, so only another source is written down.
        ...(insert.source && insert.source !== "youtube" ? { source: insert.source } : {}),
        ...(insert.fileName ? { fileName: insert.fileName } : {}),
      };
      return { entries: [entry, ...entries], result: entry };
    });
  }

  removeDownload(id: number): Promise<Download | undefined> {
    return this.change((entries) => {
      const entry = entries.find((e) => e.id === id);
      return { entries: entry ? entries.filter((e) => e !== entry) : undefined, result: entry };
    });
  }

  clearDownloads(): Promise<Download[]> {
    return this.change((entries) => ({
      entries: entries.length > 0 ? [] : undefined,
      result: entries,
    }));
  }

  restoreDownloads(restored: Download[]): Promise<Download[]> {
    return this.change((entries) => {
      // An entry is the download of that video at that moment (its id can change).
      const same = (a: Download, b: Download) =>
        a.url === b.url && a.downloadedAt === b.downloadedAt;
      const ids = new Set(entries.map((e) => e.id));
      let nextId = Math.max(0, ...entries.map((e) => e.id), ...restored.map((e) => e.id)) + 1;
      const back: Download[] = [];
      for (const entry of restored) {
        // Already there (Undo pressed twice): not added again.
        if (entries.some((e) => same(e, entry)) || back.some((e) => same(e, entry))) continue;
        // Its id was given to a download made since: it gets a new one.
        const id = ids.has(entry.id) ? nextId++ : entry.id;
        ids.add(id);
        back.push({ ...entry, id });
      }
      if (back.length === 0) return { entries: undefined, result: [] };
      const time = (e: Download) => Date.parse(e.downloadedAt) || 0;
      // Newest first, as always (and the newer id first between two from the same moment).
      const merged = [...entries, ...back].sort((a, b) => time(b) - time(a) || b.id - a.id);
      return { entries: merged, result: back };
    });
  }

  /**
   * Reads the history, changes it and writes it back (unless `entries` comes
   * back undefined: nothing to write), one change at a time.
   */
  private change<T>(edit: (entries: Download[]) => { entries: Download[] | undefined; result: T }) {
    return this.queue(async () => {
      const file = this.file();
      const { entries, result } = edit(await readHistory(file));
      if (entries) await writeJsonFile(file, entries.slice(0, MAX_HISTORY));
      return result;
    });
  }
}

export const storage = new FileStorage();
