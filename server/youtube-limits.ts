/**
 * Coping with YouTube limiting this computer, without ever slowing the app
 * down: nothing here gates, queues, caps or delays a call, and nothing waits
 * on a timer of ours (the owner's rule; see .claude/rules/outside-sources.md).
 *
 * YouTube limits computers that ask too much ("HTTP Error 429", "Sign in to
 * confirm you're not a bot", "This content isn't available, try again
 * later"), and yt-dlp stops understanding YouTube's pages every few weeks
 * until it's updated. Every yt-dlp call to YouTube that isn't an audio stream
 * (search, video info, playlists, the look-up before a download) goes through
 * `youtubeGuard`, and an audio stream reports how it ended:
 *
 *   - every call is made, refused a minute ago or not. A cache answers
 *     repeats of the same search, video or playlist for a while without
 *     asking YouTube again — it only makes answers faster;
 *   - when YouTube refuses (throttled, or a bot check), the request is
 *     answered at once with a 502 that says so (`YouTubeRefused`,
 *     `sendRefused()`), and the guard remembers when (`refusedRecently()`):
 *     for the next 10 minutes a search asks SoundCloud at the same time as
 *     YouTube (search.ts), so a refusal costs no time. Nothing is ever turned
 *     away or held back on that account;
 *   - when a failure looks like an outdated yt-dlp (or a bot check, which an
 *     old yt-dlp earns more often), yt-dlp is updated in the background
 *     (yt-dlp-update.ts: once an hour at most). Nobody waits for it: the
 *     request that failed fails at once, and later ones use the new yt-dlp;
 *   - when YouTube asks for a sign-in ("confirm you're not a bot") and the
 *     owner has turned on "Use my Firefox YouTube sign-in" (settings.ts:
 *     `youtubeSignIn`, off by default), the call is made again at once with
 *     Firefox's YouTube cookies (`--cookies-from-browser firefox`), and for
 *     the next 10 minutes calls and audio streams use them straight away
 *     (`signInNow()`). With the setting off, no call ever carries a sign-in;
 *   - every attempt is recorded for the source-health report (source-health.ts).
 *
 * The pieces take the time as an argument, so they're unit-tested with a fake
 * clock; `youtubeGuard` wires them to the real one.
 */
import type { Response } from "express";
import type { LimitedError } from "@shared/routes";
import { ytDlpFailure, type YtDlpSignIn } from "./audio";
import { settings } from "./settings";
import { sourceHealth, type FailureKind, type SourceHealthStore } from "./source-health";
import { YtDlpUpdater } from "./yt-dlp-update";

/** What a yt-dlp failure means for us. */
export type YtDlpErrorKind =
  /** YouTube says to slow down (HTTP 429, or "try again later": it's rate-limiting us). */
  | "throttled"
  /** YouTube wants a sign-in to prove we're not a bot: it's limiting this computer. */
  | "bot-check"
  /** yt-dlp couldn't read YouTube's page: it's probably outdated. */
  | "broken"
  /** The video itself can't be had (private, removed, age-restricted): nothing to retry. */
  | "unavailable"
  | "other";

// "This content isn't available, try again later" (and yt-dlp's note that the
// session "has been rate-limited") is how YouTube rate-limits a computer now.
const THROTTLED_RE = /HTTP Error 429|Too Many Requests|rate[- ]limited|try again later/i;
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

/** YouTube is refusing this computer: throttled, or a bot check. */
export const isRefusal = (kind: YtDlpErrorKind): kind is "throttled" | "bot-check" =>
  kind === "throttled" || kind === "bot-check";

/** The kinds an outdated yt-dlp earns: worth updating it over, for the calls to come. */
export const callsForUpdate = (kind: YtDlpErrorKind) => kind === "broken" || kind === "bot-check";

/** How a failure counts in the source-health report. */
export function failureKindOf(kind: YtDlpErrorKind): FailureKind {
  return kind === "throttled" ? "throttled" : kind === "bot-check" ? "blocked" : "error";
}

/**
 * For how long after YouTube last refused this computer a search asks
 * SoundCloud at the same time as YouTube (hedging): YouTube's limits usually
 * last minutes, and a hedged search costs nothing but a SoundCloud search.
 */
export const HEDGE_FOR_MS = 10 * 60_000;

/**
 * What the app answers when YouTube refuses a request only YouTube can answer
 * (a YouTube link's video or playlist, or a YouTube video's download): what
 * happened, and what to do instead.
 */
export const REFUSED_MESSAGE =
  "YouTube is refusing this computer right now (it limits computers that ask it a lot), and only YouTube has this. Search for the song by name and pick a result marked SoundCloud: while YouTube refuses, searches look on SoundCloud too. If YouTube keeps asking to confirm you're not a bot, turn on “Use my Firefox YouTube sign-in” under the search box.";

// yt-dlp couldn't read the browser's cookies: no Firefox, no profile, or none signed in.
const COOKIES_UNREADABLE_RE = /cookies database|failed to load cookies|could not find .*cookies/i;

/** YouTube refused this request: it's limiting this computer (throttled, or a bot check). */
export class YouTubeRefused extends Error {
  readonly status = 502;
  constructor(
    readonly kind: "throttled" | "bot-check",
    /** yt-dlp's own error line. */
    readonly reason: string,
    options?: ErrorOptions,
  ) {
    super(REFUSED_MESSAGE, options);
  }
}

/** The JSON a refusal is answered with: the usual `{ message }`, plus where it came from. */
export function refusedBody(): LimitedError {
  return { message: REFUSED_MESSAGE, source: "youtube", limited: true };
}

/**
 * Answers a request YouTube refused: a 502, straight away. Typed as JSON here,
 * since a download has set its audio type before the stream was refused.
 */
export function sendRefused(res: Response) {
  return res.status(502).type("application/json").json(refusedBody());
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

export type GuardOptions = {
  health?: Pick<SourceHealthStore, "record">;
  now?: () => number;
  cache?: TtlCache<unknown>;
  updater?: YtDlpUpdater;
  /** The error line of a failed call (yt-dlp's own, when there is one). */
  failureText?: (err: unknown) => string;
  log?: (line: string) => void;
  /** The browser whose YouTube sign-in calls may use, or undefined when that's off (the setting). */
  signIn?: () => Promise<YtDlpSignIn | undefined>;
};

/** The owner's setting: Firefox's YouTube sign-in, or none (the default). */
async function signInSetting(): Promise<YtDlpSignIn | undefined> {
  return (await settings.get()).youtubeSignIn === "firefox" ? "firefox" : undefined;
}

/** A yt-dlp call to YouTube. */
export type GuardedCall<T> = {
  /** Cached under this key, if given. */
  key?: string;
  /** Makes the call, signed in to YouTube with this browser's cookies when given. */
  attempt: (signIn?: YtDlpSignIn) => Promise<T>;
};

/** The cache, the self-update and the health records around yt-dlp's calls to YouTube. */
export class YouTubeGuard {
  readonly cache: TtlCache<unknown>;
  readonly updater: YtDlpUpdater;
  private readonly health: Pick<SourceHealthStore, "record">;
  private readonly now: () => number;
  private readonly failureText: (err: unknown) => string;
  private readonly log: (line: string) => void;
  private readonly signIn: () => Promise<YtDlpSignIn | undefined>;
  /** When YouTube last refused a call (ms since the epoch). */
  private lastRefusedAt: number | undefined;
  /** The sign-in that got past YouTube's bot check, used straight away until `signedInUntil`. */
  private signedIn: { browser: YtDlpSignIn; until: number } | undefined;

  constructor({
    health = sourceHealth,
    now = Date.now,
    cache = new TtlCache<unknown>(),
    updater = new YtDlpUpdater(),
    failureText = ytDlpFailure,
    log = console.warn,
    signIn = signInSetting,
  }: GuardOptions = {}) {
    this.health = health;
    this.now = now;
    this.cache = cache;
    this.updater = updater;
    this.failureText = failureText;
    this.log = log;
    this.signIn = signIn;
  }

  /**
   * The sign-in calls and audio streams use right now: the browser's, for 10
   * minutes after a signed-in call got past a bot check; else none.
   */
  signInNow(): YtDlpSignIn | undefined {
    if (this.signedIn && this.now() < this.signedIn.until) return this.signedIn.browser;
    this.signedIn = undefined;
    return undefined;
  }

  /** Stops using a sign-in at once (the setting was turned off). */
  forgetSignIn(): void {
    this.signedIn = undefined;
  }

  /**
   * Has YouTube refused this computer (throttled, or a bot check) in the last
   * 10 minutes? Searches then ask SoundCloud at the same time as YouTube.
   * Nothing else changes: every call is still made.
   */
  refusedRecently(): boolean {
    return this.lastRefusedAt !== undefined && this.now() - this.lastRefusedAt < HEDGE_FOR_MS;
  }

  /**
   * Runs a yt-dlp call to YouTube — always: nothing here turns a call away or
   * makes it wait. A fresh cached answer comes first; a new answer is cached.
   * Throws `YouTubeRefused` when YouTube refused, else the call's own error.
   */
  async run<T>({ key, attempt }: GuardedCall<T>): Promise<T> {
    if (key !== undefined) {
      const cached = this.cache.get(key, this.now()) as T | undefined;
      if (cached !== undefined) return cached;
    }
    const signedIn = this.signInNow();
    let result: T;
    try {
      result = await attempt(signedIn);
    } catch (error) {
      const failure = this.failed(error, this.failureText(error));
      // A bot check: made again at once, signed in — if the owner allows it.
      if (signedIn || !(failure instanceof YouTubeRefused) || failure.kind !== "bot-check") {
        throw failure;
      }
      const browser = await this.signIn();
      if (!browser) throw failure;
      result = await this.attemptSignedIn(attempt, browser, failure);
    }
    this.health.record("youtube", true);
    if (key !== undefined) this.cache.set(key, result, this.now());
    return result;
  }

  /**
   * An audio stream from YouTube (yt-dlp → ffmpeg) has ended: recorded like
   * any call. Returns the `YouTubeRefused` to answer with when YouTube refused
   * it — if the response hasn't started yet (the caller knows).
   */
  pipelineEnded(ok: boolean, reason: string): YouTubeRefused | undefined {
    if (ok) {
      this.health.record("youtube", true);
      return undefined;
    }
    const failure = this.failed(new Error(reason), reason);
    return failure instanceof YouTubeRefused ? failure : undefined;
  }

  /**
   * The call again, signed in with `browser`'s YouTube cookies. When that
   * works, calls use the sign-in straight away for the next 10 minutes. When
   * the cookies can't be read, the bot check (`refused`) is the answer.
   */
  private async attemptSignedIn<T>(
    attempt: GuardedCall<T>["attempt"],
    browser: YtDlpSignIn,
    refused: YouTubeRefused,
  ): Promise<T> {
    try {
      const result = await attempt(browser);
      this.signedIn = { browser, until: this.now() + HEDGE_FOR_MS };
      this.log(
        `YouTube asked for a sign-in: using ${browser}'s YouTube sign-in for the next ${HEDGE_FOR_MS / 60_000} minutes.`,
      );
      return result;
    } catch (error) {
      const text = this.failureText(error);
      if (COOKIES_UNREADABLE_RE.test(text)) {
        this.log(`Couldn't use ${browser}'s YouTube sign-in ("${text}").`);
        throw refused;
      }
      throw this.failed(error, text);
    }
  }

  /** Records a failure, starts a background update if it calls for one, and says what to throw. */
  private failed(error: unknown, text: string): unknown {
    const kind = classifyYtDlpError(text);
    this.recordFailure(kind, text);
    // An outdated yt-dlp: update it for the calls to come. Nobody waits for it.
    if (callsForUpdate(kind)) void this.updater.update(this.now(), text);
    if (!isRefusal(kind)) return error;
    if (!this.refusedRecently()) {
      this.log(
        `YouTube is limiting this computer ("${text}"): for the next ${HEDGE_FOR_MS / 60_000} minutes, searches ask SoundCloud at the same time.`,
      );
    }
    this.lastRefusedAt = this.now();
    return new YouTubeRefused(kind, text, { cause: error });
  }

  /** Forgets the last refusal, the cache and the last update (tests). */
  reset(): void {
    this.lastRefusedAt = undefined;
    this.signedIn = undefined;
    this.cache.clear();
    this.updater.forget();
  }

  private recordFailure(kind: YtDlpErrorKind, text: string) {
    // A private or removed video is YouTube answering properly, not failing us.
    if (kind === "unavailable") {
      this.health.record("youtube", true);
      return;
    }
    this.health.record("youtube", false, { kind: failureKindOf(kind), note: text });
  }
}

/** The guard the app's routes use. */
export const youtubeGuard = new YouTubeGuard();
