import { useQuery } from "@tanstack/react-query";
import { api } from "@shared/routes";
import { fetchMusicLibrary } from "@/lib/music";

/** Every list of the folder's songs (to look again after a download into it). */
export const MUSIC_KEY = [api.music.list.path];

/**
 * The songs in the "Save to" folder, for the music player — `folder` is null
 * when there's none (or this browser isn't on the computer running the app).
 * Looked up again when you come back to the page (you may have added or moved
 * files meanwhile) and after each download into the folder.
 */
export function useFolderMusic(folder: string | null) {
  return useQuery({
    queryKey: [...MUSIC_KEY, folder],
    enabled: folder !== null,
    queryFn: ({ signal }) => fetchMusicLibrary(signal),
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
}
