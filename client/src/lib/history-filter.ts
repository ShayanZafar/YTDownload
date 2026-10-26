/**
 * Searching and filtering the download history ("Recent Extractions"). It's
 * at most MAX_HISTORY entries and already on the page, so this all happens in
 * the browser, as you type.
 */
import type { Download } from "@shared/schema";
import { foldWords } from "@shared/fold-text";

export const historyRanges = ["all", "week", "month", "older"] as const;
export type HistoryRange = (typeof historyRanges)[number];

export const historyRangeLabels: Record<HistoryRange, string> = {
  all: "All",
  week: "Past week",
  month: "Past month",
  older: "Older",
};

/** What each range means, for tooltips. */
export const historyRangeHints: Record<HistoryRange, string> = {
  all: "Everything in your history",
  week: "Downloaded in the last 7 days",
  month: "Downloaded in the last 30 days",
  older: "Downloaded more than 30 days ago",
};

/** The same ranges in a sentence: "No extractions from the past week." */
export const historyRangePhrases: Record<HistoryRange, string> = {
  all: "",
  week: "from the past week",
  month: "from the past month",
  older: "from more than a month ago",
};

const DAY_MS = 24 * 60 * 60 * 1000;
// Anything that isn't a letter or digit, in any language. (Built with
// new RegExp because the "u" flag needs a newer compile target than ours.)
const NON_WORD_SPLIT = new RegExp("[^\\p{L}\\p{N}]+", "u");

/** Lowercase, no accents or punctuation: "Beyoncé - Halo!" → "beyonce halo". Works for any script. */
export function searchableText(text: string): string {
  return foldWords(text);
}

/**
 * Does the entry contain every word typed? Words can be partial ("prog ocea"
 * finds "Progression - Ocean Green"), so the list narrows as you type. The
 * video's address counts too, so pasting a YouTube link finds past downloads
 * of that video.
 */
export function matchesSearch(entry: Pick<Download, "title" | "url">, query: string): boolean {
  const words = searchableText(query).split(" ").filter(Boolean);
  if (words.length === 0) return true;
  const haystack = `${searchableText(entry.title)} ${entry.url.toLowerCase()}`;
  return words.every((word) => haystack.includes(word));
}

/** Was it downloaded within the range? "Past month" is the last 30 days; "Older" is before that. */
export function inHistoryRange(
  downloadedAt: string,
  range: HistoryRange,
  now = Date.now(),
): boolean {
  if (range === "all") return true;
  const time = new Date(downloadedAt).getTime();
  if (Number.isNaN(time)) return false; // unreadable date: only shown under "All"
  const age = now - time;
  if (range === "week") return age < 7 * DAY_MS;
  if (range === "month") return age < 30 * DAY_MS;
  return age >= 30 * DAY_MS;
}

export function filterHistory<T extends Pick<Download, "title" | "url" | "downloadedAt">>(
  entries: readonly T[],
  query: string,
  range: HistoryRange,
  now = Date.now(),
): T[] {
  return entries.filter(
    (entry) => inHistoryRange(entry.downloadedAt, range, now) && matchesSearch(entry, query),
  );
}

/** Only the entries with exactly this title — what picking an autocomplete suggestion shows. */
export function filterHistoryByTitle<T extends Pick<Download, "title" | "downloadedAt">>(
  entries: readonly T[],
  title: string,
  range: HistoryRange,
  now = Date.now(),
): T[] {
  return entries.filter(
    (entry) => entry.title === title && inHistoryRange(entry.downloadedAt, range, now),
  );
}

export type HistorySuggestion = {
  title: string;
  /** How many times it's in the history (the same song downloaded again). */
  count: number;
  lastDownloadedAt: string;
};

/**
 * Autocomplete for the history search: each matching song once, best first —
 * titles that start with what was typed, then titles where every word typed
 * starts a word, then any other match — and the most recent first among
 * equals. `entries` must be newest first, as the server sends them.
 */
export function historySuggestions<T extends Pick<Download, "title" | "url" | "downloadedAt">>(
  entries: readonly T[],
  query: string,
  limit = 8,
): HistorySuggestion[] {
  const typed = searchableText(query);
  if (!typed) return [];
  const words = typed.split(" ");

  const byTitle = new Map<string, HistorySuggestion & { rank: number; order: number }>();
  entries.forEach((entry, order) => {
    if (!matchesSearch(entry, query)) return;
    const seen = byTitle.get(entry.title);
    if (seen) {
      seen.count += 1;
      return;
    }
    const title = searchableText(entry.title);
    const titleWords = title.split(" ");
    const rank = title.startsWith(typed)
      ? 0
      : words.every((word) => titleWords.some((t) => t.startsWith(word)))
        ? 1
        : 2;
    byTitle.set(entry.title, {
      title: entry.title,
      count: 1,
      lastDownloadedAt: entry.downloadedAt,
      rank,
      order,
    });
  });

  return Array.from(byTitle.values())
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, limit)
    .map(({ title, count, lastDownloadedAt }) => ({ title, count, lastDownloadedAt }));
}

/**
 * Splits `text` into pieces with the typed words marked, for highlighting:
 * ("Ocean Green", "ocean") → [{ text: "Ocean", match: true }, { text: " Green", match: false }].
 * A word is marked where a word in the text starts with it ("gre" in "Green",
 * not in "Progression"), or anywhere if it only appears inside words.
 * Case-insensitive; a word typed without its accents isn't marked (it still matches).
 */
export function highlightParts(text: string, query: string): { text: string; match: boolean }[] {
  const words = Array.from(new Set(query.toLowerCase().split(NON_WORD_SPLIT)))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length); // longest first, so "oceans" wins over "o"
  if (words.length === 0) return [{ text, match: false }];

  // Where each word appears, as [start, end) ranges. No lookbehind in these
  // patterns: Safari only understands it from version 16.4.
  const ranges: [number, number][] = [];
  for (const word of words) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const atWordStart = rangesOf(new RegExp(`(^|[^\\p{L}\\p{N}])(${escaped})`, "giu"), text);
    ranges.push(
      ...(atWordStart.length > 0
        ? atWordStart
        : rangesOf(new RegExp(`()(${escaped})`, "giu"), text)),
    );
  }

  // Leftmost first, and the longest where two start together; skip overlaps.
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const parts: { text: string; match: boolean }[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start < at) continue;
    if (start > at) parts.push({ text: text.slice(at, start), match: false });
    parts.push({ text: text.slice(start, end), match: true });
    at = end;
  }
  if (at < text.length) parts.push({ text: text.slice(at), match: false });
  return parts;
}

/** Where `pattern` (global, word in its second group) matches: the word's [start, end). */
function rangesOf(pattern: RegExp, text: string): [number, number][] {
  const found: [number, number][] = [];
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    const start = m.index + m[1].length;
    found.push([start, start + m[2].length]);
  }
  return found;
}
