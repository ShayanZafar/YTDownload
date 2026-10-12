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
 * and after each download into the folder. When more of the playlist's songs
 * arrive, the last answer for the same folder stands until the new one comes
 * (`isPlaceholderData`), so the marks, the Not in folder view and the ticks
 * don't blink — never another playlist's answer.
 */
export function useSongsInFolder(folder: string | null, playlist: SpotifyPlaylist | undefined) {
  const songs = useMemo(
    () => (playlist?.tracks ?? []).map(({ id, title, artists }) => ({ id, title, artists })),
    [playlist],
  );
  const ids = songs.map((song) => song.id).join(",");
  return useQuery({
    queryKey: [...SONGS_IN_FOLDER_KEY, folder, ids],
    enabled: folder !== null && songs.length > 0,
    queryFn: ({ signal }) => findSongsInFolder(songs, signal),
    staleTime: 0,
    refetchOnWindowFocus: true,
    // The answer for the same folder and the songs before these arrived.
    placeholderData: (previous, previousQuery) => {
      const [, wasFolder, wasIds] = previousQuery?.queryKey ?? [];
      return wasFolder === folder && typeof wasIds === "string" && ids.startsWith(`${wasIds},`)
        ? previous
        : undefined;
    },
  });
}
