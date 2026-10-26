/**
 * A song's missing details (genre, album, year, track number, cover), looked
 * up in a music catalogue: Apple's iTunes Search API first, and Deezer's API
 * when iTunes refuses, fails or doesn't know the song. Both are public and
 * keyless.
 *
 * Only the song's title, artist and length are sent, to fixed addresses (the
 * query is built with URLSearchParams), and a found song must have the same
 * title and artist as ours (and, when ours has no artist, the same length) —
 * a song that only looks like it isn't taken. Answers are kept in memory, so
 * a song is looked up once per run of the app.
 *
 * Never slow the app down (.claude/rules/outside-sources.md): each catalogue
 * is asked no faster than its published limit (iTunes about 20 searches a
 * minute, Deezer 50 requests in 5 seconds) — past it Deezer answers "nothing"
 * for songs it has (seen October 2026) — and one that refuses, or whose limit
 * is used up, is skipped at once for the next, until its own time is up. Only
 * when there's no other to ask does a look-up wait, for whichever is back
 * first; a song one catalogue doesn't have while the other is refusing for
 * longer than Deezer's 5 seconds is not found.
 */
import { cleanArtist, cleanSongTitle, searchesFor, type SongToLookUp } from "./lyrics";

export const catalogueSources = ["itunes", "deezer"] as const;
export type CatalogueSource = (typeof catalogueSources)[number];

/** What a catalogue knows about a song. */
export type CatalogueSong = {
  title: string;
  artist: string;
  album?: string;
  genre?: string;
  year?: number;
  track?: number;
  /** Seconds. */
  duration?: number;
  /** A square cover picture's address, on the catalogue's own image host. */
  coverUrl?: string;
  /** On a various-artists compilation (its album and track number aren't the song's own). */
  compilation?: boolean;
  /** A single or EP rather than an album. */
  single?: boolean;
};

export type CatalogueMatch = { song: CatalogueSong; source: CatalogueSource };

/** Neither catalogue could be reached (not "no such song": that's null). */
export class CatalogueError extends Error {}

/** The catalogue said no (it's busy); try it again after `retryAt` (ms since 1970). */
class Refused extends Error {
  constructor(readonly retryAt: number) {
    super("refused");
  }
}

const ITUNES_SEARCH = "https://itunes.apple.com/search";
const DEEZER_API = "https://api.deezer.com";
const FETCH_TIMEOUT_MS = 8_000;
/** A found song this many seconds longer or shorter than ours is another recording. */
export const SAME_LENGTH_SECONDS = 3;
/** The catalogues' published limits: how many requests in how long. */
export const CATALOGUE_LIMITS: Record<CatalogueSource, { requests: number; perMs: number }> = {
  itunes: { requests: 20, perMs: 60_000 },
  deezer: { requests: 50, perMs: 5_000 },
};
/** The longest a look-up waits for a busy catalogue when it has asked the other one already. */
const SHORT_WAIT_MS = CATALOGUE_LIMITS.deezer.perMs;
/** Songs whose details (or lack of them) are remembered. */
const CACHE_SIZE = 2_000;

// Covers come only from the catalogues' own image hosts.
const ITUNES_COVER_RE =
  /^https:\/\/is[1-5]-ssl\.mzstatic\.com\/image\/thumb\/[A-Za-z0-9._/-]+\/600x600bb\.jpg$/;
const DEEZER_COVER_RE =
  /^https:\/\/(?:cdn-images|e-cdns-images)\.dzcdn\.net\/images\/cover\/[a-f0-9]{32}\/\d{2,4}x\d{2,4}-[\d-]+\.jpg$/;

/** Is this one of the catalogues' cover pictures (so the app may fetch it)? */
export const isCatalogueCoverUrl = (url: string) =>
  (ITUNES_COVER_RE.test(url) || DEEZER_COVER_RE.test(url)) && !url.includes("..");

// --- Matching -------------------------------------------------------------------

/** Text to compare: lower case, no accents or punctuation. */
export function plain(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const sameTitle = (a: string, b: string) => plain(cleanSongTitle(a)) === plain(cleanSongTitle(b));

/** A title without anything in brackets: "Heer (Coke Studio Season 8)" → "heer". */
const baseTitle = (title: string) =>
  plain(cleanSongTitle(title).replace(/\s*[([][^)\]]*[)\]]/g, "")) || plain(title);

/**
 * The same title, or the same but for something in brackets ("(Long
 * Version; 2002 Remaster)" against our "(long version)") — taken only for a
 * song the same length.
 */
const nearlySameTitle = (a: string, b: string) => baseTitle(a) === baseTitle(b);

/** Is one of the found song's artists ours (or the other way round)? */
function sameArtist(ours: string, theirs: string): boolean {
  const a = plain(cleanArtist(ours));
  const b = plain(theirs);
  const c = plain(cleanArtist(theirs));
  return (
    a !== "" && (a === c || ` ${b} `.includes(` ${a} `) || ` ${plain(ours)} `.includes(` ${c} `))
  );
}

/**
 * The catalogue's song that is ours: the same title (or the same but for
 * something in brackets, and the same length), the same artist (or, for a
 * song whose artist we don't know, the same length), best first the same
 * title, the same length, on the artist's own album rather than a compilation
 * or single.
 */
export function pickMatch(
  candidates: readonly CatalogueSong[],
  search: { track: string; artist: string },
  duration?: number,
): CatalogueSong | undefined {
  const sameLength = (song: CatalogueSong) =>
    duration !== undefined &&
    song.duration !== undefined &&
    Math.abs(song.duration - duration) <= SAME_LENGTH_SECONDS;
  const ours = candidates.filter(
    (song) =>
      (sameTitle(song.title, search.track) ||
        (nearlySameTitle(song.title, search.track) && sameLength(song))) &&
      (search.artist ? sameArtist(search.artist, song.artist) : sameLength(song)),
  );
  const score = (song: CatalogueSong) =>
    (sameTitle(song.title, search.track) ? 8 : 0) +
    (sameLength(song) ? 4 : 0) +
    (song.compilation ? 0 : 2) +
    (song.single ? 0 : 1);
  // A stable sort: equal ones stay in the catalogue's own order.
  return [...ours].sort((a, b) => score(b) - score(a))[0];
}

/**
 * Why none of a search's answers was taken, for the person to see: no
 * answers, or the closest one and what's different about it.
 */
export function explainMiss(
  candidates: readonly CatalogueSong[],
  search: { track: string; artist: string },
  duration?: number,
): string {
  if (candidates.length === 0) return "nothing came back";
  const titled = candidates.filter((song) => sameTitle(song.title, search.track));
  const nearly = candidates.filter((song) => nearlySameTitle(song.title, search.track));
  const byArtist = search.artist
    ? candidates.filter((song) => sameArtist(search.artist, song.artist))
    : [];
  const closest = titled[0] ?? nearly[0] ?? byArtist[0] ?? candidates[0];
  const name = `“${closest.title}” by ${closest.artist}`;
  const count = `${candidates.length} ${candidates.length === 1 ? "answer" : "answers"}`;
  const lengthOff = (song: CatalogueSong) =>
    duration !== undefined && song.duration !== undefined
      ? `${Math.round(Math.abs(song.duration - duration))} s ${song.duration > duration ? "longer" : "shorter"}`
      : "and the song's length isn't known";
  if (titled.length > 0 && !search.artist) {
    return `${count}; closest ${name}: the song has no artist to check, and it isn't the same length, ${lengthOff(closest)}`;
  }
  if (titled.length > 0) return `${count}; closest ${name}: a different artist`;
  if (nearly.length > 0 && (!search.artist || sameArtist(search.artist, closest.artist))) {
    return `${count}; closest ${name}: a different version, ${lengthOff(closest)}`;
  }
  if (nearly.length > 0) return `${count}; closest ${name}: a different artist`;
  if (byArtist.length > 0) return `${count}; closest ${name}: a different title`;
  return `${count}, none with that title or artist (first: ${name})`;
}

// --- iTunes ---------------------------------------------------------------------

type ItunesTrack = {
  kind?: unknown;
  trackName?: unknown;
  artistName?: unknown;
  collectionName?: unknown;
  collectionArtistName?: unknown;
  primaryGenreName?: unknown;
  releaseDate?: unknown;
  trackNumber?: unknown;
  trackTimeMillis?: unknown;
  artworkUrl100?: unknown;
};

const str = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
const positive = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
const yearOf = (value: unknown) => {
  const year = Number(/^(\d{4})/.exec(str(value) ?? "")?.[1]);
  return year >= 1000 ? year : undefined;
};
// Apple names a single "Song - Single" and an EP "Name - EP".
const RELEASE_KIND_RE = /\s+-\s+(Single|EP)$/;

/** iTunes' answer as catalogue songs. */
export function itunesSongs(answer: unknown): CatalogueSong[] {
  const results = (answer as { results?: unknown })?.results;
  if (!Array.isArray(results)) return [];
  return (results as ItunesTrack[]).flatMap((r) => {
    const title = str(r?.trackName);
    const artist = str(r?.artistName);
    if (!title || !artist || (r.kind !== undefined && r.kind !== "song")) return [];
    const collection = str(r.collectionName);
    const cover = str(r.artworkUrl100)?.replace(/\/\d+x\d+bb\.jpg$/, "/600x600bb.jpg");
    const millis = typeof r.trackTimeMillis === "number" ? r.trackTimeMillis : undefined;
    const collectionArtist = str(r.collectionArtistName);
    return [
      {
        title,
        artist,
        album: collection?.replace(RELEASE_KIND_RE, ""),
        genre: str(r.primaryGenreName),
        year: yearOf(r.releaseDate),
        track: positive(r.trackNumber),
        duration: millis !== undefined ? millis / 1000 : undefined,
        coverUrl: cover && ITUNES_COVER_RE.test(cover) ? cover : undefined,
        compilation: collectionArtist !== undefined && /various artists/i.test(collectionArtist),
        single: collection !== undefined && RELEASE_KIND_RE.test(collection),
      },
    ];
  });
}

async function searchItunes(search: { track: string; artist: string }) {
  const term = [search.artist, search.track].filter(Boolean).join(" ");
  const params = new URLSearchParams({ term, media: "music", entity: "song", limit: "15" });
  return itunesSongs(await getJson("itunes", `${ITUNES_SEARCH}?${params}`));
}

// --- Deezer ---------------------------------------------------------------------

type DeezerTrack = {
  id?: unknown;
  title?: unknown;
  duration?: unknown;
  artist?: { name?: unknown };
  album?: { id?: unknown; title?: unknown; cover_xl?: unknown };
};

/** Deezer's search answer as catalogue songs (without the album's details: see `deezerDetails`). */
export function deezerSongs(answer: unknown): (CatalogueSong & { id: number; albumId?: number })[] {
  const data = (answer as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  return (data as DeezerTrack[]).flatMap((t) => {
    const title = str(t?.title);
    const artist = str(t?.artist?.name);
    const id = positive(t?.id);
    if (!title || !artist || !id) return [];
    const cover = str(t.album?.cover_xl);
    return [
      {
        id,
        albumId: positive(t.album?.id),
        title,
        artist,
        album: str(t.album?.title),
        duration: typeof t.duration === "number" ? t.duration : undefined,
        coverUrl: cover && DEEZER_COVER_RE.test(cover) ? cover : undefined,
      },
    ];
  });
}

/** What Deezer's song and album pages add: track number, year, genre, and whether it's a compilation. */
export function deezerDetails(track: unknown, album: unknown): Partial<CatalogueSong> {
  const t = (track ?? {}) as { track_position?: unknown; release_date?: unknown };
  const a = (album ?? {}) as {
    genres?: { data?: { name?: unknown }[] };
    release_date?: unknown;
    record_type?: unknown;
  };
  const genres = Array.isArray(a.genres?.data) ? a.genres.data : [];
  return {
    track: positive(t.track_position),
    year: yearOf(a.release_date) ?? yearOf(t.release_date),
    genre: genres.map((g) => str(g?.name)).find(Boolean),
    compilation: a.record_type === "compile",
    single: a.record_type === "single" || a.record_type === "ep",
  };
}

async function searchDeezer(search: { track: string; artist: string }) {
  // Its plain search: its artist:"…" track:"…" syntax finds nothing (seen October 2026).
  const q = [search.artist, search.track].filter(Boolean).join(" ");
  const params = new URLSearchParams({ q, limit: "15" });
  return deezerSongs(await getJson("deezer", `${DEEZER_API}/search?${params}`));
}

// --- Asking -----------------------------------------------------------------------

// When each catalogue said it's busy until (ms since 1970).
const refusedUntil: Record<CatalogueSource, number> = { itunes: 0, deezer: 0 };
// When each catalogue was last asked, oldest first, within its limit's window.
const asked: Record<CatalogueSource, number[]> = { itunes: [], deezer: [] };

/** Counts a request against the catalogue's published limit, or refuses it if that's used up. */
function takeTurn(source: CatalogueSource) {
  const { requests, perMs } = CATALOGUE_LIMITS[source];
  const now = Date.now();
  const times = asked[source];
  while (times.length > 0 && times[0] <= now - perMs) times.shift();
  if (times.length >= requests) throw new Refused(times[0] + perMs);
  times.push(now);
}

/** When a catalogue that refused may be asked again: its Retry-After, else its own window. */
function retryAtFrom(source: CatalogueSource, retryAfter: string | null): number {
  const seconds = Number(retryAfter);
  if (retryAfter && Number.isFinite(seconds)) return Date.now() + seconds * 1000;
  const date = retryAfter ? Date.parse(retryAfter) : NaN;
  return Number.isFinite(date) ? date : Date.now() + CATALOGUE_LIMITS[source].perMs;
}

async function getJson(source: CatalogueSource, url: string): Promise<unknown> {
  takeTurn(source);
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    const reason =
      err instanceof Error && err.name === "TimeoutError" ? "it took too long" : "no connection";
    throw new CatalogueError(reason);
  }
  // iTunes answers a busy spell with 403 (or 429), Deezer with error code 4 in its JSON.
  if (res.status === 429 || (source === "itunes" && res.status === 403)) {
    throw new Refused(retryAtFrom(source, res.headers.get("retry-after")));
  }
  if (!res.ok) throw new CatalogueError(`HTTP ${res.status}`);
  const answer: unknown = await res.json().catch(() => undefined);
  const error = (answer as { error?: { code?: unknown } } | undefined)?.error;
  if (source === "deezer" && error) {
    if (error.code === 4) throw new Refused(retryAtFrom(source, null));
    throw new CatalogueError(`error ${String(error.code)}`);
  }
  if (answer === undefined) throw new CatalogueError("an answer it couldn't read");
  return answer;
}

const sourceName = (source: CatalogueSource) => (source === "itunes" ? "iTunes" : "Deezer");

/**
 * The song in one catalogue, or undefined if it doesn't have it — in which
 * case `notes` says, for each search, why none of the answers was it.
 */
async function lookUpIn(
  source: CatalogueSource,
  song: SongToLookUp,
  notes: string[],
): Promise<CatalogueSong | undefined> {
  const searches = searchesFor(song);
  if (searches.length === 0) notes.push(`${sourceName(source)}: nothing to search by`);
  for (const search of searches) {
    const asked = [search.artist, search.track].filter(Boolean).join(" ");
    if (source === "itunes") {
      const answers = await searchItunes(search);
      const found = pickMatch(answers, search, song.duration);
      if (found) return found;
      notes.push(`iTunes, “${asked}”: ${explainMiss(answers, search, song.duration)}`);
      continue;
    }
    const answers = await searchDeezer(search);
    const found = pickMatch(answers, search, song.duration) as
      ReturnType<typeof deezerSongs>[number] | undefined;
    if (!found) {
      notes.push(`Deezer, “${asked}”: ${explainMiss(answers, search, song.duration)}`);
      continue;
    }
    const [track, album] = await Promise.all([
      getJson("deezer", `${DEEZER_API}/track/${found.id}`),
      found.albumId ? getJson("deezer", `${DEEZER_API}/album/${found.albumId}`) : undefined,
    ]);
    const { id: _id, albumId: _albumId, ...details } = found;
    return { ...details, ...deezerDetails(track, album) };
  }
  return undefined;
}

/** A look-up's answer, and why the song wasn't found (or which catalogue was busy). */
export type CatalogueAnswer = { match: CatalogueMatch | null; notes: string[] };

const cache = new Map<string, CatalogueAnswer>();
const cacheKey = (song: SongToLookUp) =>
  JSON.stringify([song.title.toLowerCase(), song.artist?.toLowerCase() ?? "", song.duration ?? 0]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The song in the catalogues — iTunes, then Deezer — with the catalogue it
 * came from, or null if neither has it. Throws CatalogueError if neither
 * could be asked.
 */
export async function lookUpSong(song: SongToLookUp): Promise<CatalogueMatch | null> {
  return (await lookUpSongNoted(song)).match;
}

/** `lookUpSong()`, with notes on why the song wasn't found: each search and its closest answer. */
export async function lookUpSongNoted(song: SongToLookUp): Promise<CatalogueAnswer> {
  const key = cacheKey(song);
  if (cache.has(key)) return cache.get(key)!;

  const tried = new Set<CatalogueSource>();
  const failures: string[] = [];
  const notes: string[] = [];
  for (;;) {
    const untried = catalogueSources.filter((source) => !tried.has(source));
    if (untried.length === 0) break;
    const open = untried.filter((source) => refusedUntil[source] <= Date.now());
    // The rest are busy: wait for whichever is back first — there's nothing else
    // to ask — unless one has answered (it doesn't have the song) and the rest
    // are busy for longer than a moment.
    if (open.length === 0) {
      const back = Math.min(...untried.map((s) => refusedUntil[s]));
      if (tried.size > 0 && back - Date.now() > SHORT_WAIT_MS) {
        notes.unshift(...untried.map((s) => `${sourceName(s)} was busy, so it wasn't asked`));
        break;
      }
      await sleep(Math.max(0, back - Date.now()));
      continue;
    }
    const source = open[0];
    try {
      const found = await lookUpIn(source, song, notes);
      tried.add(source);
      if (found) {
        const answer = { match: { song: found, source }, notes: [] };
        remember(key, answer);
        return answer;
      }
    } catch (err) {
      if (err instanceof Refused) {
        refusedUntil[source] = Math.max(refusedUntil[source], err.retryAt);
        continue; // the next catalogue, at once
      }
      tried.add(source);
      failures.push(`${sourceName(source)}: ${(err as Error).message}`);
      notes.push(`${sourceName(source)} couldn't be reached (${(err as Error).message})`);
    }
  }
  if (failures.length === catalogueSources.length) {
    throw new CatalogueError(`Couldn't reach the music catalogues (${failures.join("; ")}).`);
  }
  const answer = { match: null, notes };
  // Not remembered when a catalogue was busy or unreachable: it may have the song.
  if (tried.size === catalogueSources.length && failures.length === 0) remember(key, answer);
  return answer;
}

function remember(key: string, answer: CatalogueAnswer) {
  cache.set(key, answer);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
}

/** Forgets the answers and refusals (for tests). */
export function resetCatalogues() {
  cache.clear();
  refusedUntil.itunes = 0;
  refusedUntil.deezer = 0;
  asked.itunes = [];
  asked.deezer = [];
}
