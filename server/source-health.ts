/**
 * How the outside sources the app depends on have been answering: every
 * attempt against YouTube and SoundCloud (through yt-dlp) and Spotify (its
 * embed pages, oEmbed endpoint and Web API) is recorded here, and the last 24 hours are summed up in
 * `data/source-health.json` (or wherever SOURCE_HEALTH_FILE points) and at
 * `GET /api/health/sources`, so that
 * someone — or a tool watching the app — can tell "YouTube is limiting this
 * computer" from "the app is broken" without reading logs.
 *
 * The events stay in memory (the newest MAX_EVENTS of the last 24 hours); the
 * file is a report written from them, debounced to one write per few seconds
 * and through a temp file + rename, like the history (storage.ts).
 */
import { promises as fs } from "fs";
import path from "path";
import type { SourceHealth, SourceHealthReport } from "@shared/schema";
import { retryWhenBusy } from "./retry-when-busy";

/**
 * The sources, what each is for (the job), and whether it's the one asked
 * first or a stand-in for when that one fails. docs/sources.md is the
 * register: it says why these, and what was considered instead.
 */
export const SOURCES = {
  youtube: { role: "primary", for: "audio", name: "YouTube" },
  soundcloud: { role: "fallback", for: "audio", name: "SoundCloud" },
  spotify: { role: "primary", for: "song details", name: "Spotify" },
  "spotify-oembed": { role: "fallback", for: "song details", name: "Spotify oEmbed" },
  // Nothing stands in for it: songs past a playlist's first 100 wait for it.
  "spotify-web-api": { role: "primary", for: "playlist songs past 100", name: "Spotify Web API" },
  // Signed in with Spotify (spotify-sign-in.ts): your own playlists, whole.
  "spotify-account": { role: "primary", for: "your own playlists", name: "Spotify (signed in)" },
} as const satisfies Record<string, { role: "primary" | "fallback"; for: string; name: string }>;

export type SourceName = keyof typeof SOURCES;

/** Why an attempt failed: the source asked us to slow down, refused us, or anything else. */
export type FailureKind = "throttled" | "blocked" | "error";

export type HealthEvent = {
  /** When (ms since the epoch). */
  t: number;
  source: SourceName;
  ok: boolean;
  kind?: FailureKind;
  /** What went wrong, in a few words (never a path or a secret). */
  note?: string;
  /** For a refusal: until when the source said to wait (its Retry-After, ms since the epoch). */
  until?: number;
};

/** How far back the report looks. */
export const WINDOW_MS = 24 * 60 * 60_000;
/** The most events kept in memory. */
export const MAX_EVENTS = 500;
/** A source needs this many attempts in the window before it can be called unreliable… */
export const MIN_ATTEMPTS = 5;
/** …and fewer than this share of them must have worked. */
export const UNRELIABLE_BELOW = 0.5;
/**
 * A source that has told the app to wait longer than this (a 429's
 * Retry-After) is unreliable however few the attempts: while refused, the
 * app asks it about once a refusal, so it never reaches MIN_ATTEMPTS.
 */
export const REFUSED_FOR_MS = 60 * 60_000;
/** The file is rewritten at most this often. */
export const WRITE_EVERY_MS = 5_000;
/** The longest a timer can wait. */
const MAX_TIMER_MS = 2 ** 31 - 1;
const NOTE_MAX_CHARS = 200;

export function sourceHealthFilePath(): string {
  return path.resolve(
    process.env.SOURCE_HEALTH_FILE || path.join(process.cwd(), "data", "source-health.json"),
  );
}

/**
 * A failure's note, fit for the report: one line, cut short, and any file
 * path in it reduced to the file's name ("spawn C:\apps\yt-dlp.exe ENOENT" →
 * "spawn yt-dlp.exe ENOENT") — the report may be read far from this computer.
 */
export function cleanNote(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  // A Windows path (C:\…), a UNC path (\\…) or an absolute Unix path (/…) —
  // not the "//" of a URL, and not a "/" inside a word.
  const withoutPaths = oneLine.replace(
    /(?<![:\w/])(?:[A-Za-z]:\\|\\\\|\/)[^\s"'`]*/g,
    (found) => found.split(/[\\/]/).filter(Boolean).pop() ?? "",
  );
  return withoutPaths.length > NOTE_MAX_CHARS
    ? `${withoutPaths.slice(0, NOTE_MAX_CHARS - 1)}…`
    : withoutPaths;
}

/** The events of the last 24 hours, newest last, at most MAX_EVENTS of them. */
export function pruneEvents(events: HealthEvent[], now: number): HealthEvent[] {
  const since = now - WINDOW_MS;
  return events.filter((event) => event.t > since).slice(-MAX_EVENTS);
}

/**
 * Is a source failing more often than not (only once there's enough to go
 * on), or refusing the app for more than another hour?
 */
export function isUnreliable(
  health: Pick<SourceHealth, "ok" | "failed"> & Partial<Pick<SourceHealth, "refusedUntil">>,
  now = Date.now(),
): boolean {
  const refusedUntil = health.refusedUntil ? Date.parse(health.refusedUntil) : NaN;
  if (refusedUntil - now > REFUSED_FOR_MS) return true;
  const attempts = health.ok + health.failed;
  return attempts >= MIN_ATTEMPTS && health.ok / attempts < UNRELIABLE_BELOW;
}

function summarizeSource(source: SourceName, events: HealthEvent[], now: number): SourceHealth {
  const own = events.filter((event) => event.source === source);
  const lastOk = own.filter((event) => event.ok).at(-1);
  const lastFailed = own.filter((event) => !event.ok).at(-1);
  // Still refused: the last answer said to wait, and the time hasn't come.
  const last = own.at(-1);
  const refusedUntil = last && !last.ok && last.until && last.until > now ? last.until : undefined;
  return {
    role: SOURCES[source].role,
    for: SOURCES[source].for,
    ok: own.filter((event) => event.ok).length,
    failed: own.filter((event) => !event.ok).length,
    throttled: own.filter((event) => !event.ok && event.kind === "throttled").length,
    lastOk: lastOk ? new Date(lastOk.t).toISOString() : null,
    lastError: lastFailed ? lastFailed.note || lastFailed.kind || "failed" : null,
    refusedUntil: refusedUntil ? new Date(refusedUntil).toISOString() : null,
  };
}

const sourceNames = () => Object.keys(SOURCES) as SourceName[];

/**
 * Can't the app do some job any more? That's when the job's primary source is
 * unreliable and so is every fallback for it — or it has no fallback at all.
 */
export function anyJobUnreliable(
  sources: Record<SourceName, SourceHealth>,
  now = Date.now(),
): boolean {
  return sourceNames().some((primary) => {
    if (SOURCES[primary].role !== "primary" || !isUnreliable(sources[primary], now)) return false;
    const fallbacks = sourceNames().filter(
      (name) => SOURCES[name].role === "fallback" && SOURCES[name].for === SOURCES[primary].for,
    );
    return fallbacks.every((name) => isUnreliable(sources[name], now));
  });
}

/**
 * One sentence a person can read: the unreliable sources, with their counts,
 * last error and until when one refuses the app — "YouTube: 2 of 20 requests
 * succeeded in the last 24 h (last error: HTTP Error 429)." — or "All
 * sources healthy."
 */
export function summarySentence(
  sources: Record<SourceName, SourceHealth>,
  now = Date.now(),
): string {
  const parts = sourceNames()
    .filter((name) => isUnreliable(sources[name], now))
    .map((name) => {
      const { ok, failed, lastError, refusedUntil } = sources[name];
      const notes = [
        lastError && `last error: ${lastError}`,
        refusedUntil && `refused until ${refusedUntil}`,
      ].filter(Boolean);
      const error = notes.length > 0 ? ` (${notes.join("; ")})` : "";
      return `${SOURCES[name].name}: ${ok} of ${ok + failed} requests succeeded in the last 24 h${error}`;
    });
  return parts.length > 0 ? `${parts.join("; ")}.` : "All sources healthy.";
}

/** The report, from the events — the pure heart of this module. */
export function buildReport(events: HealthEvent[], now: number): SourceHealthReport {
  const recent = pruneEvents(events, now);
  const sources = Object.fromEntries(
    (Object.keys(SOURCES) as SourceName[]).map((name) => [
      name,
      summarizeSource(name, recent, now),
    ]),
  ) as Record<SourceName, SourceHealth>;
  return {
    updatedAt: new Date(now).toISOString(),
    unreliable: anyJobUnreliable(sources, now),
    summary: summarySentence(sources, now),
    sources,
  };
}

export type SourceHealthOptions = {
  /** Where the report is written; by default `sourceHealthFilePath()` (read at each write). */
  file?: () => string;
  now?: () => number;
  writeEveryMs?: number;
};

/** Records attempts and keeps the report file up to date (one write per few seconds at most). */
export class SourceHealthStore {
  private events: HealthEvent[] = [];
  private readonly file: () => string;
  private readonly now: () => number;
  private readonly writeEveryMs: number;
  private timer: NodeJS.Timeout | undefined;
  private lastWriteAt = -Infinity;
  // Each write waits for the previous one to finish.
  private queue: Promise<unknown> = Promise.resolve();

  constructor({
    file = sourceHealthFilePath,
    now = Date.now,
    writeEveryMs = WRITE_EVERY_MS,
  }: SourceHealthOptions = {}) {
    this.file = file;
    this.now = now;
    this.writeEveryMs = writeEveryMs;
  }

  /**
   * An attempt against a source: how it went, and for a failure, why — and
   * for a refusal, until when the source said to wait.
   */
  record(
    source: SourceName,
    ok: boolean,
    failure: { kind?: FailureKind; note?: string; until?: number } = {},
  ) {
    const event: HealthEvent = { t: this.now(), source, ok };
    if (!ok) {
      event.kind = failure.kind ?? "error";
      if (failure.note) event.note = cleanNote(failure.note);
      if (failure.until) event.until = failure.until;
    }
    this.events = pruneEvents([...this.events, event], event.t);
    this.scheduleWrite();
    if (event.until) this.rewriteAsRefusalRunsOut(event.until);
  }

  /**
   * While refused, the app asks nothing, so only the clock changes the report
   * of a refusal long enough to count as unreliable: when it stops counting
   * (its last hour) and when it ends. The file is rewritten then too.
   */
  private rewriteAsRefusalRunsOut(until: number) {
    if (until - this.now() <= REFUSED_FOR_MS) return;
    for (const at of [until - REFUSED_FOR_MS, until]) {
      const wait = at - this.now() + 1;
      if (wait > 0 && wait <= MAX_TIMER_MS) {
        setTimeout(() => this.scheduleWrite(), wait).unref();
      }
    }
  }

  report(now = this.now()): SourceHealthReport {
    return buildReport(this.events, now);
  }

  /** Writes the report now (a pending write is folded into it), and settles once it's on disk. */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.lastWriteAt = this.now();
    const run = () => writeReport(this.file(), this.report());
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  private scheduleWrite() {
    if (this.timer) return; // one is on its way
    const wait = Math.max(0, this.lastWriteAt + this.writeEveryMs - this.now());
    // The timer must never keep the app from exiting.
    this.timer = setTimeout(() => {
      this.flush().catch((err) => console.error("Couldn't write the source-health file:", err));
    }, wait).unref();
  }
}

async function writeReport(file: string, report: SourceHealthReport): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(report, null, 2) + "\n", "utf8");
  await retryWhenBusy(() => fs.rename(tmp, file));
}

export const sourceHealth = new SourceHealthStore();
