/**
 * Keeping on YouTube's good side, and coping when we aren't.
 *
 * YouTube limits computers that ask too much — "HTTP Error 429", or "Sign in
 * to confirm you're not a bot" — and yt-dlp stops understanding YouTube's
 * pages every few weeks until it's updated. So every yt-dlp call that isn't
 * an audio stream (search, video info, playlists, the metadata pass before a
 * download) goes through `youtubeGuard`:
 *
 *   - a cache answers repeats of the same search, video or playlist for a
 *     while, without asking YouTube again;
 *   - a cooldown: once YouTube has limited us, the app stops asking it for
 *     10 minutes and answers `429` with how long to wait (`YouTubeLimited`),
 *     so retries don't dig the hole deeper;
 *   - a gate lets only a couple of yt-dlp calls run at once (the rest wait
 *     their turn) — bursts are what YouTube's checks look for;
 *   - when a failure looks like an outdated yt-dlp (or a bot check, which an
 *     old yt-dlp often earns), the app updates yt-dlp itself (yt-dlp-update.ts:
 *     once an hour at most) and tries the call once more, if someone's still
 *     waiting for the answer;
 *   - every attempt is recorded for the source-health report (source-health.ts).
 *
 * The pieces are plain classes that take the time as an argument, so they're
 * unit-tested with a fake clock; `youtubeGuard` wires them to the real one.
 */
import type { Response } from "express";
import type { RateLimitedError } from "@shared/routes";
import { ytDlpFailure } from "./audio";
import { sourceHealth, type FailureKind, type SourceHealthStore } from "./source-health";
import { YtDlpUpdater } from "./yt-dlp-update";

/** What a yt-dlp failure means for us. */
export type YtDlpErrorKind =
  /** YouTube says to slow down (HTTP 429). */
  | "throttled"
  /** YouTube wants a sign-in to prove we're not a bot: it's limiting this computer. */
  | "bot-check"
  /** yt-dlp couldn't read YouTube's page: it's probably outdated. */
  | "broken"
  /** The video itself can't be had (private, removed, age-restricted): nothing to retry. */
  | "unavailable"
  | "other";

const THROTTLED_RE = /HTTP Error 429|Too Many Requests/i;
// Straight or curly apostrophe in "you're".
const BOT_CHECK_RE = /Sign in to confirm you['’]re not a bot|confirm you['’]re not a bot/i;
// The signs of a yt-dlp that no longer understands YouTube's pages.
const BROKEN_RE = /Requested format is not available|Unable to extract|\bnsig\b|signature/i;
const UNAVAILABLE_RE =
  /Video unavailable|Private video|This video is not available|content isn['’]?t available|members-only|age[- ]restricted|confirm your age|playlist does not exist|playlist is private/i;

/** Reads a yt-dlp error line (or its whole stderr) for what went wrong. */
export function classifyYtDlpError(text: string): YtDlpErrorKind {
  if (THROTTLED_RE.test(text)) return "throttled";
  if (BOT_CHECK_RE.test(text)) return "bot-check";
  if (UNAVAILABLE_RE.test(text)) return "unavailable";
  if (BROKEN_RE.test(text)) return "broken";
  return "other";
}

/** YouTube is limiting this computer: the kinds that start the cooldown. */
export const isLimiting = (kind: YtDlpErrorKind) => kind === "throttled" || kind === "bot-check";

/** The kinds an outdated yt-dlp earns: worth updating it over, and trying once more. */
export const callsForUpdate = (kind: YtDlpErrorKind) => kind === "broken" || kind === "bot-check";

/** How long the app leaves YouTube alone after it limited us. */
export const COOLDOWN_MS = 10 * 60_000;

/** A period during which YouTube isn't asked anything. Times are ms since the epoch. */
export class Cooldown {
  private until = 0;

  /** Starts (or extends) the cooldown: `ms` from `now`. */
  start(now: number, ms = COOLDOWN_MS): void {
    this.until = Math.max(this.until, now + ms);
  }

  remainingMs(now: number): number {
    return Math.max(0, this.until - now);
  }

  clear(): void {
    this.until = 0;
  }
}

/** The message sent with a 429, and shown on the page. */
export const LIMITED_MESSAGE =
  "YouTube is limiting this computer. Wait about 10 minutes, then try again. If it keeps happening, update yt-dlp (Update, or npm run update-yt-dlp).";

/** YouTube is limiting this computer: the request wasn't (or couldn't be) made. */
export class YouTubeLimited extends Error {
  readonly status = 429;
  constructor(
    readonly retryAfterSeconds: number,
    options?: ErrorOptions,
  ) {
    super(LIMITED_MESSAGE, options);
  }
}

/** The JSON a 429 carries. */
export function limitedBody(limited: YouTubeLimited): RateLimitedError {
  return {
    message: limited.message,
    retryAfterSeconds: limited.retryAfterSeconds,
    source: "youtube",
  };
}

/** Answers a request with the 429 (JSON, plus a Retry-After header). */
export function sendLimited(res: Response, limited: YouTubeLimited) {
  return res
    .set("Retry-After", String(limited.retryAfterSeconds))
    .status(limited.status)
    .json(limitedBody(limited));
}

/** How many yt-dlp calls (other than audio streams) may run at once. */
export const MAX_CONCURRENT = 2;

export type Gate = {
  /** Runs `task` once a slot is free (callers wait in order; nobody is turned away). */
  <T>(task: () => Promise<T>): Promise<T>;
  /** How many tasks are running, and how many are waiting (for tests and logs). */
  readonly running: number;
  readonly waiting: number;
};

/** A gate that lets at most `max` tasks run at the same time. */
export function limitConcurrent(max = MAX_CONCURRENT): Gate {
  let running = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    running--;
    queue.shift()?.();
  };
  const gate = async <T>(task: () => Promise<T>): Promise<T> => {
    if (running >= max) await new Promise<void>((resolve) => queue.push(resolve));
    running++;
    try {
      return await task();
    } finally {
      next();
    }
  };
  return Object.defineProperties(gate, {
    running: { get: () => running },
    waiting: { get: () => queue.length },
  }) as Gate;
}

/** How long a cached answer stays fresh, and how many are kept. */
export const CACHE_TTL_MS = 10 * 60_000;
export const CACHE_MAX_ENTRIES = 200;

/**
 * Answers kept for a while, keyed by what was asked. Full? The one used
 * longest ago goes (a Map keeps insertion order; a read moves its entry to the end).
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expires: number }>();

  constructor(
    private readonly ttlMs = CACHE_TTL_MS,
    private readonly maxEntries = CACHE_MAX_ENTRIES,
  ) {}

  /** The fresh answer for `key`, or undefined. */
  get(key: string, now: number): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires <= now) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key); // re-insert: now the most recently used
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, now: number): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expires: now + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

/** The cache key of a search: the query, normalised ("  Daft  PUNK " and "daft punk" are one). */
export function searchCacheKey(query: string, targetDuration?: number | null): string {
  const normalized = query.trim().toLowerCase().replace(/\s+/g, " ");
  return targetDuration == null ? `search:${normalized}` : `search:${normalized}|${targetDuration}`;
}

export const videoCacheKey = (videoId: string) => `video:${videoId}`;
export const playlistCacheKey = (playlistId: string) => `playlist:${playlistId}`;

/**
 * After a yt-dlp call failed and yt-dlp was (maybe) updated: is the call
 * worth making again? Only after an update that worked, and only if someone
 * is still waiting for the answer — not for a browser that has gone away.
 */
export function shouldRetry(updated: boolean, stillWanted: () => boolean = () => true): boolean {
  return updated && stillWanted();
}

export type GuardOptions = {
  health?: Pick<SourceHealthStore, "record">;
  now?: () => number;
  cooldown?: Cooldown;
  cache?: TtlCache<unknown>;
  gate?: Gate;
  updater?: YtDlpUpdater;
  /** The error line of a failed call (yt-dlp's own, when there is one). */
  failureText?: (err: unknown) => string;
  log?: (line: string) => void;
};

/** A yt-dlp call to run. */
export type GuardedCall<T> = {
  /** Cached under this key, if given. */
  key?: string;
  attempt: () => Promise<T>;
  /** Is anyone still waiting for the answer? Asked before a retry (after an update). */
  stillWanted?: () => boolean;
};

type Attempt<T> =
  | { failed: false; result: T }
  | { failed: true; error: unknown; text: string; kind: YtDlpErrorKind };

/** The cache, cooldown, gate and self-update around yt-dlp calls (see the top of the file). */
export class YouTubeGuard {
  readonly cooldown: Cooldown;
  readonly cache: TtlCache<unknown>;
  readonly gate: Gate;
  readonly updater: YtDlpUpdater;
  private readonly health: Pick<SourceHealthStore, "record">;
  private readonly now: () => number;
  private readonly failureText: (err: unknown) => string;
  private readonly log: (line: string) => void;

  constructor({
    health = sourceHealth,
    now = Date.now,
    cooldown = new Cooldown(),
    cache = new TtlCache<unknown>(),
    gate = limitConcurrent(),
    updater = new YtDlpUpdater(),
    failureText = ytDlpFailure,
    log = console.warn,
  }: GuardOptions = {}) {
    this.health = health;
    this.now = now;
    this.cooldown = cooldown;
    this.cache = cache;
    this.gate = gate;
    this.updater = updater;
    this.failureText = failureText;
    this.log = log;
  }

  /** The 429 to answer with while the cooldown lasts, or undefined. */
  limited(): YouTubeLimited | undefined {
    const remaining = this.cooldown.remainingMs(this.now());
    return remaining > 0 ? new YouTubeLimited(Math.max(1, Math.ceil(remaining / 1000))) : undefined;
  }

  /**
   * Runs a yt-dlp call: a fresh cached answer first; during a cooldown, a
   * `YouTubeLimited` without running anything; otherwise through the gate,
   * with the self-update and one retry when the failure calls for it. The
   * answer is cached, and every attempt is recorded.
   */
  async run<T>({ key, attempt, stillWanted }: GuardedCall<T>): Promise<T> {
    if (key !== undefined) {
      const cached = this.cache.get(key, this.now()) as T | undefined;
      if (cached !== undefined) return cached;
    }
    const limited = this.limited();
    if (limited) throw limited;
    const result = await this.gate(async () => {
      // The cooldown may have started while this call was waiting its turn.
      const limitedNow = this.limited();
      if (limitedNow) throw limitedNow;
      return this.attemptWithUpdate(attempt, stillWanted);
    });
    if (key !== undefined) this.cache.set(key, result, this.now());
    return result;
  }

  private async attemptWithUpdate<T>(
    attempt: () => Promise<T>,
    stillWanted?: () => boolean,
  ): Promise<T> {
    const first = await this.tryOnce(attempt);
    if (!first.failed) return first.result;
    if (!callsForUpdate(first.kind)) throw this.failureError(first);
    // An outdated yt-dlp earns both of these: update it (once an hour at
    // most), and try once more — the same call, nothing else in between.
    const updated = await this.updater.update(this.now(), first.text);
    if (!shouldRetry(updated, stillWanted)) throw this.failureError(first);
    const again = await this.tryOnce(attempt);
    if (!again.failed) return again.result;
    throw this.failureError(again);
  }

  private async tryOnce<T>(attempt: () => Promise<T>): Promise<Attempt<T>> {
    try {
      const result = await attempt();
      this.health.record("youtube", true);
      return { failed: false, result };
    } catch (error) {
      const text = this.failureText(error);
      const kind = classifyYtDlpError(text);
      this.recordFailure(kind, text);
      return { failed: true, error, text, kind };
    }
  }

  /** What to throw for a failure: the 429 once YouTube is limiting us (the cooldown starts), else the error itself. */
  private failureError(failure: { error: unknown; text: string; kind: YtDlpErrorKind }): unknown {
    if (!isLimiting(failure.kind)) return failure.error;
    const limited = this.startCooldown(failure.text);
    return new YouTubeLimited(limited.retryAfterSeconds, { cause: failure.error });
  }

  /**
   * An audio pipeline (yt-dlp → ffmpeg) has ended: records it; when the
   * failure calls for a newer yt-dlp, updates it for the calls to come; and
   * when YouTube was limiting us, starts the cooldown and gives the 429 to
   * answer with — if the response hasn't started yet (the caller knows).
   */
  pipelineEnded(ok: boolean, reason: string): YouTubeLimited | undefined {
    if (ok) {
      this.health.record("youtube", true);
      return undefined;
    }
    const kind = classifyYtDlpError(reason);
    this.recordFailure(kind, reason);
    if (callsForUpdate(kind)) void this.updater.update(this.now(), reason);
    return isLimiting(kind) ? this.startCooldown(reason) : undefined;
  }

  private startCooldown(reason: string): YouTubeLimited {
    const now = this.now();
    if (this.cooldown.remainingMs(now) === 0) {
      this.log(
        `YouTube is limiting this computer ("${reason}"): not asking it anything for ${Math.round(COOLDOWN_MS / 60_000)} minutes.`,
      );
    }
    this.cooldown.start(now);
    return new YouTubeLimited(Math.max(1, Math.ceil(this.cooldown.remainingMs(now) / 1000)));
  }

  /** Forgets the cooldown, the cache and the last update (tests). */
  reset(): void {
    this.cooldown.clear();
    this.cache.clear();
    this.updater.forget();
  }

  private recordFailure(kind: YtDlpErrorKind, text: string) {
    // A private or removed video is YouTube answering properly, not failing us.
    if (kind === "unavailable") {
      this.health.record("youtube", true);
      return;
    }
    const failureKind: FailureKind =
      kind === "throttled" ? "throttled" : kind === "bot-check" ? "blocked" : "error";
    this.health.record("youtube", false, { kind: failureKind, note: text });
  }
}

/** The guard the app's routes use. */
export const youtubeGuard = new YouTubeGuard();
