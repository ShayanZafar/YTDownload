import { useQuery } from "@tanstack/react-query";
import { api } from "@shared/routes";
import type { Download } from "@shared/schema";
import { findHistoryInFolder } from "@/lib/save-to-folder";

/** Every "which downloads are in the folder" answer (to look again after a download or a delete). */
export const HISTORY_IN_FOLDER_KEY = [api.downloads.inFolder.path];

/**
 * Which downloads in the history are in the "Save to" folder still — `folder`
 * is null when there's none (or this browser isn't on the computer running
 * the app). Looked up again when you come back to the page (you may have
 * moved or deleted files meanwhile), after a download or a delete, and when
 * the history gains an entry; until the new answer comes, the last one for
 * the same folder stands, so the marks don't blink.
 */
export function useHistoryInFolder(folder: string | null, history: readonly Download[]) {
  const newest = history.length > 0 ? `${history.length}:${history[0].id}` : "none";
  return useQuery({
    queryKey: [...HISTORY_IN_FOLDER_KEY, folder, newest],
    enabled: folder !== null && history.length > 0,
    queryFn: ({ signal }) => findHistoryInFolder(signal),
    staleTime: 0,
    refetchOnWindowFocus: true,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === folder ? previous : undefined,
  });
}
