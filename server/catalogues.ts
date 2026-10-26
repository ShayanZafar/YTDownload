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

export const catalogueSources = ["itunes", "deezer", "musicbrainz"] as const;
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
  /** The genre is the artist's (MusicBrainz's tags for the artist), the song itself having none. */
  genreOf?: "artist";
};

/** A catalogue's song, and which catalogue — or, with `otherVersion`, another version's genre. */
export type CatalogueMatch = { song: CatalogueSong; source: CatalogueSource; otherVersion?: true };

/** Neither catalogue could be reached (not "no such song": that's null). */
export class CatalogueError extends Error {}

/** The catalogue said no (it's busy); try it again after `retryAt` (ms since 1970). */
class Refused extends Error {
  /** `paced`: its published limit is used up (we didn't ask), rather than it saying no. */
  constructor(
    readonly retryAt: number,
    readonly paced = false,
  ) {
    super("refused");
  }
}

const ITUNES_SEARCH = "https://itunes.apple.com/search";
const DEEZER_API = "https://api.deezer.com";
const MUSICBRAINZ_SEARCH = "https://musicbrainz.org/ws/2/recording";
const MUSICBRAINZ_ARTIST = "https://musicbrainz.org/ws/2/artist";
// MusicBrainz asks every app to name itself and say where it's from.
const MUSICBRAINZ_USER_AGENT = "YTDownload/1.0 ( https://github.com/ShayanZafar/YTDownload )";
const FETCH_TIMEOUT_MS = 8_000;
const MUSICBRAINZ_TIMEOUT_MS = 20_000;
/** A found song this many seconds longer or shorter than ours is another recording. */
export const SAME_LENGTH_SECONDS = 3;
/** The catalogues' published limits: how many requests in how long. */
export const CATALOGUE_LIMITS: Record<CatalogueSource, { requests: number; perMs: number }> = {
  itunes: { requests: 20, perMs: 60_000 },
  deezer: { requests: 50, perMs: 5_000 },
  musicbrainz: { requests: 1, perMs: 1_000 },
};
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

/** A title's words in order of the alphabet: "Remix (Paul Oakenfold)" is "(Paul Oakenfold Remix)". */
const wordSet = (text: string) => text.split(" ").sort().join(" ");

/** What a file name adds at the end of a title: "Mindfields original", "Heaven Lange Remix 1999". */
const END_WORDS_RE = /\s+(?:(?:19|20)\d{2}|original|official|hq|hd|high quality)$/i;

/** Without END_WORDS_RE's words, however many. */
function withoutEndWords(title: string): string {
  let bare = title.trim();
  for (let before = ""; before !== bare;) {
    before = bare;
    bare = bare.replace(END_WORDS_RE, "").trim();
  }
  return bare;
}

// The same recording's own notes, which one catalogue writes and another doesn't:
// "(Original Mix)", "(Album Version)", "[Amended]", "(Studio Recording)".
const SAME_RECORDING_RE =
  /\s*[([](?:original(?: mix| version)?|album version|amended|clean|studio recording|mono|stereo)[)\]]/gi;

/** A title as compared: "Remix" is "Mix" ("The Thrillseekers Mix", "The Thrillseekers Remix"). */
const compared = (title: string) => plain(title).replace(/\bremix\b/g, "mix");

/**
 * The catalogue's title and ours the same — word for word, in another order,
 * but for spaces ("Kyur4 th Ich") or a letter or two ("Call Me When Your
 * Sober"), never another number ("Part 2") — ours also without a year or
 * "original" at its end.
 */
function sameTitle(theirs: string, ours: string): boolean {
  const clean = (title: string) => cleanSongTitle(title).replace(SAME_RECORDING_RE, "");
  const a = compared(clean(theirs));
  return [compared(clean(ours)), compared(withoutEndWords(clean(ours)))].some(
    (b) =>
      b !== "" &&
      (a === b ||
        wordSet(a) === wordSet(b) ||
        squash(a) === squash(b) ||
        (digitsOf(a) === digitsOf(b) && nearlySpelled(squash(a), squash(b)))),
  );
}

const squash = (text: string) => text.replace(/ /g, "");
const digitsOf = (text: string) => text.replace(/\D/g, "");

/**
 * A title without what versions add — anything in brackets, after a dash,
 * or a year or "Original" at the end: "Heer (Coke Studio Season 8)" → "heer",
 * "Heathen - Live 1978" → "heathen", "Mindfields original" → "mindfields",
 * "Close To Me - T.O.S. - Exclusive" → "close to me".
 */
export function bareTitle(title: string): string {
  let bare = cleanSongTitle(title).replace(/\s*[([][^)\]]*[)\]]/g, " ");
  bare = bare.replace(/\s+[-–—]\s+.*$/, "");
  return withoutEndWords(bare).replace(/\s+/g, " ").trim();
}

const baseTitle = (title: string) => plain(bareTitle(title)) || plain(title);

/**
 * The same title, or the same but for something in brackets ("(Long
 * Version; 2002 Remaster)" against our "(long version)") or spaces
 * ("Kyur4 th Ich") — taken only for a song the same length.
 */
const nearlySameTitle = (a: string, b: string) => squash(baseTitle(a)) === squash(baseTitle(b));

/** How many letters to add, take out or change to make `a` into `b`. */
function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return row[b.length];
}

/** A name spelt a letter out ("Ozzy Osborne" for "Ozzy Osbourne"), or two in a long one. */
const nearlySpelled = (a: string, b: string) =>
  Math.min(a.length, b.length) >= 6 && editDistance(a, b) <= (a.length >= 12 ? 2 : 1);

/**
 * Does a name without a dash between them hold the found song's artist and
 * title ("Michael Jackson Earth Song", "Earth Song Michael Jackson")?
 */
function namesBoth(song: CatalogueSong, name: string): boolean {
  // Ours with or without what versions add ("(Song)", "- Live"), but their title as it is.
  const ours = [plain(cleanSongTitle(name)), baseTitle(name)];
  const title = plain(cleanSongTitle(song.title));
  // The rest of the name, before or after the title, is the artist — or one of them
  // ("Michael Jackson & Paul McCartney Say Say Say" for Paul McCartney's) — or its
  // words are the title's and an artist's, in any order ("Coke Studio Season 8 Sammi
  // Meri Waar Umair Jaswal & Quratulain Balouch").
  const artists = artistNames(song.artist);
  return ours.some((whole) => {
    const rest = whole.startsWith(`${title} `)
      ? whole.slice(title.length + 1)
      : whole.endsWith(` ${title}`)
        ? whole.slice(0, -title.length - 1)
        : undefined;
    return (
      (rest !== undefined && sameArtist(rest, song.artist)) ||
      artists.some((artist) => wordSet(whole) === wordSet(`${title} ${artist}`))
    );
  });
}

/** Each artist a credit names, as compared: "Bob Marley & The Wailers" → both, and all of it. */
function artistNames(credit: string): string[] {
  const parts = credit.split(
    /\s*(?:,|&|;|\+|\/(?=\s)|\band\b|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b|\bx\b|\bvs\.?)\s*/i,
  );
  return [credit, cleanArtist(credit), ...parts].map(plain).filter(Boolean);
}

/**
 * Is one of the found song's artists ours (or the other way round)? Whole
 * names are compared — "Fred & Ginger" isn't "Fred Lark Brown" — spelt the
 * same but for spaces ("ACDC", "AC/DC") or a letter or two ("Ozzy Osborne").
 */
function sameArtist(ours: string, theirs: string): boolean {
  const mine = artistNames(ours);
  const found = artistNames(theirs);
  // "Black White" is "Black And White", "Notorious B.I.G." "The Notorious B.I.G.".
  const squashed = (name: string) => squash(name.replace(/\b(?:and|the)\b/g, ""));
  return mine.some((a) =>
    found.some((b) => a === b || squashed(a) === squashed(b) || nearlySpelled(a, b)),
  );
}

/**
 * Is our "artist" the film or album the song is from? Film songs are named
 * after their film: "Mohabbatein - Pairon Mein Bandhan Hai" is on the album
 * "Mohabbatein (Original Motion Picture Soundtrack)".
 */
function fromAlbum(ours: string, song: CatalogueSong): boolean {
  const album = song.album ? plain(bareTitle(song.album)) : "";
  return (
    album.length >= 4 &&
    album === plain(ours) &&
    // Not someone else's cover of it on an album named after the artist ("Queen (A Tribute)").
    !COVERS_RE.test(`${song.album} ${song.artist}`)
  );
}

const COVERS_RE = /\b(?:tribute|karaoke|covers?|made famous|originally performed|in the style)\b/i;

/** The other way round: "Rebellion - Linkin Park" asked as Linkin Park's "Rebellion". */
const swapped = (search: { track: string; artist: string }) => ({
  track: search.artist,
  artist: search.track,
});

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
      ((sameTitle(song.title, search.track) ||
        (nearlySameTitle(song.title, search.track) && sameLength(song))) &&
        (search.artist
          ? sameArtist(search.artist, song.artist) || fromAlbum(search.artist, song)
          : sameLength(song))) ||
      (!search.artist && namesBoth(song, search.track)),
  );
  const score = (song: CatalogueSong) =>
    (!search.artist || sameArtist(search.artist, song.artist) ? 16 : 0) +
    (sameTitle(song.title, search.track) || namesBoth(song, search.track) ? 8 : 0) +
    (sameLength(song) ? 4 : 0) +
    (song.compilation ? 0 : 2) +
    (song.single ? 0 : 1);
  // A stable sort: equal ones stay in the catalogue's own order.
  return [...ours].sort((a, b) => score(b) - score(a))[0];
}

/** `pickMatch()`, the halves of a name also taken the other way round ("Song - Artist"). */
function pickEither(
  candidates: readonly CatalogueSong[],
  search: { track: string; artist: string },
  duration?: number,
): CatalogueSong | undefined {
  return (
    pickMatch(candidates, search, duration) ??
    (search.artist ? pickMatch(candidates, swapped(search), duration) : undefined)
  );
}

/**
 * Another version of the song — the same artist, the same title but for what
 * versions add ("Breathe (In the Air)" for our "Breathe (In The Air)
 * (Extended)") — for its genre when the catalogues don't have ours.
 */
export function pickVersion(
  candidates: readonly CatalogueSong[],
  search: { track: string; artist: string },
): CatalogueSong | undefined {
  const of = (s: { track: string; artist: string }) =>
    candidates.filter(
      (song) => nearlySameTitle(song.title, s.track) && sameArtist(s.artist, song.artist),
    );
  if (!search.artist) return undefined;
  const versions = [...of(search), ...of(swapped(search))];
  return versions.find((song) => song.genre) ?? versions[0];
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

// --- MusicBrainz ----------------------------------------------------------------

type MusicBrainzRelease = {
  title?: unknown;
  status?: unknown;
  date?: unknown;
  "artist-credit"?: { name?: unknown }[];
  "release-group"?: { "primary-type"?: unknown; "secondary-types"?: unknown };
  media?: { track?: { number?: unknown }[] }[];
};

type MusicBrainzRecording = {
  title?: unknown;
  length?: unknown;
  "first-release-date"?: unknown;
  "artist-credit"?: { name?: unknown; joinphrase?: unknown; artist?: { id?: unknown } }[];
  tags?: { name?: unknown; count?: unknown }[];
  releases?: MusicBrainzRelease[];
};

/** "psy-trance" → "Psy-Trance": MusicBrainz's tags are in small letters. */
const tagAsGenre = (tag: string) =>
  tag.replace(
    /(^|[\s/-])(\p{Ll})/gu,
    (_, before: string, letter: string) => before + letter.toUpperCase(),
  );

/**
 * The release to take a recording's album and track number from: an
 * official album of the artist's own (not a compilation or soundtrack)
 * before anything else, the earliest first.
 */
function ownRelease(releases: MusicBrainzRelease[]): MusicBrainzRelease | undefined {
  const kind = (release: MusicBrainzRelease) => {
    const group = release["release-group"];
    const secondary = Array.isArray(group?.["secondary-types"]) ? group["secondary-types"] : [];
    const various = (release["artist-credit"] ?? []).some((credit) =>
      /^various artists$/i.test(str(credit?.name) ?? ""),
    );
    return {
      album: group?.["primary-type"] === "Album",
      compilation: secondary.length > 0 || various,
    };
  };
  const score = (release: MusicBrainzRelease) => {
    const { album, compilation } = kind(release);
    return (compilation ? 0 : 4) + (album ? 2 : 0) + (release.status === "Official" ? 1 : 0);
  };
  return [...releases].sort(
    (a, b) => score(b) - score(a) || (str(a.date) ?? "9999").localeCompare(str(b.date) ?? "9999"),
  )[0];
}

/** MusicBrainz's search answer as catalogue songs (no covers: it doesn't say which releases have one). */
export function musicBrainzSongs(answer: unknown): (CatalogueSong & { artistId?: string })[] {
  const recordings = (answer as { recordings?: unknown })?.recordings;
  if (!Array.isArray(recordings)) return [];
  return (recordings as MusicBrainzRecording[]).flatMap((r) => {
    const title = str(r?.title);
    const credits = Array.isArray(r?.["artist-credit"]) ? r["artist-credit"] : [];
    const artist = str(
      credits
        .map(
          (credit) =>
            `${str(credit?.name) ?? ""}${typeof credit?.joinphrase === "string" ? credit.joinphrase : ""}`,
        )
        .join(""),
    );
    if (!title || !artist) return [];
    const tags = (Array.isArray(r.tags) ? r.tags : [])
      .filter((tag) => str(tag?.name))
      .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0));
    const release = ownRelease(Array.isArray(r.releases) ? r.releases : []);
    const group = release?.["release-group"];
    const secondary = Array.isArray(group?.["secondary-types"]) ? group["secondary-types"] : [];
    const number = Number(str(release?.media?.[0]?.track?.[0]?.number));
    return [
      {
        title,
        artist,
        album: str(release?.title),
        genre: tags[0] ? tagAsGenre(str(tags[0].name)!) : undefined,
        year: yearOf(r["first-release-date"]) ?? yearOf(release?.date),
        track: positive(number),
        duration: typeof r.length === "number" && r.length > 0 ? r.length / 1000 : undefined,
        compilation:
          secondary.length > 0 ||
          (release?.["artist-credit"] ?? []).some((credit) =>
            /^various artists$/i.test(str(credit?.name) ?? ""),
          ),
        single: group?.["primary-type"] === "Single" || group?.["primary-type"] === "EP",
        artistId: str(credits[0]?.artist?.id),
      },
    ];
  });
}

/** An artist's genre from MusicBrainz's answer for them: their genre counted most, else tag. */
export function musicBrainzArtistGenre(answer: unknown): string | undefined {
  const { genres, tags } = (answer ?? {}) as { genres?: unknown; tags?: unknown };
  const top = (list: unknown) =>
    (Array.isArray(list) ? (list as { name?: unknown; count?: unknown }[]) : [])
      .filter((tag) => str(tag?.name))
      .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))[0];
  const best = top(genres) ?? top(tags);
  return best ? tagAsGenre(str(best.name)!) : undefined;
}

/** The genre of a MusicBrainz artist (its id from a recording's credit), for a recording with none. */
async function genreOfArtist(artistId: string): Promise<string | undefined> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(artistId)) return;
  const params = new URLSearchParams({ inc: "genres+tags", fmt: "json" });
  return musicBrainzArtistGenre(
    await getJson("musicbrainz", `${MUSICBRAINZ_ARTIST}/${artistId}?${params}`),
  );
}

/** A phrase for MusicBrainz's search (Lucene): in quotes, its own quotes and backslashes escaped. */
const phrase = (text: string) => `"${text.replace(/[\\"]/g, "\\$&")}"`;

async function searchMusicBrainz(search: { track: string; artist: string }) {
  const query = [
    `recording:${phrase(search.track)}`,
    search.artist && `artist:${phrase(search.artist)}`,
  ]
    .filter(Boolean)
    .join(" AND ");
  const params = new URLSearchParams({ query, fmt: "json", limit: "15" });
  return musicBrainzSongs(await getJson("musicbrainz", `${MUSICBRAINZ_SEARCH}?${params}`));
}

// --- Asking -----------------------------------------------------------------------

// When each catalogue said it's busy until (ms since 1970).
const refusedUntil: Record<CatalogueSource, number> = { itunes: 0, deezer: 0, musicbrainz: 0 };
// When each catalogue was last asked, oldest first, within its limit's window.
const asked: Record<CatalogueSource, number[]> = { itunes: [], deezer: [], musicbrainz: [] };

/** Counts a request against the catalogue's published limit, or refuses it if that's used up. */
function takeTurn(source: CatalogueSource) {
  const { requests, perMs } = CATALOGUE_LIMITS[source];
  const now = Date.now();
  const times = asked[source];
  while (times.length > 0 && times[0] <= now - perMs) times.shift();
  if (times.length >= requests) throw new Refused(times[0] + perMs, true);
  times.push(now);
}

/** When a catalogue that refused may be asked again: its Retry-After, else its own window. */
function retryAtFrom(source: CatalogueSource, retryAfter: string | null): number {
  const seconds = Number(retryAfter);
  if (retryAfter && Number.isFinite(seconds)) return Date.now() + seconds * 1000;
  const date = retryAfter ? Date.parse(retryAfter) : NaN;
  return Number.isFinite(date) ? date : Date.now() + CATALOGUE_LIMITS[source].perMs;
}

// When MusicBrainz may next be asked (ms since 1970): its turns, one a second, taken in order.
let musicBrainzNext = 0;

/**
 * Waits for MusicBrainz's next turn. It's asked only about songs the other
 * catalogues don't have, so a look-up waits for it rather than give up.
 */
async function musicBrainzTurn() {
  const at = Math.max(Date.now(), musicBrainzNext);
  musicBrainzNext = at + CATALOGUE_LIMITS.musicbrainz.perMs / CATALOGUE_LIMITS.musicbrainz.requests;
  if (at > Date.now()) await sleep(at - Date.now());
}

async function getJson(source: CatalogueSource, url: string): Promise<unknown> {
  if (source === "musicbrainz") await musicBrainzTurn();
  else takeTurn(source);
  let res: Response;
  try {
    res = await fetch(url, {
      // MusicBrainz is often slower to answer (seen taking over 8 s, October 2026).
      signal: AbortSignal.timeout(
        source === "musicbrainz" ? MUSICBRAINZ_TIMEOUT_MS : FETCH_TIMEOUT_MS,
      ),
      ...(source === "musicbrainz" && { headers: { "User-Agent": MUSICBRAINZ_USER_AGENT } }),
    });
  } catch (err) {
    const reason =
      err instanceof Error && err.name === "TimeoutError" ? "it took too long" : "no connection";
    throw new CatalogueError(reason);
  }
  // iTunes answers a busy spell with 403 (or 429), MusicBrainz with 503, Deezer with
  // error code 4 in its JSON.
  if (
    res.status === 429 ||
    (source === "itunes" && res.status === 403) ||
    (source === "musicbrainz" && res.status === 503)
  ) {
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

export const sourceName = (source: CatalogueSource) =>
  source === "itunes" ? "iTunes" : source === "deezer" ? "Deezer" : "MusicBrainz";

/** A catalogue's answer as it came, with the ids that say where to ask for more. */
type Answer = CatalogueSong & { id?: number; albumId?: number; artistId?: string };

/** Another version of a song, from one catalogue's answers (`pickVersion()`). */
type Version = { song: Answer; source: CatalogueSource };

const searchIn = (source: CatalogueSource, search: { track: string; artist: string }) =>
  source === "itunes"
    ? searchItunes(search)
    : source === "deezer"
      ? searchDeezer(search)
      : searchMusicBrainz(search);

/**
 * The song in one catalogue, or undefined if it doesn't have it — in which
 * case `notes` says, for each search, why none of the answers was it, and
 * `versions` gets another version of it that one had (for its genre).
 * `wantsGenre`: a song MusicBrainz has without a genre gets its artist's.
 */
async function lookUpIn(
  source: CatalogueSource,
  song: SongToLookUp,
  notes: string[],
  versions: Version[],
  wantsGenre: boolean,
): Promise<CatalogueSong | undefined> {
  const searches = searchesFor(song);
  const tagged = song.artist?.trim() ? cleanArtist(song.artist) : undefined;
  if (searches.length === 0) notes.push(`${sourceName(source)}: nothing to search by`);
  for (const search of searches) {
    const asked = [search.artist, search.track].filter(Boolean).join(" ");
    let answers: Answer[] = await searchIn(source, search);
    let found: Answer | undefined = pickEither(answers, search, song.duration);
    // iTunes is asked once a search: it allows the fewest (20 a minute). Deezer's plain
    // search finds nothing for a title with words in brackets its own title hasn't got
    // ("(extended version)", seen October 2026), and finds others for one with words it
    // has never heard of ("Soap Box (prod. Saba & Phoelix)"); MusicBrainz's search for
    // the title as a phrase can't: then each is asked without them, nor what else versions
    // add ("- Live 1978").
    const bare = bareTitle(search.track);
    const again = source === "deezer" ? !found : answers.length === 0;
    if (source !== "itunes" && again && bare && bare !== search.track) {
      answers = [...answers, ...(await searchIn(source, { ...search, track: bare }))];
      found = pickEither(answers, search, song.duration);
    }
    // MusicBrainz searches title and artist apart: a name's halves the other way round
    // ("Rebellion - Linkin Park") are another search.
    if (source === "musicbrainz" && !found && search.artist && search.artist !== tagged) {
      answers = [...answers, ...(await searchIn(source, swapped(search)))];
      found = pickEither(answers, search, song.duration);
    }
    if (!found) {
      notes.push(
        `${sourceName(source)}, “${asked}”: ${explainMiss(answers, search, song.duration)}`,
      );
      const version = pickVersion(answers, search);
      if (version) versions.push({ song: version, source });
      continue;
    }
    const { id, albumId, artistId, ...details } = found;
    if (source === "deezer" && id !== undefined) {
      const [track, album] = await Promise.all([
        getJson("deezer", `${DEEZER_API}/track/${id}`),
        albumId ? getJson("deezer", `${DEEZER_API}/album/${albumId}`) : undefined,
      ]);
      return { ...details, ...deezerDetails(track, album) };
    }
    if (source === "musicbrainz" && wantsGenre && !details.genre && artistId) {
      const genre = await genreOfArtist(artistId);
      if (genre) return { ...details, genre, genreOf: "artist" };
    }
    return details;
  }
  return undefined;
}

/** The genre of another version of the song: its own, its album's (Deezer) or its artist's (MusicBrainz). */
async function genreOfVersion({ song, source }: Version): Promise<string | undefined> {
  if (song.genre) return song.genre;
  if (source === "deezer" && song.albumId) {
    return deezerDetails({}, await getJson("deezer", `${DEEZER_API}/album/${song.albumId}`)).genre;
  }
  if (source === "musicbrainz" && song.artistId) return genreOfArtist(song.artistId);
  return undefined;
}

/** The details a look-up can ask for (`lookUpSongNoted()`'s `needs`). */
export type CatalogueDetail =
  "title" | "artist" | "album" | "genre" | "year" | "track" | "coverUrl";

/** A look-up's answer, and why the song wasn't found (or which catalogue was busy). */
export type CatalogueAnswer = {
  match: CatalogueMatch | null;
  notes: string[];
  /** Not found, and every catalogue answered (none was busy or out of reach): none has it. */
  noneHasIt?: boolean;
};

const cache = new Map<string, CatalogueAnswer>();
const cacheKey = (song: SongToLookUp) =>
  JSON.stringify([song.title.toLowerCase(), song.artist?.toLowerCase() ?? "", song.duration ?? 0]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The song in the catalogues — iTunes, then Deezer, then MusicBrainz — with
 * the catalogue it came from, or null if none has it. Throws CatalogueError if
 * none could be asked.
 */
export async function lookUpSong(song: SongToLookUp): Promise<CatalogueMatch | null> {
  return (await lookUpSongNoted(song)).match;
}

/** `lookUpSong()`, with notes on why the song wasn't found: each search and its closest answer. */
export async function lookUpSongNoted(
  song: SongToLookUp,
  needs?: readonly CatalogueDetail[],
): Promise<CatalogueAnswer> {
  const key = JSON.stringify([cacheKey(song), needs ?? []]);
  // With `needs`, every catalogue is asked in turn until one has all of them,
  // and the one with the most is used (the earlier one when two have as many);
  // one that has the song but none of them is passed over.
  const has = (found: CatalogueSong) =>
    needs ? needs.filter((need) => found[need] !== undefined).length : 1;
  if (cache.has(key)) return cache.get(key)!;
  let best: { match: CatalogueMatch; has: number } | undefined;
  const answerWith = (match: CatalogueMatch, complete: boolean) => {
    const answer = { match, notes: [] };
    if (complete) remember(key, answer);
    return answer;
  };

  const tried = new Set<CatalogueSource>();
  // Refused this look-up again after its time was up, or busy for longer than its own
  // limit's window: not asked.
  const busy = new Set<CatalogueSource>();
  const refusals: Record<CatalogueSource, number> = { itunes: 0, deezer: 0, musicbrainz: 0 };
  const failures: string[] = [];
  const notes: string[] = [];
  const versions: Version[] = [];
  const wantsGenre = !needs || needs.includes("genre");
  for (;;) {
    const untried = catalogueSources.filter((source) => !tried.has(source) && !busy.has(source));
    if (untried.length === 0) break;
    const open = untried.filter((source) => refusedUntil[source] <= Date.now());
    // The rest are busy, and there's nothing else to ask: wait for whichever is back
    // first — iTunes' turn, say, for a song Deezer and MusicBrainz don't have.
    if (open.length === 0) {
      for (const source of untried) {
        if (refusedUntil[source] - Date.now() > CATALOGUE_LIMITS[source].perMs) busy.add(source);
      }
      const waiting = untried.filter((source) => !busy.has(source));
      if (waiting.length === 0) continue;
      await sleep(Math.max(0, Math.min(...waiting.map((s) => refusedUntil[s])) - Date.now()));
      continue;
    }
    const source = open[0];
    const noted = notes.length;
    const versionsBefore = versions.length;
    try {
      const found = await lookUpIn(source, song, notes, versions, wantsGenre);
      tried.add(source);
      if (found && has(found) === 0) {
        notes.push(
          `${sourceName(source)} has it (“${found.title}” by ${found.artist}) but not what it lacks`,
        );
      } else if (found) {
        if (!best || has(found) > best.has)
          best = { match: { song: found, source }, has: has(found) };
        if (!needs || best.has === needs.length) return answerWith(best.match, true);
      }
    } catch (err) {
      if (err instanceof Refused) {
        notes.length = noted; // it'll be asked again from the start
        versions.length = versionsBefore;
        refusedUntil[source] = Math.max(refusedUntil[source], err.retryAt);
        // A catalogue that says no again once its time is up is having a busy spell.
        if (!err.paced && ++refusals[source] >= 2) busy.add(source);
        continue; // the next catalogue, at once
      }
      tried.add(source);
      failures.push(`${sourceName(source)}: ${(err as Error).message}`);
      notes.push(`${sourceName(source)} couldn't be reached (${(err as Error).message})`);
    }
  }
  notes.unshift(...[...busy].map((s) => `${sourceName(s)} was busy, so it wasn't asked`));
  const complete = tried.size === catalogueSources.length && !failures.length;
  // Remembered only when every catalogue answered: one that was busy may have had more.
  if (best) return answerWith(best.match, complete);
  // None has the song, but one has another version of it ("(Radio Edit)" for our
  // "(Extended Mix)"): its genre, which is the song's too — and nothing else.
  if (wantsGenre) {
    for (const version of versions) {
      const genre = await genreOfVersion(version).catch(() => undefined);
      if (!genre) continue;
      const { title, artist } = version.song;
      return answerWith(
        { song: { title, artist, genre }, source: version.source, otherVersion: true },
        complete,
      );
    }
  }
  if (failures.length === catalogueSources.length) {
    throw new CatalogueError(`Couldn't reach the music catalogues (${failures.join("; ")}).`);
  }
  const answer = { match: null, notes, noneHasIt: complete };
  // Not remembered when a catalogue was busy or unreachable: it may have the song.
  if (complete) remember(key, answer);
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
  refusedUntil.musicbrainz = 0;
  asked.itunes = [];
  asked.deezer = [];
  asked.musicbrainz = [];
  musicBrainzNext = 0;
}
