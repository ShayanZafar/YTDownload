/**
 * Song lyrics for the music player, from LRCLIB (lrclib.net): a free, open
 * lyrics library with no account or key, whose "synced" lyrics give each
 * line's time, so the player can follow along.
 *
 * Only the song's title, artist and length are sent there, to one fixed
 * address (the query is built with URLSearchParams), and answers are kept in
 * memory, so a song is looked up once per run of the app.
 */
import type { LyricLine, Lyrics } from "@shared/schema";
import { withoutNameNoise } from "@shared/name-noise";
import { cleanTrackTitle } from "@shared/spotify-names";

const LRCLIB_SEARCH = "https://lrclib.net/api/search";
const FETCH_TIMEOUT_MS = 8_000;
// LRCLIB asks apps to say who they are.
const USER_AGENT = "YTDownload (https://github.com/ShayanZafar/YTDownload)";
/** A found song this many seconds longer or shorter than ours is another recording. */
export const LYRICS_SAME_LENGTH_SECONDS = 3;
/** Songs whose lyrics (or lack of them) are remembered. */
const CACHE_SIZE = 500;

/** A failure to reach LRCLIB (not "no lyrics": that's null). */
export class LyricsError extends Error {}

export type SongToLookUp = { title: string; artist?: string; duration?: number };

/** One of LRCLIB's songs, as its search answers. */
type LrclibRecord = {
  trackName?: unknown;
  artistName?: unknown;
  duration?: unknown;
  instrumental?: unknown;
  plainLyrics?: unknown;
  syncedLyrics?: unknown;
};

/**
 * Lines of LRC ("[01:02.50]Some words"), in time order. A line can carry
 * several times (a chorus); lines without a time ("[ar: Artist]") are left out.
 */
export function parseLrc(text: string): LyricLine[] {
  const lines: LyricLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const stamps = /^((?:\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]\s*)+)(.*)$/.exec(raw.trim());
    if (!stamps) continue;
    const words = stamps[2].trim();
    for (const [, min, sec, frac = "0"] of stamps[1].matchAll(
      /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g,
    )) {
      const time = Number(min) * 60 + Number(sec) + Number(`0.${frac}`);
      lines.push({ time: Math.round(time * 1000) / 1000, text: words });
    }
  }
  return lines.sort((a, b) => a.time - b.time);
}

/**
 * A song title as LRCLIB names it: without "(Official Video)", "(feat. …)",
 * "- Remastered", or a featured artist after it ("Despacito ft. Daddy Yankee").
 */
export function cleanSongTitle(title: string): string {
  const clean = cleanTrackTitle(withoutNameNoise(title))
    .replace(/\s+(?:feat\.?|ft\.?|featuring)\s+[^([]+$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean || title.trim();
}

/** An artist as LRCLIB names them: the first one, without "VEVO" or " - Topic". */
export function cleanArtist(artist: string): string {
  const first = artist.split(/\s*(?:,|&|;|\bfeat\.?|\bft\.?|\bx\b)\s*/i)[0] ?? artist;
  return first
    .replace(/\s*-\s*Topic$/i, "")
    .replace(/VEVO$/i, "")
    .replace(/\s*Official$/i, "")
    .trim();
}

/**
 * The ways to ask for a song: by its title and artist, and, for a title like
 * a YouTube video's "Artist - Song", by the two halves of it.
 */
export function searchesFor({ title, artist }: SongToLookUp): { track: string; artist: string }[] {
  const searches: { track: string; artist: string }[] = [];
  const clean = cleanSongTitle(title);
  // "Artist - Song", with a hyphen or a dash (and "Artist- Song", as file names have it).
  const halves = /^(.+?)\s*[-–—]\s+(.+)$/.exec(clean);
  // "Static - X - Dead Souls": an artist with a dash in it, its second part a letter or two.
  const dashed = halves && /^(\S{1,2})\s*[-–—]\s+(.+)$/.exec(halves[2]);
  if (dashed)
    searches.push({ artist: `${halves[1].trim()}-${dashed[1]}`, track: dashed[2].trim() });
  else if (halves) searches.push({ artist: halves[1].trim(), track: halves[2].trim() });
  if (artist?.trim()) searches.push({ track: clean, artist: cleanArtist(artist) });
  else if (!halves) searches.push({ track: clean, artist: "" });
  return searches.filter((s) => s.track);
}

/**
 * The best of LRCLIB's answers: one the same length as our song (when we know
 * its length), with synced lyrics if any has them.
 */
export function pickLyrics(records: unknown, duration?: number): Lyrics | null {
  const usable = (Array.isArray(records) ? (records as LrclibRecord[]) : []).filter((r) => {
    if (!r || typeof r !== "object") return false;
    const hasWords =
      (typeof r.syncedLyrics === "string" && r.syncedLyrics.trim() !== "") ||
      (typeof r.plainLyrics === "string" && r.plainLyrics.trim() !== "") ||
      r.instrumental === true;
    const sameLength =
      !duration ||
      typeof r.duration !== "number" ||
      Math.abs(r.duration - duration) <= LYRICS_SAME_LENGTH_SECONDS;
    return hasWords && sameLength;
  });
  const best =
    usable.find((r) => typeof r.syncedLyrics === "string" && parseLrc(r.syncedLyrics).length > 0) ??
    usable[0];
  if (!best) return null;
  const synced = typeof best.syncedLyrics === "string" ? parseLrc(best.syncedLyrics) : [];
  const plain = typeof best.plainLyrics === "string" ? best.plainLyrics.trim() : "";
  return {
    synced: synced.length > 0 ? synced : null,
    plain: plain || (synced.length > 0 ? synced.map((l) => l.text).join("\n") : null),
    instrumental: best.instrumental === true && !plain && synced.length === 0,
    track: typeof best.trackName === "string" ? best.trackName : "",
    artist: typeof best.artistName === "string" ? best.artistName : "",
  };
}

async function search(params: Record<string, string>): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${LRCLIB_SEARCH}?${new URLSearchParams(params)}`, {
      headers: { "User-Agent": USER_AGENT, "Lrclib-Client": USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const reason =
      err instanceof Error && err.name === "TimeoutError" ? "it took too long" : "no connection";
    throw new LyricsError(`Couldn't reach the lyrics library (${reason}).`);
  }
  if (!res.ok)
    throw new LyricsError(`The lyrics library answered with an error (HTTP ${res.status}).`);
  return res.json();
}

const cache = new Map<string, Lyrics | null>();
const cacheKey = (song: SongToLookUp) =>
  JSON.stringify([song.title.toLowerCase(), song.artist?.toLowerCase() ?? "", song.duration ?? 0]);

/** A song's lyrics, or null if LRCLIB doesn't have them. Throws LyricsError if it can't be reached. */
export async function findLyrics(song: SongToLookUp): Promise<Lyrics | null> {
  const key = cacheKey(song);
  if (cache.has(key)) return cache.get(key)!;

  let lyrics: Lyrics | null = null;
  for (const { track, artist } of searchesFor(song)) {
    const params: Record<string, string> = artist
      ? { track_name: track, artist_name: artist }
      : { q: track };
    lyrics = pickLyrics(await search(params), song.duration);
    if (lyrics) break;
  }

  cache.set(key, lyrics);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return lyrics;
}
