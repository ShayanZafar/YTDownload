import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DownloadFormat } from "@shared/routes";
import {
  SAME_LENGTH_SECONDS,
  type PlaylistSource,
  type SearchResult,
  type SpotifyPlaylistTrack,
} from "@shared/schema";
import { spotifyFileName } from "@shared/spotify-names";
import { searchSongs } from "@/hooks/use-youtube";
import { ApiError, folderName, saveOnServer } from "@/lib/save-to-folder";

/** Where one song of a "Download all" is at. */
export type SongStatus =
  /** Its turn hasn't come — or, with a `message`, YouTube is limiting the computer and it's waiting that out. */
  | { state: "waiting"; message?: string }
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
  /** Stopped before the end: by you, or because of a `problem` every other song would hit too. */
  stopped: boolean;
  problem?: string;
};

/**
 * The YouTube upload to download for a Spotify song without asking anyone:
 * the best match, if it's the same length as the song on Spotify — so almost
 * surely the same recording. Otherwise none, and someone should choose — also
 * when the song's length isn't known (Spotify's fallback doesn't say it).
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
  if (results.length === 0) return "No YouTube uploads of this song found.";
  if (songSeconds == null) {
    return "Spotify didn't say how long the song is, so no upload can be matched to it — pick one yourself.";
  }
  return "No YouTube upload is the same length as the song on Spotify — pick one yourself.";
}

// A save the folder itself refused (gone, off-limits, full, or not chosen any
// more): every other song would fail the same way, so stop.
const FOLDER_PROBLEMS = [403, 404, 409, 507];

/** The longest "Download all" waits for YouTube to stop limiting the computer. */
export const MAX_WAIT_MS = 15 * 60_000;

/**
 * How long to wait before trying a step again, when the app answered that
 * YouTube is limiting this computer (a 429 saying how long): at most
 * MAX_WAIT_MS. Undefined for any other failure.
 */
export function retryDelayMs(err: unknown): number | undefined {
  if (!(err instanceof ApiError) || err.status !== 429 || err.retryAfterSeconds === undefined) {
    return undefined;
  }
  return Math.min(MAX_WAIT_MS, Math.max(0, err.retryAfterSeconds) * 1000);
}

/** Resolves after `ms` — unless stopped first, when it rejects. */
export function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", stop, { once: true });
  });
}

/**
 * Runs a step of a song's download; when the app says YouTube is limiting
 * the computer, shows the song waiting, waits that out (Stop ends the wait)
 * and runs the step once more. A second such answer is the step's failure.
 */
export async function waitingOutLimit<T>(
  step: () => Promise<T>,
  signal: AbortSignal,
  report: (status: SongStatus) => void,
  resume: SongStatus,
): Promise<T> {
  try {
    return await step();
  } catch (err) {
    const delay = retryDelayMs(err);
    if (delay === undefined || signal.aborted) throw err;
    report({ state: "waiting", message: messageOf(err) });
    await wait(delay, signal);
    report(resume);
    return step();
  }
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : "Something went wrong.");

/** YouTube is still limiting the computer after the wait: the rest would fail the same way. */
const isLimited = (err: unknown) => retryDelayMs(err) !== undefined;

type SongResult = { status: SongStatus; problem?: boolean };

/** Saves one YouTube video into the folder. Rejects only if stopped. */
async function saveVideo(
  request: Parameters<typeof saveOnServer>[0],
  signal: AbortSignal,
  report: (status: SongStatus) => void,
): Promise<SongResult> {
  const saving = { state: "saving", bytes: 0 } as const;
  report(saving);
  try {
    const saved = await waitingOutLimit(
      () =>
        saveOnServer(request, {
          signal,
          onProgress: (bytes) => report({ state: "saving", bytes }),
        }),
      signal,
      report,
      saving,
    );
    return { status: { state: "saved", file: saved.fileName } };
  } catch (err) {
    if (signal.aborted) throw err;
    return {
      status: { state: "failed", reason: messageOf(err) },
      problem: (err instanceof ApiError && FOLDER_PROBLEMS.includes(err.status)) || isLimited(err),
    };
  }
}

/**
 * One song: a YouTube playlist's video is saved as it is. A Spotify song is
 * looked for on YouTube like its Spotify link would be, and the best match
 * saved into the folder if it's surely the song. Rejects only if stopped.
 */
async function downloadSong(
  song: SpotifyPlaylistTrack,
  source: PlaylistSource,
  format: DownloadFormat,
  signal: AbortSignal,
  report: (status: SongStatus) => void,
): Promise<SongResult> {
  if (source === "youtube") return saveVideo({ url: song.url, format }, signal, report);

  const finding = { state: "finding" } as const;
  report(finding);
  let found;
  try {
    found = await waitingOutLimit(() => searchSongs(song.url, signal), signal, report, finding);
  } catch (err) {
    if (signal.aborted) throw err;
    return { status: { state: "failed", reason: messageOf(err) }, problem: isLimited(err) };
  }

  // The song's length: from Spotify's answer now, else from the playlist
  // (Spotify's fallback knows a song's title but not its length).
  const songSeconds = found.spotify?.duration ?? song.duration;
  const match = confidentMatch(found.results, songSeconds);
  if (!match)
    return { status: { state: "check", reason: checkReason(found.results, songSeconds) } };

  return saveVideo(
    { url: match.url, format, name: spotifyFileName(found.spotify ?? song), spotifyId: song.id },
    signal,
    report,
  );
}

const isActive = (status: SongStatus) =>
  status.state === "waiting" || status.state === "finding" || status.state === "saving";

/**
 * "Download all" for a playlist: one song after another, saved into the "Save
 * to" folder. A Spotify song is looked for on YouTube and saved when the best
 * match is the same length as the song on Spotify; songs without such a match
 * are marked "check" instead of guessed at. A YouTube playlist's videos are
 * saved as they are. One song at a time on purpose — it keeps YouTube from
 * seeing a burst of downloads from one computer. When YouTube is limiting the
 * computer all the same (the app answers 429), the song waits that out and is
 * tried once more; if YouTube still won't have it, the run stops there, and
 * the songs it didn't get to are left as they were.
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
      const summary: DownloadAllSummary = { saved: 0, check: 0, failed: 0, stopped: false };
      try {
        for (const song of queue) {
          if (controller.signal.aborted) break;
          let result;
          try {
            result = await downloadSong(song, source, format, controller.signal, (s) =>
              set(song.id, s),
            );
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
            if (result.problem) {
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
