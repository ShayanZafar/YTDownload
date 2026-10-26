/**
 * The details a download is tagged with beyond what its source gives: the
 * song looked up in the music catalogues (iTunes, then Deezer: catalogues.ts)
 * while it downloads, for its genre — which neither YouTube, SoundCloud nor
 * Spotify give — and, for a song that came without an album, the album, year
 * and track number (one release's, together), and a cover for one without.
 *
 * Nothing the source gave is replaced. And the look-up can never hold up or
 * break a download: it starts the moment the source has said what the song is,
 * an MP3's tag waits for it only until the first audio is ready (so it usually
 * costs nothing), and an answer that's slow (DETAILS_WAIT_MS), empty or a
 * failure means the file is tagged just as it would have been without it.
 */
import { lookUpSong, type CatalogueMatch } from "./catalogues";
import { fetchCover } from "./cover";
import type { SongToLookUp } from "./lyrics";
import type { SongTags } from "./tags";

/** The longest a download waits for the catalogues' answer, from when it asked. */
export const DETAILS_WAIT_MS = 5_000;

/** What the catalogues add to a download's tags. */
export type CatalogueTags = Pick<SongTags, "genre" | "album" | "date" | "track">;

/** What a download gets from the catalogues: tags, a cover if it had none, and why nothing if so. */
export type LateDetails = { tags: CatalogueTags; cover?: Buffer; why?: string };

/** What the look-up found to add, and, when nothing, why. */
type LookedUp = { tags: CatalogueTags; coverUrl?: string; why?: string };

/**
 * The catalogue's details that `tags` lack: its genre, and its album, year
 * and track number only for a song without an album (so they're all one
 * release's). Never a title or artist.
 */
export function catalogueTagsFor(tags: SongTags, match: CatalogueMatch | null): CatalogueTags {
  if (!match) return {};
  const { song } = match;
  const found: CatalogueTags = {};
  if (!tags.genre?.trim() && song.genre) found.genre = song.genre;
  if (!tags.album?.trim() && song.album) {
    found.album = song.album;
    if (!tags.date && song.year) found.date = String(song.year);
    if (!tags.track && song.track) found.track = song.track;
  }
  return found;
}

/**
 * Starts looking the download up in the catalogues: by its title and artist
 * (Spotify's, for a Spotify song) and the length the source gave. Resolves
 * within DETAILS_WAIT_MS with what to add — nothing, if it's slow or fails —
 * and never rejects.
 */
export function lookUpDownload(
  tags: SongTags,
  duration: number | undefined,
  {
    lookUp = lookUpSong,
    waitMs = DETAILS_WAIT_MS,
  }: { lookUp?: (song: SongToLookUp) => Promise<CatalogueMatch | null>; waitMs?: number } = {},
): Promise<LookedUp> {
  const found: Promise<LookedUp> = Promise.resolve()
    .then(() => lookUp({ title: tags.title, artist: tags.artist, duration }))
    .then(
      (match) => ({
        tags: catalogueTagsFor(tags, match),
        coverUrl: match?.song.coverUrl,
        ...(match ? {} : { why: "not found in iTunes, Deezer or MusicBrainz" }),
      }),
      (err: unknown) => ({ tags: {}, why: err instanceof Error ? err.message : String(err) }),
    );
  return within(found, waitMs, { tags: {}, why: `no answer within ${waitMs / 1000} s` });
}

/** `promise`, or `fallback` if it takes longer than `ms` or fails. */
function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise.catch(() => fallback), timeout]).finally(() => clearTimeout(timer));
}

/**
 * The catalogues' details for a download, with their cover when the download
 * has none of its own (`hasCover`), waited for DETAILS_WAIT_MS at most. Never
 * rejects.
 */
export async function lateDetails(
  lookedUp: Promise<LookedUp>,
  hasCover: boolean,
  { getCover, waitMs = DETAILS_WAIT_MS }: { getCover?: typeof fetchCover; waitMs?: number } = {},
): Promise<LateDetails> {
  const { tags, coverUrl, why } = await within<LookedUp>(lookedUp, waitMs, {
    tags: {},
    why: `no answer within ${waitMs / 1000} s`,
  });
  if (hasCover || !coverUrl) return why ? { tags, why } : { tags };
  const fetching = Promise.resolve().then(() =>
    (getCover ?? fetchCover)({ kind: "catalogue", url: coverUrl }),
  );
  const cover = await within(fetching, waitMs, undefined);
  return cover ? { tags, cover } : { tags };
}
