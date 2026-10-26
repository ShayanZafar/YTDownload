import { promises as fs } from "fs";
import path from "path";
import { z } from "zod";
import { qualityBarSchema } from "@shared/schema";
import { retryWhenBusy } from "./retry-when-busy";

/**
 * App settings that live on the server, so every browser on this computer
 * shares them: the "Save to" folder, and Housekeeping's quality bar. Kept as a small JSON file
 * next to the history (data/settings.json, or wherever SETTINGS_FILE points).
 */
export const settingsSchema = z.object({
  /** Absolute path of the folder downloads are saved into, or null for the browser's downloads. */
  saveFolder: z.string().nullable().default(null),
  /** Housekeeping lists songs below this as low quality (the owner's choice: 128 kbps). */
  qualityBar: qualityBarSchema.catch("128").default("128"),
});

export type Settings = z.infer<typeof settingsSchema>;

const DEFAULT_SETTINGS: Settings = { saveFolder: null, qualityBar: "128" };

export function settingsFilePath(): string {
  return path.resolve(
    process.env.SETTINGS_FILE || path.join(process.cwd(), "data", "settings.json"),
  );
}

export class SettingsStore {
  // Each write waits for the previous one to finish.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: () => string = settingsFilePath) {}

  async get(): Promise<Settings> {
    let text: string;
    try {
      text = await fs.readFile(this.file(), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_SETTINGS };
      throw err;
    }
    // A damaged file just means default settings — never a broken app.
    const parsed = settingsSchema.safeParse(safeJson(text));
    return parsed.success ? parsed.data : { ...DEFAULT_SETTINGS };
  }

  update(patch: Partial<Settings>): Promise<Settings> {
    const run = async () => {
      const next = { ...(await this.get()), ...patch };
      const file = this.file();
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
      await retryWhenBusy(() => fs.rename(tmp, file));
      return next;
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export const settings = new SettingsStore();
