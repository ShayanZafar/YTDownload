import { useQuery } from "@tanstack/react-query";
import { api } from "@shared/routes";
import type { PlayerTrack } from "@/lib/music";
import { requestJson } from "@/lib/save-to-folder";

/** What to ask the app for a song's lyrics: its title, artist and length. */
export function lyricsQuery(track: Pick<PlayerTrack, "title" | "artist" | "duration">) {
  const params: Record<string, string> = { title: track.title };
  if (track.artist) params.artist = track.artist;
  if (track.duration && track.duration > 0) params.duration = String(Math.round(track.duration));
  return params;
}

/**
 * The lyrics of the song playing (from LRCLIB, through the app), while the
 * lyrics panel is open. Looked up once per song: they don't change.
 */
export function useLyrics(track: PlayerTrack | null, enabled: boolean) {
  const params = track ? lyricsQuery(track) : null;
  return useQuery({
    queryKey: [api.lyrics.get.path, params],
    enabled: enabled && params !== null,
    staleTime: Infinity,
    retry: false,
    queryFn: ({ signal }) =>
      requestJson(
        api.lyrics.get.responses[200],
        `${api.lyrics.get.path}?${new URLSearchParams(params ?? {})}`,
        { signal },
      ),
  });
}
