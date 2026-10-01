import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DownloadFormat } from "@shared/routes";
import { SAME_LENGTH_SECONDS, type SearchResult, type SpotifyPlaylistTrack } from "@shared/schema";
import { spotifyFileName } from "@shared/spotify-names";
import { searchSongs } from "@/hooks/use-youtube";
import { ApiError, saveOnServer } from "@/lib/save-to-folder";

/** Where one song of a "Download all" is at. */
export type SongStatus =
  | { state: "waiting" }
  | { state: "finding" }
  | { state: "saving"; bytes: number }
  | { state: "saved"; file: string }
  /** No YouTube upload is surely the same recording, so none was downloaded: pick one yourself. */
  | { state: "check"; reason: string }
  | { state: "failed"; reason: string };

export type DownloadAllSummary = {
  saved: number;
  check: number;
  failed: number;
  /** Stopped before the end: by you, or because the folder can't be used (`problem`). */
  stopped: boolean;
  problem?: string;
};

/**
 * The YouTube upload to download for a Spotify song without asking anyone:
 * the best match, if it's the same length as the song on Spotify — so almost
 * surely the same recording. Otherwise none, and someone should choose.
 */
export function confidentMatch(
  results: SearchResult[],
  songSeconds: number | null | undefined,
): SearchResult | undefined {
  const best = results[0];
  if (!best || songSeconds == null || best.duration == null) return undefined;
  return Math.abs(best.duration - songSeconds) <= SAME_LENGTH_SECONDS ? best : undefined;
}

// A save the folder itself refused (gone, off-limits, full, or not chosen any
// more): every other song would fail the same way, so stop.
const FOLDER_PROBLEMS = [403, 404, 409, 507];

const messageOf = (err: unknown) => (err instanceof Error ? err.message : "Something went wrong.");

/**
 * One song: look for it on YouTube like its Spotify link would, and save the
 * best match into the folder if it's surely the song. Rejects only if stopped.
 */
async function downloadSong(
  song: SpotifyPlaylistTrack,
  format: DownloadFormat,
  signal: AbortSignal,
  report: (status: SongStatus) => void,
): Promise<{ status: SongStatus; folderProblem?: boolean }> {
  report({ state: "finding" });
  let found;
  try {
    found = await searchSongs(song.url, signal);
  } catch (err) {
    if (signal.aborted) throw err;
    return { status: { state: "failed", reason: messageOf(err) } };
  }

  const match = confidentMatch(found.results, found.spotify?.duration ?? song.duration);
  if (!match) {
    const reason =
      found.results.length === 0
        ? "No YouTube uploads of this song found."
        : "No YouTube upload is the same length as the song on Spotify — pick one yourself.";
    return { status: { state: "check", reason } };
  }

  report({ state: "saving", bytes: 0 });
  try {
    const saved = await saveOnServer(
      {
        url: match.url,
        format,
        name: spotifyFileName(found.spotify ?? song),
        spotifyId: song.id,
      },
      { signal, onProgress: (bytes) => report({ state: "saving", bytes }) },
    );
    return { status: { state: "saved", file: saved.fileName } };
  } catch (err) {
    if (signal.aborted) throw err;
    return {
      status: { state: "failed", reason: messageOf(err) },
      folderProblem: err instanceof ApiError && FOLDER_PROBLEMS.includes(err.status),
    };
  }
}

const isActive = (status: SongStatus) =>
  status.state === "waiting" || status.state === "finding" || status.state === "saving";

/**
 * "Download all" for a Spotify playlist: one song after another, each looked
 * for on YouTube and saved into the "Save to" folder when the best match is
 * the same length as the song on Spotify. Songs without such a match are
 * marked "check" instead of guessed at. One song at a time on purpose — it
 * keeps YouTube from seeing a burst of downloads from one computer.
 */
export function useDownloadAll({
  onSaved,
  onDone,
}: {
  /** After each song is saved. */
  onSaved?: (song: SpotifyPlaylistTrack, fileName: string) => void;
  /** When the run is over, finished or stopped. */
  onDone?: (summary: DownloadAllSummary) => void;
} = {}) {
  const [statuses, setStatuses] = useState<Record<string, SongStatus>>({});
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const run = useRef<AbortController | null>(null);
  const callbacks = useRef({ onSaved, onDone });
  useLayoutEffect(() => {
    callbacks.current = { onSaved, onDone };
  });

  // Leaving the page stops it (the song being saved is removed, as with Cancel).
  useEffect(() => () => run.current?.abort(), []);

  const start = useCallback(async (songs: SpotifyPlaylistTrack[], format: DownloadFormat) => {
    if (run.current) return;
    const controller = new AbortController();
    run.current = controller;
    // A song that's in the playlist twice is downloaded once.
    const queue = songs.filter((song, i) => songs.findIndex((s) => s.id === song.id) === i);
    const set = (id: string, status: SongStatus) =>
      setStatuses((current) => ({ ...current, [id]: status }));

    setStatuses((current) => {
      const next = { ...current };
      queue.forEach((song) => (next[song.id] = { state: "waiting" }));
      return next;
    });
    setProgress({ done: 0, total: queue.length });
    const summary: DownloadAllSummary = { saved: 0, check: 0, failed: 0, stopped: false };
    try {
      for (const song of queue) {
        if (controller.signal.aborted) break;
        let result;
        try {
          result = await downloadSong(song, format, controller.signal, (s) => set(song.id, s));
        } catch {
          break; // stopped
        }
        set(song.id, result.status);
        setProgress((current) => current && { ...current, done: current.done + 1 });
        if (result.status.state === "saved") {
          summary.saved++;
          callbacks.current.onSaved?.(song, result.status.file);
        } else if (result.status.state === "check") {
          summary.check++;
        } else if (result.status.state === "failed") {
          summary.failed++;
          if (result.folderProblem) {
            summary.problem = result.status.reason;
            break;
          }
        }
      }
    } finally {
      summary.stopped = controller.signal.aborted || summary.problem !== undefined;
      run.current = null;
      setProgress(null);
      // Songs it didn't get to aren't waiting any more.
      setStatuses((current) => {
        const next: Record<string, SongStatus> = {};
        Object.keys(current).forEach((id) => {
          if (!isActive(current[id])) next[id] = current[id];
        });
        return next;
      });
      callbacks.current.onDone?.(summary);
    }
  }, []);

  const stop = useCallback(() => run.current?.abort(), []);

  /** Forget how the last run went (another playlist was opened). */
  const reset = useCallback(() => {
    run.current?.abort();
    setStatuses({});
  }, []);

  return { statuses, progress, running: progress !== null, start, stop, reset };
}
