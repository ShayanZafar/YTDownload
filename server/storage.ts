import { promises as fs } from "fs";
import path from "path";
import { z } from "zod";
import { downloadSchema, type Download, type InsertDownload } from "@shared/schema";
import { retryWhenBusy } from "./retry-when-busy";

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

async function writeHistory(file: string, entries: Download[]): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(entries, null, 2) + "\n", "utf8");
  await retryWhenBusy(() => fs.rename(tmp, file));
}

export class FileStorage implements IStorage {
  // Each write waits for the previous one to finish.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: () => string = historyFilePath) {}

  async getDownloads(): Promise<Download[]> {
    return readHistory(this.file());
  }

  createDownload(insert: InsertDownload): Promise<Download> {
    const run = async () => {
      const file = this.file();
      const entries = await readHistory(file);
      const entry: Download = {
        id: entries.reduce((max, e) => Math.max(max, e.id), 0) + 1,
        url: insert.url,
        title: insert.title,
        downloadedAt: new Date().toISOString(),
      };
      await writeHistory(file, [entry, ...entries].slice(0, MAX_HISTORY));
      return entry;
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }
}

export const storage = new FileStorage();
