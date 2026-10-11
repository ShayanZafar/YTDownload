/**
 * The playlists (and albums) opened in the playlist panel lately, newest
 * first, so one can be opened again with a click. This browser remembers them
 * (localStorage); nothing is sent anywhere.
 */
import { z } from "zod";
import { playlistSources, type SpotifyPlaylist } from "@shared/schema";

export const recentPlaylistSchema = z.object({
  /** The link it was opened with (what opening it again uses). */
  link: z.string(),
  source: z.enum(playlistSources),
  kind: z.enum(["playlist", "album"]),
  id: z.string(),
  name: z.string(),
  by: z.string().nullable(),
  image: z.string().nullable(),
  /** How many songs it had when last opened. */
  songs: z.number(),
});

export type RecentPlaylist = z.infer<typeof recentPlaylistSchema>;

/** How many are remembered. */
export const MAX_RECENT_PLAYLISTS = 12;

/** The same playlist, whichever link opened it ("?si=…" and all). */
const sameAs = (a: RecentPlaylist, b: RecentPlaylist) =>
  a.source === b.source && a.kind === b.kind && a.id === b.id;

export function recentPlaylistOf(link: string, playlist: SpotifyPlaylist): RecentPlaylist {
  return {
    link,
    source: playlist.source,
    kind: playlist.kind,
    id: playlist.id,
    name: playlist.name,
    by: playlist.by,
    image: playlist.image,
    songs: playlist.tracks.length,
  };
}

/** The list with `entry` first (once), and at most `MAX_RECENT_PLAYLISTS` long. */
export function rememberPlaylist(
  list: readonly RecentPlaylist[],
  entry: RecentPlaylist,
): RecentPlaylist[] {
  return [entry, ...list.filter((other) => !sameAs(other, entry))].slice(0, MAX_RECENT_PLAYLISTS);
}

/** The list without the playlist opened with `link` (or the same playlist by another link). */
export function forgetPlaylist(list: readonly RecentPlaylist[], link: string): RecentPlaylist[] {
  const entry = list.find((other) => other.link === link);
  return list.filter((other) => other.link !== link && !(entry && sameAs(other, entry)));
}

/** What was stored, read back: entries that don't look right are left out. */
export function parseRecentPlaylists(stored: string | null): RecentPlaylist[] {
  if (!stored) return [];
  let data: unknown;
  try {
    data = JSON.parse(stored);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  return data
    .map((item) => recentPlaylistSchema.safeParse(item))
    .filter((result) => result.success)
    .map((result) => result.data)
    .slice(0, MAX_RECENT_PLAYLISTS);
}
