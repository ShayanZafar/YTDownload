import { useQuery, useMutation } from "@tanstack/react-query";
import { api, errorSchemas } from "@shared/routes";
import { z } from "zod";

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
 * Song search: YouTube results for a text query, official uploads first. A
 * Spotify song link also returns the song it points to (`spotify`).
 */
export async function searchSongs(query: string, signal?: AbortSignal) {
  const res = await fetch(`${api.video.search.path}?${new URLSearchParams({ q: query })}`, {
    credentials: "include",
    signal,
  });
  const data: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    const parsedError = errorSchemas.internal.safeParse(data);
    throw new Error(parsedError.success ? parsedError.data.message : "Search failed");
  }
  return parseWithLogging(api.video.search.responses[200], data, "video.search");
}

/** Where a Spotify link leads (a spotify.link short link is opened to find out). */
export async function openSpotifyLink(link: string) {
  const res = await fetch(`${api.spotify.link.path}?${new URLSearchParams({ link })}`, {
    credentials: "include",
  });
  const data: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    const parsedError = errorSchemas.internal.safeParse(data);
    throw new Error(parsedError.success ? parsedError.data.message : "Couldn't open the link");
  }
  return parseWithLogging(api.spotify.link.responses[200], data, "spotify.link");
}

export function useSpotifyLink() {
  return useMutation({ mutationFn: openSpotifyLink });
}

export function useSongSearch() {
  return useMutation({ mutationFn: (query: string) => searchSongs(query) });
}

/**
 * The songs in a Spotify playlist or album (the first 100 of a playlist), for
 * the playlist panel. `link` is null while no playlist is open.
 */
export function useSpotifyPlaylist(link: string | null) {
  return useQuery({
    queryKey: [api.spotify.playlist.path, link],
    enabled: link !== null,
    queryFn: async () => {
      const res = await fetch(
        `${api.spotify.playlist.path}?${new URLSearchParams({ link: link ?? "" })}`,
        { credentials: "include" },
      );
      const data: unknown = await res.json().catch(() => undefined);
      if (!res.ok) {
        const parsedError = errorSchemas.internal.safeParse(data);
        throw new Error(
          parsedError.success ? parsedError.data.message : "Couldn't open that playlist",
        );
      }
      return parseWithLogging(api.spotify.playlist.responses[200], data, "spotify.playlist");
    },
  });
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

      if (!res.ok) {
        if (res.status === 400 || res.status === 500) {
          const errorData = await res.json();
          const schema =
            res.status === 400 ? api.video.info.responses[400] : api.video.info.responses[500];
          const parsedError = schema.safeParse(errorData);
          throw new Error(parsedError.success ? parsedError.data.message : "An error occurred");
        }
        throw new Error("Failed to fetch video information");
      }

      const data = await res.json();
      return parseWithLogging(api.video.info.responses[200], data, "video.info");
    },
    // Only invalidate if we actually triggered a background process that updates list,
    // though the app requires clicking "Download" to actually add to the list.
    // We will invalidate when the user clicks download instead.
  });
}
