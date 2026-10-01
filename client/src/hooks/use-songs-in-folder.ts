import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@shared/routes";
import type { SpotifyPlaylist } from "@shared/schema";
import { findSongsInFolder } from "@/lib/save-to-folder";

/** Every "which songs are in the folder" answer (to look again after a download). */
export const SONGS_IN_FOLDER_KEY = [api.folders.songs.path];

/**
 * Which of the open playlist's songs are already in the "Save to" folder —
 * `folder` is null when downloads go to the browser instead. Looked up again
 * when you come back to the page (you may have added or moved files meanwhile)
 * and after each download into the folder.
 */
export function useSongsInFolder(folder: string | null, playlist: SpotifyPlaylist | undefined) {
  const songs = useMemo(
    () => (playlist?.tracks ?? []).map(({ id, title, artists }) => ({ id, title, artists })),
    [playlist],
  );
  return useQuery({
    queryKey: [...SONGS_IN_FOLDER_KEY, folder, songs.map((song) => song.id).join(",")],
    enabled: folder !== null && songs.length > 0,
    queryFn: ({ signal }) => findSongsInFolder(songs, signal),
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
}
