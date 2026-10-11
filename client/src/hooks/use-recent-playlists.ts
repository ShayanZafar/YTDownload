import { useCallback, useState } from "react";
import {
  forgetPlaylist,
  parseRecentPlaylists,
  rememberPlaylist,
  type RecentPlaylist,
} from "@/lib/recent-playlists";

const STORAGE_KEY = "recent-playlists";

function read(): RecentPlaylist[] {
  try {
    return parseRecentPlaylists(localStorage.getItem(STORAGE_KEY));
  } catch {
    return [];
  }
}

function write(list: RecentPlaylist[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Not remembered; the list still applies for this visit.
  }
}

/** The playlists opened lately in this browser (newest first): remember one, or forget one. */
export function useRecentPlaylists() {
  const [list, setList] = useState(read);

  const remember = useCallback((entry: RecentPlaylist) => {
    setList((current) => {
      const next = rememberPlaylist(current, entry);
      write(next);
      return next;
    });
  }, []);

  const forget = useCallback((link: string) => {
    setList((current) => {
      const next = forgetPlaylist(current, link);
      write(next);
      return next;
    });
  }, []);

  return { list, remember, forget };
}
