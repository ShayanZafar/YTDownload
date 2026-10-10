/**
 * Song search: find YouTube uploads for a text query ("artist song name").
 *
 * yt-dlp's `ytsearchN:` lists the top N YouTube results quickly (~4s) without
 * opening each video. We then rank them so the artist's or label's own upload
 * comes first — every YouTube upload tops out at the same ~130 kbps audio for
 * free, so the real quality difference is what the uploader started from, and
 * the official upload is taken from the label's masters.
 */
import { spawn } from "child_process";
import { SAME_LENGTH_SECONDS, type SearchResult } from "@shared/schema";
import { YT_DLP_PATH } from "./audio";

/** How many results to ask YouTube for; ranking then keeps the best MAX_RESULTS. */
const FETCH_COUNT = 12;
export const MAX_RESULTS = 8;
const SEARCH_TIMEOUT_MS = 30_000;

/** The fields we use from a yt-dlp flat search entry. */
export type RawSearchEntry = {
  id?: string | null;
  title?: string | null;
  duration?: number | null;
  channel?: string | null;
  uploader?: string | null;
  channel_is_verified?: boolean | null;
  live_status?: string | null;
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
 * Turn raw search entries into results, best first: official uploads of the
 * song searched for up; results missing part of the search (another artist's
 * song with the same name) and live/cover/remix-style versions (unless asked
 * for) down; otherwise YouTube's own order. Drops live streams and anything
 * that isn't a single video.
 */
export type RankOptions = {
  limit?: number;
  /** The song's length in seconds, if known: same-length uploads move up (above official ones). */
  targetDuration?: number | null;
};

export function rankResults(
  query: string,
  entries: RawSearchEntry[],
  { limit = MAX_RESULTS, targetDuration }: RankOptions = {},
): SearchResult[] {
  const q = normalize(query);
  const seen = new Set<string>();
  const scored: { score: number; index: number; result: SearchResult }[] = [];

  entries.forEach((entry, index) => {
    const id = entry.id ?? "";
    if (!VIDEO_ID_RE.test(id) || seen.has(id)) return;
    if (entry.live_status === "is_live" || entry.live_status === "is_upcoming") return;
    seen.add(id);

    const title = entry.title?.trim() || "Untitled";
    const official = isOfficial(entry, query);
    const matches = queryCoverage(query, entry) >= MATCH_THRESHOLD;
    const t = normalize(title);
    const variant = VARIANT_GROUPS.some(
      (group) => group.some((w) => hasWords(t, w)) && !group.some((w) => hasWords(q, w)),
    );
    const sameLength =
      targetDuration != null &&
      typeof entry.duration === "number" &&
      Math.abs(entry.duration - targetDuration) <= SAME_LENGTH_SECONDS;
    scored.push({
      index,
      score:
        (official && matches ? 2 : 0) +
        (sameLength && matches ? 3 : 0) -
        (matches ? 0 : 1) -
        (variant ? 3 : 0),
      result: {
        id,
        url: `https://www.youtube.com/watch?v=${id}`,
        title,
        channel: (entry.channel ?? entry.uploader ?? "").trim(),
        duration: typeof entry.duration === "number" ? Math.round(entry.duration) : null,
        thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        official,
      },
    });
  });

  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, limit).map((s) => s.result);
}

/** yt-dlp arguments for a quick YouTube search that lists results without opening them. */
export function ytDlpSearchArgs(query: string): string[] {
  // "--" ends the options, so nothing in the query can be read as one.
  return [
    "--flat-playlist",
    "--dump-single-json",
    "--no-warnings",
    "--",
    `ytsearch${FETCH_COUNT}:${query}`,
  ];
}

/**
 * Runs yt-dlp directly — never through a shell — so text from the search box
 * can't be interpreted as a command, and parses its JSON output.
 */
export function runYtDlpJson(args: string[], timeoutMs = SEARCH_TIMEOUT_MS): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(YT_DLP_PATH, args, { windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const message = Buffer.concat(err).toString("utf8").trim().split(/\r?\n/).pop();
        return reject(new Error(message || `yt-dlp exited with code ${code}`));
      }
      try {
        resolve(JSON.parse(Buffer.concat(out).toString("utf8")));
      } catch {
        reject(new Error("yt-dlp returned unexpected search output"));
      }
    });
  });
}

export async function searchYouTube(
  query: string,
  options: Omit<RankOptions, "limit"> = {},
): Promise<SearchResult[]> {
  const info = (await runYtDlpJson(ytDlpSearchArgs(query))) as { entries?: RawSearchEntry[] };
  return rankResults(query, info.entries ?? [], options);
}
