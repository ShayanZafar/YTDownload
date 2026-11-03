import { useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { api } from "@shared/routes";
import { useAskAgainAt } from "@/hooks/use-ask-again-at";
import { playlistSourceOf } from "@/lib/format";
import { requestJson } from "@/lib/api";

/** The download history. Pass a poll interval (ms) to keep it refreshing. */
export function useRecentDownloads(pollEveryMs: number | false = false) {
  return useQuery({
    queryKey: [api.downloads.list.path],
    refetchInterval: pollEveryMs,
    queryFn: () => requestJson(api.downloads.list.responses[200], api.downloads.list.path),
  });
}

/**
 * Song search: results for a text query, official uploads first — YouTube's,
 * or SoundCloud's when YouTube can't answer (`source` says which, and so does
 * each result). A Spotify song link also returns the song it points to
 * (`spotify`). `soundCloudOnly` asks SoundCloud alone, for a song YouTube
 * refused to hand over. A failure is an `ApiError` with the app's message
 * (`limited` when YouTube refused).
 */
export async function searchSongs(
  query: string,
  signal?: AbortSignal,
  { soundCloudOnly = false }: { soundCloudOnly?: boolean } = {},
) {
  const params = new URLSearchParams({ q: query });
  if (soundCloudOnly) params.set("source", "soundcloud");
  return requestJson(api.video.search.responses[200], `${api.video.search.path}?${params}`, {
    signal,
  });
}

/** Where a Spotify link leads (a spotify.link short link is opened to find out). */
export async function openSpotifyLink(link: string) {
  return requestJson(
    api.spotify.link.responses[200],
    `${api.spotify.link.path}?${new URLSearchParams({ link })}`,
  );
}

export function useSpotifyLink() {
  return useMutation({ mutationFn: openSpotifyLink });
}

/** A search the page runs: `soundCloudOnly` to look on SoundCloud alone. */
export type SongSearchRequest = { query: string; soundCloudOnly?: boolean };

export function useSongSearch() {
  return useMutation({
    mutationFn: ({ query, soundCloudOnly }: SongSearchRequest) =>
      searchSongs(query, undefined, { soundCloudOnly }),
  });
}

/**
 * The songs in a Spotify playlist or album (up to 1,000 songs of a playlist), or
 * the videos in a YouTube playlist (the first 500), for the playlist panel.
 * `link` is null while no playlist is open. When Spotify didn't share the
 * whole playlist but said when to ask again (`more.retryAt`), it asks again
 * then by itself, and the rest of the songs fill in.
 */
export function usePlaylist(link: string | null) {
  const { path, responses } =
    link !== null && playlistSourceOf(link) === "youtube"
      ? api.youtube.playlist
      : api.spotify.playlist;
  const query = useQuery({
    queryKey: [path, link],
    enabled: link !== null,
    queryFn: () =>
      requestJson(responses[200], `${path}?${new URLSearchParams({ link: link ?? "" })}`),
  });
  const { refetch } = query;
  useAskAgainAt(
    query.data?.more?.retryAt,
    `${query.dataUpdatedAt}-${query.errorUpdatedAt}`,
    useCallback(() => void refetch(), [refetch]),
  );
  return query;
}

export function useVideoInfo() {
  return useMutation({
    // A 400, a 500 or a 502 (YouTube refused: it's limiting this computer) all say why.
    mutationFn: (url: string) =>
      requestJson(api.video.info.responses[200], api.video.info.path, {
        method: api.video.info.method,
        json: api.video.info.input.parse({ url }),
      }),
  });
}
