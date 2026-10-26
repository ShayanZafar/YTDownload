/**
 * "Fill in details" for the songs in the Save to folder: each song is looked
 * up (what it lacks, and what the music catalogues have for it — nothing is
 * written), the person checks the matches, and the ones they keep are
 * written into the files. As many songs at once as the app's computer has CPU
 * cores (`cpuCores` in GET /api/settings), the next started the moment one is
 * done.
 */
import { api, buildUrl } from "@shared/routes";
import {
  songDetailsWrittenSchema,
  songLookupSchema,
  type SongDetails,
  type SongDetailsWritten,
  type SongLookup,
} from "@shared/schema";
import { requestJson } from "@/lib/save-to-folder";

/** What a folder song lacks, and what the catalogues found for it. */
export function lookUpSongDetails(id: string, signal?: AbortSignal): Promise<SongLookup> {
  return requestJson(songLookupSchema, buildUrl(api.music.lookUpDetails.path, { id }), { signal });
}

/** Writes the details a folder song still lacks into its file. */
export function writeSongDetails(
  id: string,
  details: SongDetails,
  signal?: AbortSignal,
): Promise<SongDetailsWritten> {
  return requestJson(songDetailsWrittenSchema, buildUrl(api.music.writeDetails.path, { id }), {
    method: api.music.writeDetails.method,
    json: details,
    signal,
  });
}

/**
 * Runs `fn` on every item, `atOnce` at a time, each next one started the
 * moment one is done; stops starting new ones once `signal` is aborted.
 */
export async function eachAtOnce<T>(
  items: readonly T[],
  fn: (item: T) => Promise<void>,
  atOnce: number,
  signal?: AbortSignal,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !signal?.aborted) await fn(items[next++]);
  };
  const width = Math.min(Math.max(1, Math.floor(atOnce) || 1), items.length);
  await Promise.all(Array.from({ length: width }, worker));
}

/** The details found, as the review lists them: "Genre: Rock", "1987", "Cover"… */
export function detailLabels(found: SongDetails): string[] {
  const labels: string[] = [];
  if (found.title) labels.push(`Title: ${found.title}`);
  if (found.artist) labels.push(`Artist: ${found.artist}`);
  if (found.genre) labels.push(`Genre: ${found.genre}`);
  if (found.album) labels.push(`Album: ${found.album}`);
  if (found.year) labels.push(String(found.year));
  if (found.track) labels.push(`Track ${found.track}`);
  if (found.coverUrl) labels.push("Cover");
  return labels;
}

export const catalogueName = (source: SongLookup["source"]) =>
  source === "deezer" ? "Deezer" : source === "musicbrainz" ? "MusicBrainz" : "iTunes";

/** Where what was found came from: "found on Deezer", "from its file name", "guessed from the artist". */
export const foundWhere = (source: SongLookup["source"]) =>
  source === "name"
    ? "from its file name"
    : source === "artist"
      ? "guessed from the artist"
      : `found on ${catalogueName(source)}`;
