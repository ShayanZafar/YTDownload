/**
 * Song search: find uploads for a text query ("artist song name").
 *
 * yt-dlp's `ytsearchN:` lists the top N YouTube results quickly (~4s) without
 * opening each video. We then rank them so the artist's or label's own upload
 * comes first — every YouTube upload tops out at the same ~130 kbps audio for
 * free, so the real quality difference is what the uploader started from, and
 * the official upload is taken from the label's masters.
 *
 * SoundCloud (`scsearchN:`, soundcloud.ts) is the fallback, and `searchSongs()`
 * never waits on anything of ours to use it: YouTube is always asked; when its
 * search fails or finds nothing, SoundCloud is asked at once — and while
 * YouTube has refused this computer in the last 10 minutes, SoundCloud is
 * asked at the same time as YouTube (hedging), so a refusal costs no time.
 * YouTube's results are used whenever it answers with some, else
 * SoundCloud's; every result says which source it's from. Both are ranked the
 * same way.
 */
import type { AudioSource, SearchResult } from "@shared/schema";
import { SAME_LENGTH_SECONDS, otherLength } from "@shared/schema";
import { runYtDlpJson, ytDlpErrorLine } from "./audio";
import { looksLikePreview, recordSoundCloud, soundCloudResult } from "./soundcloud";
import type { SourceHealthStore } from "./source-health";
import {
  TtlCache,
  YouTubeRefused,
  searchCacheKey,
  youtubeGuard,
  type YouTubeGuard,
} from "./youtube-limits";

/** How many results to ask for; ranking then keeps the best MAX_RESULTS. */
export const FETCH_COUNT = 12;
export const MAX_RESULTS = 8;

/** The fields we use from a yt-dlp flat search entry (YouTube's, or SoundCloud's). */
export type RawSearchEntry = {
  id?: string | number | null;
  title?: string | null;
  duration?: number | null;
  channel?: string | null;
  uploader?: string | null;
  channel_is_verified?: boolean | null;
  live_status?: string | null;
  /** SoundCloud: the track's API link, and its page (the link people know). */
  url?: string | null;
  webpage_url?: string | null;
  /** SoundCloud: its artwork, in several sizes. */
  thumbnails?: { url?: unknown; width?: unknown }[] | null;
  thumbnail?: string | null;
};

const VIDEO_ID_RE = /^[\w-]{11}$/;

// Versions people usually don't want when they search for a song. They're
// moved down the list — unless the search asks for one of them: searching
// "… live" keeps live versions, performances and concerts where they are.
const VARIANT_GROUPS = [
  ["live", "performance", "performs", "concert"],
  ["cover"],
  ["remix", "mashup"],
  ["karaoke", "instrumental"],
  ["acoustic"],
  ["extended"],
  ["sped up", "slowed", "nightcore", "8d", "reverb"],
  ["reaction", "tutorial", "lesson"],
  ["flashmob", "parody", "trailer"],
];

// Words that say nothing about which song is meant, so they don't count when
// checking how well a result matches the search.
const FILLER_WORDS = new Set([
  "official",
  "audio",
  "video",
  "music",
  "song",
  "lyrics",
  "lyric",
  "hq",
  "hd",
  "4k",
  "full",
  "version",
  "ft",
  "feat",
  "featuring",
  "the",
  "a",
  "an",
  "and",
  "by",
  "of",
  "with",
  "x",
]);

// How much of the search a result has to contain to count as a match.
const MATCH_THRESHOLD = 0.75;

// When we know the song's exact length (from a Spotify link), uploads within
// SAME_LENGTH_SECONDS of it are very likely the same recording — label "Topic"
// uploads usually match to the second, while music videos add intros.

/** Lowercase, strip accents and punctuation, single spaces: "Beyoncé - Halo!" → "beyonce halo". */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const hasWords = (normalized: string, words: string) => ` ${normalized} `.includes(` ${words} `);

/** Is the title (normalized) a live/cover/remix-style version the search (normalized) didn't ask for? */
const isVariant = (q: string, t: string) =>
  VARIANT_GROUPS.some(
    (group) => group.some((w) => hasWords(t, w)) && !group.some((w) => hasWords(q, w)),
  );

/**
 * Share of the search's words (ignoring filler like "official" or "lyrics")
 * found in the result's title or channel name — the artist is often only in
 * the channel name ("Get Lucky" by "Daft Punk - Topic"). 1 when the search has
 * no words we can compare, e.g. it's in a non-Latin script.
 */
export function queryCoverage(query: string, entry: RawSearchEntry): number {
  const words = Array.from(new Set(normalize(query).split(" "))).filter(
    (w) => w && !FILLER_WORDS.has(w),
  );
  if (words.length === 0) return 1;
  const haystack = normalize(`${entry.title ?? ""} ${entry.channel ?? entry.uploader ?? ""}`);
  return words.filter((w) => hasWords(haystack, w)).length / words.length;
}

/**
 * Did the artist or their label upload this? YouTube auto-generates
 * "Artist - Topic" channels from label releases, and verified VEVO channels
 * are label-run (anyone can call a channel "…VEVO", so it must be verified). Otherwise it's a verified channel named after the artist: the
 * title starts with its name ("Daft Punk" posting "Daft Punk - Get Lucky"), or
 * the search has it ("Queen Official" posting "Bohemian Rhapsody" for "queen
 * bohemian rhapsody"). A verified lyrics channel posting someone else's song,
 * or a TV channel's "… performs Get Lucky | BBC", doesn't count.
 */
export function isOfficial(entry: RawSearchEntry, query = ""): boolean {
  const channel = (entry.channel ?? entry.uploader ?? "").trim();
  if (/ - topic$/i.test(channel)) return true;
  if (!entry.channel_is_verified) return false;
  if (/vevo$/i.test(channel)) return true;
  const name = normalize(channel.replace(/\b(official|music|tv|channel)\b/gi, " "));
  if (name.length < 2 || FILLER_WORDS.has(name)) return false;
  return (
    `${normalize(entry.title ?? "")} `.startsWith(`${name} `) || hasWords(normalize(query), name)
  );
}

/**
 * A YouTube search entry as a result: its watch link and thumbnail, built from
 * its id. Live streams and anything that isn't a single video are left out.
 */
export function youtubeResult(entry: RawSearchEntry, query: string): SearchResult | undefined {
  const id = typeof entry.id === "string" ? entry.id : "";
  if (!VIDEO_ID_RE.test(id)) return undefined;
  if (entry.live_status === "is_live" || entry.live_status === "is_upcoming") return undefined;
  return {
    id,
    url: `https://www.youtube.com/watch?v=${id}`,
    title: entry.title?.trim() || "Untitled",
    channel: (entry.channel ?? entry.uploader ?? "").trim(),
    duration: typeof entry.duration === "number" ? Math.round(entry.duration) : null,
    thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    official: isOfficial(entry, query),
    source: "youtube",
  };
}

export type RankOptions = {
  limit?: number;
  /** The song's length in seconds, if known: same-length uploads move up (above official ones). */
  targetDuration?: number | null;
  /** An entry as a result, or undefined to leave it out: YouTube's (the default) or SoundCloud's. */
  toResult?: (entry: RawSearchEntry, query: string) => SearchResult | undefined;
  /** Entries to put after all the others, however well they match (SoundCloud's previews). */
  last?: (entry: RawSearchEntry) => boolean;
};

/**
 * Turn raw search entries into results, best first: official uploads of the
 * song searched for up; results missing part of the search (another artist's
 * song with the same name) and live/cover/remix-style versions (unless asked
 * for) down; otherwise the source's own order. With the song's length known,
 * uploads of another length altogether (`otherLength()`: full sets, mixes,
 * albums) go after all the others. Entries `toResult` leaves out
 * (live streams, anything that isn't a single video or track) are dropped,
 * and those `last` picks out go after everything else.
 */
export function rankResults(
  query: string,
  entries: RawSearchEntry[],
  { limit = MAX_RESULTS, targetDuration, toResult = youtubeResult, last }: RankOptions = {},
): SearchResult[] {
  const q = normalize(query);
  const seen = new Set<string>();
  const scored: {
    last: boolean;
    other: boolean;
    score: number;
    index: number;
    result: SearchResult;
  }[] = [];

  entries.forEach((entry, index) => {
    const result = toResult(entry, query);
    if (!result || seen.has(result.id)) return;
    seen.add(result.id);

    const matches = queryCoverage(query, entry) >= MATCH_THRESHOLD;
    const variant = isVariant(q, normalize(result.title));
    const sameLength =
      targetDuration != null &&
      typeof entry.duration === "number" &&
      Math.abs(entry.duration - targetDuration) <= SAME_LENGTH_SECONDS;
    scored.push({
      last: last?.(entry) ?? false,
      // A full set, a mix or an album rather than the song (or a preview): after the rest.
      other:
        targetDuration != null &&
        typeof entry.duration === "number" &&
        otherLength(entry.duration, targetDuration),
      index,
      score:
        (result.official && matches ? 2 : 0) +
        (sameLength && matches ? 3 : 0) -
        (matches ? 0 : 1) -
        (variant ? 3 : 0),
      result,
    });
  });

  scored.sort(
    (a, b) =>
      Number(a.last) - Number(b.last) ||
      Number(a.other) - Number(b.other) ||
      b.score - a.score ||
      a.index - b.index,
  );
  return scored.slice(0, limit).map((s) => s.result);
}

/**
 * Is this result the song a search was for, at its length? The search's words
 * are in its title or channel, it isn't a live, cover or remix-style version
 * the search didn't ask for, and it's within SAME_LENGTH_SECONDS of `seconds`.
 */
export function sameSongAs(query: string, result: SearchResult, seconds: number): boolean {
  return (
    result.duration !== null &&
    Math.abs(result.duration - seconds) <= SAME_LENGTH_SECONDS &&
    queryCoverage(query, { title: result.title, channel: result.channel }) >= MATCH_THRESHOLD &&
    !isVariant(normalize(query), normalize(result.title))
  );
}

/**
 * yt-dlp arguments for a quick search that lists results without opening them:
 * `ytsearch12:` on YouTube, `scsearch12:` on SoundCloud.
 */
function flatSearchArgs(prefix: "ytsearch" | "scsearch", query: string): string[] {
  // "--" ends the options, so nothing in the query can be read as one.
  return [
    "--flat-playlist",
    "--dump-single-json",
    "--no-warnings",
    "--",
    `${prefix}${FETCH_COUNT}:${query}`,
  ];
}

/** yt-dlp arguments for a quick YouTube search that lists results without opening them. */
export const ytDlpSearchArgs = (query: string) => flatSearchArgs("ytsearch", query);

/** yt-dlp arguments for the same search on SoundCloud (no account or key needed). */
export const soundCloudSearchArgs = (query: string) => flatSearchArgs("scsearch", query);

export type SearchOptions = Pick<RankOptions, "targetDuration">;

/** What a search runs on: the guard around YouTube, yt-dlp, and SoundCloud's cache and health. */
export type SearchDeps = {
  guard?: YouTubeGuard;
  /** Runs yt-dlp with these arguments and gives its JSON (`runYtDlpJson`). */
  run?: (args: string[]) => Promise<unknown>;
  health?: Pick<SourceHealthStore, "record">;
  soundCloudCache?: TtlCache<SearchResult[]>;
  now?: () => number;
};

/** SoundCloud's answers, kept for a while like YouTube's (youtube-limits.ts). */
export const soundCloudCache = new TtlCache<SearchResult[]>();

/**
 * The ranked YouTube results for a query. Through `youtubeGuard`
 * (youtube-limits.ts): a recent search is answered from its cache, and when
 * YouTube refuses it throws `YouTubeRefused` at once.
 */
export async function searchYouTube(
  query: string,
  options: SearchOptions = {},
  { guard = youtubeGuard, run = runYtDlpJson }: SearchDeps = {},
): Promise<SearchResult[]> {
  return guard.run({
    key: searchCacheKey(query, options.targetDuration),
    attempt: async () => {
      const info = (await run(ytDlpSearchArgs(query))) as { entries?: RawSearchEntry[] };
      return rankResults(query, info.entries ?? [], options);
    },
  });
}

/**
 * The ranked SoundCloud results for a query (`scsearch`, through the same
 * runner as YouTube's search; the query after "--"), 30-second previews last.
 * Every attempt is recorded as `soundcloud` in the source-health report;
 * answers are cached for a while.
 */
export async function searchSoundCloud(
  query: string,
  { targetDuration }: SearchOptions = {},
  {
    run = runYtDlpJson,
    health,
    soundCloudCache: cache = soundCloudCache,
    now = Date.now,
  }: SearchDeps = {},
): Promise<SearchResult[]> {
  const key = searchCacheKey(query, targetDuration);
  const cached = cache.get(key, now());
  if (cached) return cached;
  let info: { entries?: RawSearchEntry[] };
  try {
    info = (await run(soundCloudSearchArgs(query))) as typeof info;
  } catch (err) {
    recordSoundCloud(false, reasonOf(err), health);
    throw err;
  }
  recordSoundCloud(true, "", health);
  const results = rankResults(query, info.entries ?? [], {
    targetDuration,
    toResult: soundCloudResult,
    last: looksLikePreview,
  });
  cache.set(key, results, now());
  return results;
}

/** Results, and which source they're from. */
export type SongSearchAnswer = { results: SearchResult[]; source: AudioSource };

export type SongSearchOptions = SearchOptions & {
  /** What to ask SoundCloud, if not the same (a Spotify song's search drops "audio"). */
  soundCloudQuery?: string;
};

/** No source could be searched: a 502 that says why; `limited` when YouTube refused. */
export class SearchFailed extends Error {
  readonly status = 502;
  constructor(
    message: string,
    readonly limited: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** A failed search's reason, in a few words: yt-dlp's own error line. */
function reasonOf(err: unknown): string {
  if (err instanceof YouTubeRefused) return err.reason;
  return ytDlpErrorLine(err instanceof Error ? err.message : String(err));
}

/** What each source's search came to: its results, or why it failed. */
type Outcome = { results: SearchResult[] } | { error: unknown };

const outcomeOf = (search: Promise<SearchResult[]>): Promise<Outcome> =>
  search.then(
    (results) => ({ results }),
    (error: unknown) => ({ error }),
  );

/**
 * The search the app's routes use. YouTube is always asked. While YouTube has
 * refused this computer in the last 10 minutes, SoundCloud is asked at the
 * same time; otherwise it's asked only once YouTube's search has failed or
 * found nothing — straight away, never after a wait. YouTube's results are the
 * answer when it has some; else SoundCloud's; else YouTube's empty answer.
 * Throws `SearchFailed` only when no source could be searched at all.
 */
export async function searchSongs(
  query: string,
  { soundCloudQuery = query, ...options }: SongSearchOptions = {},
  deps: SearchDeps = {},
): Promise<SongSearchAnswer> {
  const guard = deps.guard ?? youtubeGuard;
  const askSoundCloud = () => outcomeOf(searchSoundCloud(soundCloudQuery, options, deps));
  // Hedging: SoundCloud's answer is on its way while YouTube's is.
  const hedge = guard.refusedRecently() ? askSoundCloud() : undefined;

  const youtube = await outcomeOf(searchYouTube(query, options, deps));
  if ("results" in youtube && youtube.results.length > 0) {
    return { results: youtube.results, source: "youtube" };
  }
  const soundCloud = await (hedge ?? askSoundCloud());
  if ("results" in soundCloud && (soundCloud.results.length > 0 || "error" in youtube)) {
    return { results: soundCloud.results, source: "soundcloud" };
  }
  // YouTube answered, with nothing: that's the answer, whatever SoundCloud said.
  if ("results" in youtube) return { results: [], source: "youtube" };

  const soundCloudReason = reasonOf((soundCloud as { error: unknown }).error);
  if (youtube.error instanceof YouTubeRefused) {
    throw new SearchFailed(
      `YouTube is refusing this computer right now (it limits computers that ask it a lot), and SoundCloud couldn't be searched either (${soundCloudReason}). Neither can answer at the moment: search again in a while.`,
      true,
      { cause: youtube.error },
    );
  }
  throw new SearchFailed(
    `Couldn't search YouTube (${reasonOf(youtube.error)}) or SoundCloud (${soundCloudReason}). Check the internet connection, then search again.`,
    false,
    { cause: youtube.error },
  );
}

/**
 * A search on SoundCloud alone — for a song YouTube refused to hand over (a
 * refused download or save), where YouTube's results would only be refused
 * again. Throws `SearchFailed` when SoundCloud can't be searched.
 */
export async function searchSoundCloudOnly(
  query: string,
  options: SearchOptions = {},
  deps: SearchDeps = {},
): Promise<SongSearchAnswer> {
  try {
    return { results: await searchSoundCloud(query, options, deps), source: "soundcloud" };
  } catch (err) {
    throw new SearchFailed(
      `Couldn't search SoundCloud (${reasonOf(err)}). Check the internet connection, then search again.`,
      false,
      { cause: err },
    );
  }
}
