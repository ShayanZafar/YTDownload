/**
 * The details log: one line for each song Fill in details looks up or
 * writes, and each download the music catalogues are asked about, saying
 * what happened and why — found and what it added, not found (each search
 * and its closest answer), can't be written, or what went wrong. Plain text,
 * newest last, so it can be read in any text editor: `data/details.log`, or
 * wherever DETAILS_LOG_FILE points; `GET /api/details-log` shows the
 * newest lines. Past LOG_MAX_BYTES the file becomes `details.log.1` and a new
 * one starts, so it never grows without end. Writing it never fails anything.
 */
import { promises as fs } from "fs";
import path from "path";
import type { SongDetails, SongLookup } from "@shared/schema";

export const LOG_MAX_BYTES = 1_000_000;

export function detailsLogPath(): string {
  return path.resolve(
    process.env.DETAILS_LOG_FILE || path.join(process.cwd(), "data", "details.log"),
  );
}

/** What happened to one song, for the log. */
export type DetailsLogEntry = {
  /** "look-up", "write" or "download". */
  kind: "look-up" | "write" | "download";
  /** The song: its file in the folder, or a download's title. */
  song: string;
  /** "found", "added", "not found", "complete", "can't be written", "failed"… */
  outcome: string;
  /** What was found or added, why not, or what went wrong. */
  details?: string[];
};

/** One line of the log: "2026-10-26 01:44:12  look-up  Song.mp3  not found: …". */
export function logLine(entry: DetailsLogEntry, at = new Date()): string {
  const when = at.toISOString().replace("T", " ").slice(0, 19);
  const details = entry.details?.length ? `: ${entry.details.join("; ")}` : "";
  return `${when}  ${entry.kind}  ${entry.song}  ${entry.outcome}${details}`.replace(/\r?\n/g, " ");
}

/** The details as the log lists them: "genre Rock", "year 1987", "cover"… */
export function detailWords(details: SongDetails): string[] {
  return Object.entries(details).map(([field, value]) =>
    field === "coverUrl" ? "cover" : `${field} ${String(value)}`,
  );
}

/** A Fill in details look-up's line: what the song lacks, and what was found or why not. */
export function lookupEntry(song: string, lookup: SongLookup): DetailsLogEntry {
  const kind = "look-up";
  if (lookup.problem) return { kind, song, outcome: "can't be written", details: [lookup.problem] };
  if (lookup.missing.length === 0) return { kind, song, outcome: "has every detail already" };
  if (!lookup.writable) return { kind, song, outcome: "this kind of file can't hold tags" };
  const lacks = `lacks ${lookup.missing.join(", ")}`;
  if (!lookup.found) return { kind, song, outcome: "not found", details: [lacks, ...lookup.notes] };
  const source = lookup.source === "deezer" ? "Deezer" : "iTunes";
  const matched =
    lookup.source === "name"
      ? "no catalogue has it: from its file name"
      : lookup.match
        ? `matched “${lookup.match.title}” by ${lookup.match.artist} on ${source}`
        : `on ${source}`;
  return { kind, song, outcome: "found", details: [lacks, matched, ...detailWords(lookup.found)] };
}

/** A download's line: what the catalogues added to its tags, or why nothing. */
export function downloadEntry(
  song: string,
  found: { tags: Record<string, unknown>; cover?: Buffer; why?: string },
): DetailsLogEntry {
  const words = [
    ...Object.entries(found.tags).map(([field, value]) => `${field} ${String(value)}`),
    ...(found.cover ? ["cover"] : []),
  ];
  if (words.length > 0) return { kind: "download", song, outcome: "added", details: words };
  return {
    kind: "download",
    song,
    outcome: "nothing added",
    details: [found.why ?? "the catalogues had nothing it lacks"],
  };
}

// Lines are written one after another, never two at once.
let writing: Promise<void> = Promise.resolve();

/** Adds the entry to the log, after any being written. Never fails. */
export function logDetails(entry: DetailsLogEntry): Promise<void> {
  const line = `${logLine(entry)}\n`;
  writing = writing.then(async () => {
    const file = detailsLogPath();
    try {
      const size = await fs.stat(file).then(
        (stat) => stat.size,
        () => 0,
      );
      if (size > LOG_MAX_BYTES) await fs.rename(file, `${file}.1`);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.appendFile(file, line, "utf8");
    } catch (err) {
      console.error("Couldn't write the details log:", err);
    }
  });
  return writing;
}

/** The log's newest `lines` lines (none if there's no log yet). */
export async function readDetailsLog(lines = 500): Promise<string> {
  await writing;
  const text = await fs.readFile(detailsLogPath(), "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).slice(-lines).join("\n");
}
