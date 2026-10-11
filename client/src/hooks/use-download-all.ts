import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DownloadFormat } from "@shared/routes";
import {
  SAME_LENGTH_SECONDS,
  type AudioSource,
  type PlaylistSource,
  type SearchResult,
  type SpotifyPlaylistTrack,
} from "@shared/schema";
import { spotifyFileName } from "@shared/spotify-names";
import { searchSongs } from "@/hooks/use-youtube";
import { ApiError, folderName, saveOnServer } from "@/lib/save-to-folder";

/** Where one song of a "Download all" is at. */
export type SongStatus =
  /** Its turn hasn't come. */
  | { state: "waiting" }
  | { state: "finding" }
  | { state: "saving"; bytes: number }
  /** `source`: where it came from, when that wasn't YouTube. */
  | { state: "saved"; file: string; source?: AudioSource }
  /** No upload is surely the same recording, so none was downloaded: pick one yourself. */
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
 * The upload to download for a Spotify song without asking anyone: the best
 * match, if it's the same length as the song on Spotify — so almost surely the
 * same recording. Otherwise none, and someone should choose — also when the
 * song's length isn't known (Spotify's fallback doesn't say it).
 */
export function confidentMatch(
  results: SearchResult[],
  songSeconds: number | null | undefined,
): SearchResult | undefined {
  const best = results[0];
  if (!best || songSeconds == null || best.duration == null) return undefined;
  return Math.abs(best.duration - songSeconds) <= SAME_LENGTH_SECONDS ? best : undefined;
}

/** Why no upload was downloaded for a song, for its "check" mark. */
export function checkReason(results: SearchResult[], songSeconds: number | null | undefined) {
  if (results.length === 0) return "No uploads of this song found.";
  if (songSeconds == null) {
    return "Spotify didn't say how long the song is, so no upload can be matched to it — pick one yourself.";
  }
  return "No upload found is the same length as the song on Spotify — pick one yourself.";
}

// A save the folder itself refused (gone, off-limits, full, or not chosen any
// more): every other song would fail the same way, so stop.
const FOLDER_PROBLEMS = [403, 404, 409, 507];

const messageOf = (err: unknown) => (err instanceof Error ? err.message : "Something went wrong.");

/** How a song went; `limited`: YouTube refused it (it's limiting the computer). */
type SongResult = { status: SongStatus; problem?: boolean; limited?: boolean };

/** What "Download all" asks the app for: a song's search, and a save into the folder. */
export type DownloadAllCalls = {
  search: typeof searchSongs;
  save: typeof saveOnServer;
};

const appCalls: DownloadAllCalls = { search: searchSongs, save: saveOnServer };

/** Saves one upload (from `source`) into the folder. Rejects only if stopped. */
async function saveVideo(
  request: Parameters<typeof saveOnServer>[0],
  signal: AbortSignal,
  report: (status: SongStatus) => void,
  { save }: DownloadAllCalls,
  source: AudioSource = "youtube",
): Promise<SongResult> {
  report({ state: "saving", bytes: 0 });
  try {
    const saved = await save(request, {
      signal,
      onProgress: (bytes) => report({ state: "saving", bytes }),
    });
    return {
      status: {
        state: "saved",
        file: saved.fileName,
        ...(source !== "youtube" ? { source } : {}),
      },
    };
  } catch (err) {
    if (signal.aborted) throw err;
    return {
      status: { state: "failed", reason: messageOf(err) },
      problem: err instanceof ApiError && FOLDER_PROBLEMS.includes(err.status),
      limited: err instanceof ApiError && err.limited,
    };
  }
}

/**
 * One song: a YouTube playlist's video is saved as it is. A Spotify song is
 * looked for like its Spotify link would be (the app goes to SoundCloud by
 * itself when YouTube's search can't answer), and the best match saved into
 * the folder if it's surely the song. When YouTube refuses that save, the
 * song is looked for on SoundCloud alone, at once, and a SoundCloud match
 * that's surely the song is saved instead. Rejects only if stopped.
 */
async function downloadSong(
  song: SpotifyPlaylistTrack,
  source: PlaylistSource,
  format: DownloadFormat,
  signal: AbortSignal,
  report: (status: SongStatus) => void,
  calls: DownloadAllCalls,
): Promise<SongResult> {
  if (source === "youtube") return saveVideo({ url: song.url, format }, signal, report, calls);

  report({ state: "finding" });
  let found;
  try {
    found = await calls.search(song.url, signal);
  } catch (err) {
    if (signal.aborted) throw err;
    // Every source the app asked failed: this song is failed, on to the next.
    return { status: { state: "failed", reason: messageOf(err) } };
  }

  // The song's length: from Spotify's answer now, else from the playlist
  // (Spotify's fallback knows a song's title but not its length).
  const songSeconds = found.spotify?.duration ?? song.duration;
  const match = confidentMatch(found.results, songSeconds);
  if (!match)
    return { status: { state: "check", reason: checkReason(found.results, songSeconds) } };

  const name = spotifyFileName(found.spotify ?? song);
  const saveMatch = (upload: SearchResult) =>
    saveVideo(
      { url: upload.url, format, name, spotifyId: song.id },
      signal,
      report,
      calls,
      upload.source,
    );
  const saved = await saveMatch(match);
  if (!saved.limited || (match.source ?? "youtube") !== "youtube") return saved;

  // YouTube refused the save: switch to SoundCloud for this song, once.
  report({ state: "finding" });
  let again;
  try {
    again = await calls.search(song.url, signal, { soundCloudOnly: true });
  } catch (err) {
    if (signal.aborted) throw err;
    return saved;
  }
  const fallback = confidentMatch(
    again.results.filter((result) => result.source === "soundcloud"),
    again.spotify?.duration ?? songSeconds,
  );
  return fallback ? saveMatch(fallback) : saved;
}

export type DownloadAllRun = {
  source: PlaylistSource;
  format: DownloadFormat;
  /** Aborting it stops the run (the song being saved is removed, as with Cancel). */
  signal: AbortSignal;
  /** A song's status as it goes: finding, saving… */
  report: (song: SpotifyPlaylistTrack, status: SongStatus) => void;
  /** A song is done with: saved, to check, or failed. */
  finished: (song: SpotifyPlaylistTrack, status: SongStatus) => void;
};

/**
 * The songs, one after another, never waiting for anything but the song
 * before. A song that can't be found or saved is marked failed, with the
 * reason, and the run moves straight on to the next; only a problem with the
 * folder itself, which every other song would hit too, stops it.
 */
export async function downloadSongs(
  queue: SpotifyPlaylistTrack[],
  { source, format, signal, report, finished }: DownloadAllRun,
  calls: DownloadAllCalls = appCalls,
): Promise<DownloadAllSummary> {
  const summary: DownloadAllSummary = { saved: 0, check: 0, failed: 0, stopped: false };
  for (const song of queue) {
    if (signal.aborted) break;
    let result: SongResult;
    try {
      result = await downloadSong(
        song,
        source,
        format,
        signal,
        (status) => report(song, status),
        calls,
      );
    } catch {
      break; // stopped
    }
    finished(song, result.status);
    if (result.status.state === "saved") summary.saved++;
    else if (result.status.state === "check") summary.check++;
    else if (result.status.state === "failed") {
      summary.failed++;
      if (result.problem) {
        summary.problem = result.status.reason;
        break;
      }
    }
  }
  summary.stopped = signal.aborted || summary.problem !== undefined;
  return summary;
}

const isActive = (status: SongStatus) =>
  status.state === "waiting" || status.state === "finding" || status.state === "saving";

/**
 * "Download all" for a playlist: one song after another, saved into the "Save
 * to" folder. A Spotify song is looked for, and saved when the best match is
 * the same length as the song on Spotify; songs without such a match are
 * marked "check" instead of guessed at. A YouTube playlist's videos are saved
 * as they are. One song at a time on purpose — it keeps YouTube from seeing a
 * burst of downloads from one computer.
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

  const start = useCallback(
    async (
      songs: SpotifyPlaylistTrack[],
      format: DownloadFormat,
      source: PlaylistSource = "spotify",
    ) => {
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
      let summary: DownloadAllSummary | undefined;
      try {
        summary = await downloadSongs(queue, {
          source,
          format,
          signal: controller.signal,
          report: (song, status) => set(song.id, status),
          finished: (song, status) => {
            set(song.id, status);
            setProgress((current) => current && { ...current, done: current.done + 1 });
            if (status.state === "saved") callbacks.current.onSaved?.(song, status.file);
          },
        });
      } finally {
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
        callbacks.current.onDone?.(summary ?? { saved: 0, check: 0, failed: 0, stopped: true });
      }
    },
    [],
  );

  const stop = useCallback(() => run.current?.abort(), []);

  /** Forget how the last run went (another playlist was opened). */
  const reset = useCallback(() => {
    run.current?.abort();
    setStatuses({});
  }, []);

  return { statuses, progress, running: progress !== null, start, stop, reset };
}

/** What "Download all" says when it's over (a toast). */
export function downloadAllToast(
  { saved, check, failed, stopped, problem }: DownloadAllSummary,
  folder: string | null,
) {
  const savedText = `${saved} ${saved === 1 ? "song" : "songs"}`;
  if (problem) {
    return { title: "Downloads stopped", description: problem, variant: "destructive" as const };
  }
  const left = [check > 0 && `${check} to check`, failed > 0 && `${failed} failed`]
    .filter(Boolean)
    .join(", ");
  return {
    title: stopped
      ? "Downloads stopped"
      : saved > 0
        ? `Saved ${savedText}${folder ? ` to “${folderName(folder)}”` : ""}`
        : "Nothing was saved",
    description: [stopped && `${savedText} saved.`, left && `${left} — see the playlist.`]
      .filter(Boolean)
      .join(" "),
  };
}
