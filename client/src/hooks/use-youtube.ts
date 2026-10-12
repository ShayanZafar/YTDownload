import { useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { api } from "@shared/routes";
import { z } from "zod";
import { useAskAgainAt } from "@/hooks/use-ask-again-at";
import { playlistSourceOf } from "@/lib/format";
import { errorFrom } from "@/lib/save-to-folder";

/**
 * Safely parse data and log detailed errors if validation fails.
 * This ensures frontend doesn't silently fail when backend shapes change.
 */
function parseWithLogging<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    console.error(`[Zod] ${label} validation failed:`, z.prettifyError(result.error));
    throw new Error(`Data validation failed for ${label}`);
  }
  return result.data;
}

/** The download history. Pass a poll interval (ms) to keep it refreshing. */
export function useRecentDownloads(pollEveryMs: number | false = false) {
  return useQuery({
    queryKey: [api.downloads.list.path],
    refetchInterval: pollEveryMs,
    queryFn: async () => {
      const res = await fetch(api.downloads.list.path, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch recent downloads");
      const data = await res.json();
      return parseWithLogging(api.downloads.list.responses[200], data, "downloads.list");
    },
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
  const res = await fetch(`${api.video.search.path}?${params}`, {
    credentials: "include",
    signal,
  });
  if (!res.ok) throw await errorFrom(res);
  const data: unknown = await res.json().catch(() => undefined);
  return parseWithLogging(api.video.search.responses[200], data, "video.search");
}

/** Where a Spotify link leads (a spotify.link short link is opened to find out). */
export async function openSpotifyLink(link: string) {
  const res = await fetch(`${api.spotify.link.path}?${new URLSearchParams({ link })}`, {
    credentials: "include",
  });
  if (!res.ok) throw await errorFrom(res);
  const data: unknown = await res.json().catch(() => undefined);
  return parseWithLogging(api.spotify.link.responses[200], data, "spotify.link");
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
    queryFn: async () => {
      const res = await fetch(`${path}?${new URLSearchParams({ link: link ?? "" })}`, {
        credentials: "include",
      });
      if (!res.ok) throw await errorFrom(res);
      const data: unknown = await res.json().catch(() => undefined);
      return parseWithLogging(responses[200], data, path);
    },
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
    mutationFn: async (url: string) => {
      // Validate input before sending
      const validatedInput = api.video.info.input.parse({ url });

      const res = await fetch(api.video.info.path, {
        method: api.video.info.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validatedInput),
        credentials: "include",
      });

      // A 400, a 500 or a 502 (YouTube refused: it's limiting this computer) all say why.
      if (!res.ok) throw await errorFrom(res);

      const data = await res.json();
      return parseWithLogging(api.video.info.responses[200], data, "video.info");
    },
    // Only invalidate if we actually triggered a background process that updates list,
    // though the app requires clicking "Download" to actually add to the list.
    // We will invalidate when the user clicks download instead.
  });
}
