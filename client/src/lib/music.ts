/**
 * The music player's songs, as plain data: the songs in the "Save to" folder
 * (played through the app, on the computer it runs on) and songs picked on
 * this device (played straight from it — they never leave it). Sorting and
 * filtering them, and which song comes next.
 */
import { api, buildUrl } from "@shared/routes";
import { AUDIO_TYPES, audioTypeOf, songNameOf } from "@shared/audio-types";
import { musicLibrarySchema, type MusicLibrary, type MusicTrack } from "@shared/schema";
import { searchableText } from "@/lib/history-filter";
import { requestJson } from "@/lib/save-to-folder";

/** A song the player can play. */
export type PlayerTrack = {
  /** Unique among the player's songs. */
  key: string;
  title: string;
  artist: string | null;
  album: string | null;
  /** Its genre tags, each once. */
  genres: string[];
  /** The year its tags give, if any. */
  year: number | null;
  /** Length in seconds, when known. */
  duration: number | null;
  /** Its file: where it is in the folder, or its name. */
  fileName: string;
  /** When it arrived (ms since 1970), for "Recently added". */
  addedAt: number;
  /** What to ask `canPlayType()` about it ("" when the kind of file is unknown). */
  check: string;
} & (
  | { source: "folder"; id: string }
  | {
      source: "device";
      file: File;
      /** False until its tags have been read (the title is the file name until then). */
      tagsRead: boolean;
    }
);

// --- The "Save to" folder's songs --------------------------------------------------

/** The songs in the "Save to" folder (a browser on the computer running the app only). */
export function fetchMusicLibrary(signal?: AbortSignal): Promise<MusicLibrary> {
  return requestJson(musicLibrarySchema, api.music.list.path, { signal });
}

export function folderTrack(track: MusicTrack): PlayerTrack {
  return {
    key: `folder:${track.id}`,
    source: "folder",
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    genres: track.genres,
    year: track.year,
    duration: track.duration,
    fileName: track.path,
    addedAt: Date.parse(track.addedAt) || 0,
    check: audioTypeOf(track.path)?.check ?? "",
  };
}

/** A folder song's file, untouched. */
export const folderSongUrl = (id: string) => buildUrl(api.music.audio.path, { id });
/** A folder song converted to FLAC by the app (lossless), for a browser that can't play the file. */
export const folderSongFlacUrl = (id: string) => buildUrl(api.music.flac.path, { id });
/** A folder song's cover picture (the address answers 204 when there's none). */
export const folderSongCoverUrl = (id: string) => buildUrl(api.music.cover.path, { id });

// --- Songs picked on this device ----------------------------------------------------------

/** What the file picker offers: audio files, plus the kinds a phone may not know are audio. */
export const AUDIO_FILE_ACCEPT = ["audio/*", ...Object.keys(AUDIO_TYPES)].join(",");

/** Is this picked file a song? */
export const isAudioFile = (file: File) =>
  audioTypeOf(file.name) !== undefined || file.type.startsWith("audio/");

/** A song picked on this device, named after its file until its tags are read. */
export function deviceTrack(file: File): PlayerTrack {
  // Picked with its folder: "Music/Queen/Bohemian Rhapsody.mp3".
  const fileName = file.webkitRelativePath || file.name;
  return {
    key: `device:${fileName}:${file.size}:${file.lastModified}`,
    source: "device",
    file,
    tagsRead: false,
    title: songNameOf(file.name),
    artist: null,
    album: null,
    genres: [],
    year: null,
    duration: null,
    fileName,
    addedAt: file.lastModified,
    check: audioTypeOf(file.name)?.check ?? (file.type.startsWith("audio/") ? file.type : ""),
  };
}

// --- Sorting and filtering ----------------------------------------------------------

export const musicSorts = ["added", "title", "artist"] as const;
export type MusicSort = (typeof musicSorts)[number];

export const musicSortLabels: Record<MusicSort, string> = {
  added: "Recently added",
  title: "Title",
  artist: "Artist",
};

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
const compareText = (a: string | null, b: string | null) =>
  // Songs with nothing to sort by go last.
  a === b ? 0 : a === null ? 1 : b === null ? -1 : collator.compare(a, b);

/** The songs in this order: newest first, by title, or by artist (then album, then title). */
export function sortTracks(tracks: readonly PlayerTrack[], sort: MusicSort): PlayerTrack[] {
  const byTitle = (a: PlayerTrack, b: PlayerTrack) => collator.compare(a.title, b.title);
  const compare: Record<MusicSort, (a: PlayerTrack, b: PlayerTrack) => number> = {
    added: (a, b) => b.addedAt - a.addedAt || byTitle(a, b),
    title: (a, b) => byTitle(a, b) || compareText(a.artist, b.artist),
    artist: (a, b) =>
      compareText(a.artist, b.artist) || compareText(a.album, b.album) || byTitle(a, b),
  };
  return [...tracks].sort(compare[sort]);
}

/** The songs with every word typed in their title, artist, album, genre, year or file name (partial words too). */
export function filterTracks(tracks: readonly PlayerTrack[], query: string): PlayerTrack[] {
  const words = searchableText(query).split(" ").filter(Boolean);
  if (words.length === 0) return [...tracks];
  return tracks.filter((track) => {
    const text = searchableText(
      [track.title, track.artist, track.album, ...track.genres, track.year, track.fileName]
        .filter(Boolean)
        .join(" "),
    );
    return words.every((word) => text.includes(word));
  });
}

// --- Filtering by genre, artist, album, year ----------------------------------------

/** What the list can be filtered by, from the songs' tags. */
export const musicFacets = ["genre", "artist", "album", "year"] as const;
export type MusicFacet = (typeof musicFacets)[number];

export const facetLabels: Record<MusicFacet, { name: string; all: string; none: string }> = {
  genre: { name: "Genre", all: "All genres", none: "No genre" },
  artist: { name: "Artist", all: "All artists", none: "No artist" },
  album: { name: "Album", all: "All albums", none: "No album" },
  year: { name: "Year", all: "All years", none: "No year" },
};

/** The filter's choice for songs with nothing for it (no genre tag, say). */
export const NO_VALUE = "";

/** The values a song has for a filter: its genres, its artists ("A, B" is both), its album or year. */
export function facetValues(track: PlayerTrack, facet: MusicFacet): string[] {
  if (facet === "genre") return track.genres;
  if (facet === "artist") return (track.artist ?? "").split(/\s*,\s*/).filter(Boolean);
  if (facet === "album") return track.album ? [track.album] : [];
  return track.year ? [String(track.year)] : [];
}

const valueKey = (value: string) => value.toLocaleLowerCase();

/**
 * A filter's values with how many songs have each — genres the most common
 * first, years the newest first, artists and albums A–Z — and how many songs
 * have none. "rock" and "Rock" are one, named as most songs spell it.
 */
export function facetCounts(
  tracks: readonly PlayerTrack[],
  facet: MusicFacet,
): { values: { value: string; count: number }[]; none: number } {
  const byKey = new Map<string, { count: number; spellings: Map<string, number> }>();
  let none = 0;
  for (const track of tracks) {
    const values = facetValues(track, facet);
    if (values.length === 0) none++;
    const seen = new Set<string>();
    for (const value of values) {
      const key = valueKey(value);
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = byKey.get(key) ?? { count: 0, spellings: new Map<string, number>() };
      entry.count++;
      entry.spellings.set(value, (entry.spellings.get(value) ?? 0) + 1);
      byKey.set(key, entry);
    }
  }
  const values = Array.from(byKey.values()).map(({ count, spellings }) => ({
    value: Array.from(spellings).sort((a, b) => b[1] - a[1])[0][0],
    count,
  }));
  const order: Record<MusicFacet, (a: (typeof values)[0], b: (typeof values)[0]) => number> = {
    genre: (a, b) => b.count - a.count || collator.compare(a.value, b.value),
    artist: (a, b) => collator.compare(a.value, b.value),
    album: (a, b) => collator.compare(a.value, b.value),
    year: (a, b) => Number(b.value) - Number(a.value),
  };
  return { values: values.sort(order[facet]), none };
}

/** What each filter is set to: a value, or NO_VALUE for songs with none; unset shows them all. */
export type MusicFilters = Partial<Record<MusicFacet, string>>;

/** The songs every filter set lets through (any spelling of a value). */
export function filterByFacets(
  tracks: readonly PlayerTrack[],
  filters: MusicFilters,
): PlayerTrack[] {
  const set = musicFacets.filter((facet) => filters[facet] !== undefined);
  if (set.length === 0) return [...tracks];
  return tracks.filter((track) =>
    set.every((facet) => {
      const values = facetValues(track, facet);
      const wanted = filters[facet]!;
      return wanted === NO_VALUE
        ? values.length === 0
        : values.some((value) => valueKey(value) === valueKey(wanted));
    }),
  );
}

// --- A playlist's songs in the folder -----------------------------------------------

/**
 * A playlist's songs that are in the "Save to" folder, as the player's songs,
 * in the playlist's order: `found` says which file each song is (from
 * `POST /api/folders/songs`), `folderTracks` are the folder's songs. Each file
 * comes once, though a playlist can have a song twice.
 */
export function playlistQueue(
  songs: readonly { id: string }[],
  found: Readonly<Record<string, { file: string }>>,
  folderTracks: readonly PlayerTrack[],
): PlayerTrack[] {
  const byFile = new Map(folderTracks.map((track) => [track.fileName, track]));
  const queue: PlayerTrack[] = [];
  const added = new Set<string>();
  for (const song of songs) {
    const file = found[song.id]?.file;
    const track = file !== undefined ? byFile.get(file) : undefined;
    if (!track || added.has(track.key)) continue;
    added.add(track.key);
    queue.push(track);
  }
  return queue;
}

// --- What plays next ------------------------------------------------------------------

export const repeatModes = ["off", "all", "one"] as const;
export type Repeat = (typeof repeatModes)[number];

/**
 * The songs' places in the queue in a random order, `first` first (the song
 * that's playing, or was clicked). `random` is there for tests.
 */
export function shuffledOrder(length: number, first: number, random = Math.random): number[] {
  const rest = Array.from({ length }, (_, i) => i).filter((i) => i !== first);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return first >= 0 && first < length ? [first, ...rest] : rest;
}

/**
 * Where to go after the song at `position` in the play order: when it ends
 * on its own, or Next is pressed (`skip`). Null means stop. Repeat one plays
 * the song again when it ends, but Next still moves on.
 */
export function nextPosition(
  position: number,
  length: number,
  repeat: Repeat,
  { skip = false } = {},
): number | null {
  if (length === 0) return null;
  if (repeat === "one" && !skip) return position;
  if (position + 1 < length) return position + 1;
  return repeat === "off" ? null : 0;
}

/** Where Previous goes: the song before (round to the last one when repeating), else this one. */
export function previousPosition(position: number, length: number, repeat: Repeat): number {
  if (position > 0) return position - 1;
  return repeat !== "off" && length > 0 ? length - 1 : 0;
}

/** Previous restarts the song once it has played this long (seconds), like most players. */
export const RESTART_AFTER_SECONDS = 3;

/**
 * Did a seek run off the end of the file? A file cut short (a download that
 * stopped part-way) still says how long the whole song is, but has nothing
 * after where it stops: asked for a place past that, the browser lands at the
 * very end and the song "ends" — which isn't the song finishing, so the next
 * one mustn't start. Seconds, all three; asking for the last second is just
 * going to the end.
 */
export function seekRanOffTheEnd(asked: number, landed: number, duration: number): boolean {
  if (!Number.isFinite(duration) || duration <= 0) return false;
  return asked < duration - 1 && landed >= duration - 0.5;
}

// --- The queue ----------------------------------------------------------------------

/** The player's songs: each song once, and the order they play in. */
export type Queue = {
  tracks: PlayerTrack[];
  /** The tracks' places in play order: as listed, or shuffled. */
  order: number[];
  /** Where in `order` the current song is. */
  position: number;
};

export const EMPTY_QUEUE: Queue = { tracks: [], order: [], position: 0 };

/** The song playing (or paused), if any. */
export const currentOf = (queue: Queue): PlayerTrack | undefined =>
  queue.tracks[queue.order[queue.position]];

/** The songs after the current one, in play order, with their places in it. */
export function upNext(queue: Queue): { track: PlayerTrack; position: number }[] {
  return queue.order
    .slice(queue.position + 1)
    .map((index, i) => ({ track: queue.tracks[index], position: queue.position + 1 + i }));
}

/** The queue without the song at `position` in play order (never the current song). */
export function queueWithout(queue: Queue, position: number): Queue {
  const index = queue.order[position];
  if (position === queue.position || index === undefined) return queue;
  return {
    tracks: queue.tracks.filter((_, i) => i !== index),
    order: queue.order.filter((_, p) => p !== position).map((i) => (i > index ? i - 1 : i)),
    position: position < queue.position ? queue.position - 1 : queue.position,
  };
}

/** The queue with nothing after the current song. */
export function queueUntilCurrent(queue: Queue): Queue {
  let q = queue;
  for (let p = q.order.length - 1; p > q.position; p--) q = queueWithout(q, p);
  return q;
}

/**
 * The queue with `songs` added: right after the current song ("next", in
 * the order given) or at the end ("last"). A song already in the queue moves
 * there instead of playing twice; the current song stays where it is. The
 * songs go in the listed order at the same place too, so turning shuffle off
 * keeps them where they were put.
 */
export function queueWith(
  queue: Queue,
  songs: readonly PlayerTrack[],
  where: "next" | "last",
): Queue {
  let q = queue;
  let added = 0;
  for (const song of songs) {
    const current = currentOf(q);
    if (current?.key === song.key) continue;
    const already = q.tracks.findIndex((track) => track.key === song.key);
    if (already !== -1) q = queueWithout(q, q.order.indexOf(already));
    const at = where === "next" ? Math.min(q.position + 1 + added, q.order.length) : q.order.length;
    // In the listed songs, right after the one it follows in play order.
    const index = at === 0 ? 0 : q.order[at - 1] + 1;
    const order = q.order.map((i) => (i >= index ? i + 1 : i));
    order.splice(at, 0, index);
    q = {
      tracks: [...q.tracks.slice(0, index), song, ...q.tracks.slice(index)],
      order,
      position: q.position,
    };
    added += 1;
  }
  return q;
}
