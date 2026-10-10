import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Clock,
  Download,
  ExternalLink,
  FileMusic,
  ListMusic,
  Loader2,
  Play,
  RefreshCw,
  Search,
  Shuffle,
  Square,
  X,
} from "lucide-react";
import type {
  PlaylistSource,
  SongsInFolder,
  SpotifyPlaylist,
  SpotifyPlaylistTrack,
} from "@shared/schema";
import type { SongStatus } from "@/hooks/use-download-all";
import { formatBytes, formatDuration } from "@/lib/format";
import { searchableText } from "@/lib/history-filter";
import { folderName } from "@/lib/save-to-folder";
import { cn } from "@/lib/utils";

type SpotifyPlaylistPanelProps = {
  /** Where the playlist is from (known before it has loaded, from its link). */
  source: PlaylistSource;
  /** The playlist or album, once it has loaded. */
  playlist?: SpotifyPlaylist;
  isLoading: boolean;
  isRefreshing: boolean;
  error: Error | null;
  /** The song whose YouTube matches are showing (or being looked for). */
  activeTrackId?: string;
  isSearching: boolean;
  /**
   * Spotify ids and YouTube video ids of the songs in the download history
   * (marked when there's no Save to folder).
   */
  downloadedIds: ReadonlySet<string>;
  /**
   * The "Save to" folder, and which of the songs are in it — undefined when
   * downloads go to the browser's downloads folder.
   */
  folder?: {
    path: string;
    songs?: SongsInFolder;
    isChecking: boolean;
    error: Error | null;
  };
  /** No folder is chosen, but this browser could choose one (to say what that would add). */
  canChooseFolder: boolean;
  /** "Download all": how each song went, and how far along it is (null when not running). */
  statuses: Record<string, SongStatus>;
  progress: { done: number; total: number } | null;
  onDownloadAll: (songs: SpotifyPlaylistTrack[]) => void;
  /** How many of the songs the player can play from the folder (in the playlist's order). */
  playableCount: number;
  /** Plays those songs in the music player, in order or shuffled. Called inside the click. */
  onPlay: (shuffle: boolean) => void;
  /** Writes those songs into the folder as an .m3u8 playlist file. */
  onSavePlaylistFile: () => void;
  savingPlaylistFile: boolean;
  onStop: () => void;
  onPick: (track: SpotifyPlaylistTrack) => void;
  onRefresh: () => void;
  onClose: () => void;
};

// Show a filter box once a list is long enough to need one.
const FILTER_FROM = 9;

/** Every word typed appears in the title or artists (any order, partial words, no accents needed). */
function matches(track: SpotifyPlaylistTrack, filter: string): boolean {
  const words = searchableText(filter).split(" ").filter(Boolean);
  if (words.length === 0) return true;
  const text = searchableText(`${track.title} ${track.artists}`);
  return words.every((word) => text.includes(word));
}

const countSongs = (n: number) => `${n} ${n === 1 ? "song" : "songs"}`;

/** The one entry per song (a playlist can have a song twice). */
const uniqueIds = (tracks: SpotifyPlaylistTrack[]) => Array.from(new Set(tracks.map((t) => t.id)));

type Mark = {
  Icon: typeof CheckCircle2;
  text: string;
  /** For screen readers, and the tooltip. */
  detail: string;
  className: string;
  spin?: boolean;
};

/** What a song's row says about it on the right: in the folder, being downloaded, and so on. */
function markFor(
  status: SongStatus | undefined,
  inFolder: { file: string } | undefined,
  downloaded: boolean,
): Mark | undefined {
  switch (status?.state) {
    case "waiting":
      return {
        Icon: Clock,
        text: "Waiting",
        detail: "waiting to download",
        className: "text-muted-foreground",
      };
    case "finding":
      return {
        Icon: Loader2,
        text: "Finding",
        detail: "looking for it on YouTube",
        className: "text-muted-foreground",
        spin: true,
      };
    case "saving":
      return {
        Icon: Loader2,
        text: status.bytes > 0 ? formatBytes(status.bytes) : "Saving",
        detail: "saving",
        className: "text-foreground",
        spin: true,
      };
    case "saved":
      return {
        Icon: CheckCircle2,
        text: "Saved",
        detail: `saved as ${status.file}`,
        className: "text-primary",
      };
    case "check":
      return {
        Icon: AlertTriangle,
        text: "Check",
        detail: status.reason,
        className: "text-amber-600 dark:text-amber-400",
      };
    case "failed":
      return {
        Icon: AlertCircle,
        text: "Failed",
        detail: `failed: ${status.reason}`,
        className: "text-destructive",
      };
  }
  if (inFolder) {
    return {
      Icon: CheckCircle2,
      text: "In folder",
      detail: `in the folder as ${inFolder.file}`,
      className: "text-primary",
    };
  }
  if (downloaded) {
    return {
      Icon: CheckCircle2,
      text: "Downloaded",
      detail: "downloaded",
      className: "text-primary",
    };
  }
  return undefined;
}

/**
 * The songs in a Spotify playlist or album, or the videos in a YouTube
 * playlist. Clicking a Spotify song looks for it on YouTube, exactly like
 * pasting that song's Spotify link: the best match is picked, ready to
 * download, with the other matches listed below it. Clicking a video opens it.
 *
 * With a "Save to" folder, each song says whether it's already in the folder,
 * the list can show just the missing ones, and "Download" fetches the ticked
 * ones (all missing songs, to begin with) one after another.
 */
export function SpotifyPlaylistPanel({
  source,
  playlist,
  isLoading,
  isRefreshing,
  error,
  activeTrackId,
  isSearching,
  downloadedIds,
  folder,
  canChooseFolder,
  statuses,
  progress,
  onDownloadAll,
  playableCount,
  onPlay,
  onSavePlaylistFile,
  savingPlaylistFile,
  onStop,
  onPick,
  onRefresh,
  onClose,
}: SpotifyPlaylistPanelProps) {
  const [filter, setFilter] = useState("");
  const [show, setShow] = useState<"all" | "missing">("all");
  // Songs ticked or unticked for "Download" (the rest follow the default).
  const [choices, setChoices] = useState<Record<string, boolean>>({});
  // A different playlist starts afresh.
  useEffect(() => {
    setFilter("");
    setShow("all");
    setChoices({});
  }, [playlist?.id]);

  const tracks = useMemo(() => playlist?.tracks ?? [], [playlist]);
  const kind = playlist?.kind ?? "playlist";
  const isYouTube = source === "youtube";
  const from = isYouTube ? "YouTube" : "Spotify";
  const running = progress !== null;
  // Folder mode: once the folder has been looked through.
  const found = folder?.songs?.found;
  // How a song's last Download went — unless it was "check" or "failed" and
  // has been saved into the folder since (picked by hand, say).
  const statusOf = (id: string): SongStatus | undefined => {
    const status = statuses[id];
    const settled = status?.state === "check" || status?.state === "failed";
    return settled && found?.[id] ? undefined : status;
  };
  const inFolder = (id: string) =>
    found?.[id] ?? (statuses[id]?.state === "saved" ? { file: "" } : undefined);
  const missing = useMemo(
    () => (found ? tracks.filter((t) => !found[t.id] && statuses[t.id]?.state !== "saved") : []),
    [tracks, found, statuses],
  );
  const missingIds = uniqueIds(missing);
  const inFolderCount = found ? uniqueIds(tracks).length - missingIds.length : 0;
  // Ticked: what you chose, else every missing song but the ones to check by hand.
  const isTicked = (id: string) => choices[id] ?? statusOf(id)?.state !== "check";
  const ticked = missing.filter((t) => isTicked(t.id));
  const tickedCount = uniqueIds(ticked).length;
  const tickAll = (on: boolean) => setChoices(Object.fromEntries(missingIds.map((id) => [id, on])));

  const shown = useMemo(
    () =>
      tracks
        .map((track, index) => ({ track, index }))
        .filter(
          ({ track }) =>
            matches(track, filter) &&
            // "Not in folder" keeps the last Download's songs too, to show how they went.
            (show === "all" || !found || !found[track.id] || statuses[track.id] !== undefined),
        ),
    [tracks, filter, show, found, statuses],
  );
  const downloadedCount = useMemo(
    () => new Set(tracks.filter((t) => downloadedIds.has(t.id)).map((t) => t.id)).size,
    [tracks, downloadedIds],
  );
  const finished = Object.keys(statuses).map(statusOf);
  const toCheck = finished.filter((s) => s?.state === "check").length;
  const failed = finished.filter((s) => s?.state === "failed").length;
  const where = folder ? `“${folderName(folder.path)}”` : "";

  return (
    <section aria-label={`${from} ${kind}`} className="max-w-3xl mx-auto w-full">
      <div className="rounded-2xl border border-border bg-card overflow-hidden">
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          {playlist?.image ? (
            <img
              src={playlist.image}
              alt=""
              className="h-12 w-12 shrink-0 rounded-md object-cover"
            />
          ) : (
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground">
              <ListMusic className="h-5 w-5" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {from} {kind}
            </p>
            <h2 className="truncate text-base font-semibold text-foreground">
              {playlist?.name ?? (isLoading ? "Opening…" : "Couldn't open it")}
            </h2>
            {playlist && (
              <p className="text-xs text-muted-foreground">
                {[
                  playlist.by && `by ${playlist.by}`,
                  countSongs(tracks.length),
                  folder
                    ? found
                      ? `${inFolderCount} in ${where} · ${missingIds.length} missing`
                      : folder.isChecking && `checking ${where}…`
                    : downloadedCount > 0 && `${downloadedCount} downloaded`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {playlist && (
              <a
                href={playlist.url}
                target="_blank"
                rel="noreferrer"
                aria-label={`Open in ${from}`}
                title={`Open in ${from}`}
                className="rounded-lg p-2 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
              >
                <ExternalLink className="h-4 w-4" />
              </a>
            )}
            {!isLoading && (
              <button
                type="button"
                onClick={onRefresh}
                disabled={isRefreshing}
                aria-label={`Reload the list from ${from}`}
                title={`Reload the list from ${from}`}
                className="rounded-lg p-2 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors disabled:opacity-60"
              >
                <RefreshCw className={cn("h-4 w-4", isRefreshing && "animate-spin")} />
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label={`Close the ${from} ${kind}`}
              title={running ? "Close (stops the downloads)" : "Close"}
              className="rounded-lg p-2 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {error && !isRefreshing && (
          <p
            role="alert"
            className="m-4 flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error.message}</span>
          </p>
        )}
        {folder?.error && !found && (
          <p
            role="alert"
            className="m-4 flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Couldn't look through {where}: {folder.error.message}
            </span>
          </p>
        )}

        {/* With a Save to folder: show what's missing, and download it. */}
        {found && tracks.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border px-4 py-2.5">
            <div
              role="group"
              aria-label="Show"
              className="inline-flex shrink-0 rounded-full border border-border bg-secondary/60 p-1"
            >
              {(
                [
                  ["all", "All songs"],
                  ["missing", `Not in folder (${missingIds.length})`],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={show === value}
                  onClick={() => setShow(value)}
                  className={cn(
                    "rounded-full px-3 py-1 text-xs font-medium transition-colors",
                    show === value
                      ? "bg-card text-foreground shadow-xs"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>

            {progress ? (
              <div className="flex min-w-0 items-center gap-3">
                <p
                  role="status"
                  className="flex min-w-0 items-center gap-2 text-xs text-foreground"
                >
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                  <span className="truncate">
                    Downloading {Math.min(progress.done + 1, progress.total)} of {progress.total}…
                  </span>
                </p>
                <button
                  type="button"
                  onClick={onStop}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-secondary transition-colors"
                >
                  <Square className="h-3 w-3" />
                  Stop
                </button>
              </div>
            ) : missingIds.length > 0 ? (
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => tickAll(tickedCount < missingIds.length)}
                  className="text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  {tickedCount < missingIds.length ? "Tick all" : "Untick all"}
                </button>
                <button
                  type="button"
                  disabled={tickedCount === 0}
                  onClick={() => onDownloadAll(ticked)}
                  title={
                    isYouTube
                      ? `Save each ticked video into ${where}`
                      : `Find each ticked song on YouTube and save it into ${where}`
                  }
                  className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
                >
                  <Download className="h-3.5 w-3.5" />
                  {tickedCount > 0 ? `Download ${countSongs(tickedCount)}` : "Download"}
                </button>
              </div>
            ) : (
              <p className="flex items-center gap-1.5 text-xs font-medium text-primary">
                <CheckCircle2 className="h-4 w-4" />
                Every song is in {where}
              </p>
            )}
          </div>
        )}
        {/* The songs already in the folder: play them, or keep them as a playlist file. */}
        {found && inFolderCount > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
            <button
              type="button"
              disabled={playableCount === 0}
              onClick={() => onPlay(false)}
              title={`Play the songs in ${where}, in the ${kind}'s order`}
              className="inline-flex items-center gap-1.5 rounded-lg bg-secondary px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-secondary/70 transition-colors disabled:opacity-50"
            >
              <Play className="h-3.5 w-3.5" />
              {playableCount > 0 ? `Play ${countSongs(playableCount)}` : "Play"}
            </button>
            <button
              type="button"
              disabled={playableCount === 0}
              onClick={() => onPlay(true)}
              aria-label={`Shuffle the songs in ${where}`}
              title={`Shuffle the songs in ${where}`}
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors disabled:opacity-50"
            >
              <Shuffle className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Shuffle</span>
            </button>
            <button
              type="button"
              disabled={savingPlaylistFile}
              onClick={onSavePlaylistFile}
              title={`Save the songs in ${where} as a playlist file (.m3u8) there, for VLC and other music players`}
              className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors disabled:opacity-50"
            >
              {savingPlaylistFile ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <FileMusic className="h-3.5 w-3.5" />
              )}
              Save playlist file
            </button>
          </div>
        )}
        {!running && (toCheck > 0 || failed > 0) && (
          <p className="border-b border-border bg-secondary/40 px-4 py-2 text-xs text-muted-foreground">
            {[
              toCheck > 0 &&
                `${countSongs(toCheck)} to check (no YouTube upload was surely the same recording)`,
              failed > 0 && `${failed} failed`,
            ]
              .filter(Boolean)
              .join(" · ")}
            . Click a song to choose its YouTube upload yourself.
          </p>
        )}

        {tracks.length >= FILTER_FROM && (
          <div className="border-b border-border px-4 py-2">
            <label className="flex items-center gap-2 rounded-lg bg-secondary/50 px-3">
              <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
              <input
                type="search"
                aria-label={`Filter the ${kind}'s songs`}
                placeholder="Filter songs"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                className="h-9 min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-hidden"
              />
            </label>
          </div>
        )}

        {isLoading ? (
          <div className="divide-y divide-border/60" aria-hidden="true">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-3">
                <div className="h-3 w-6 rounded bg-secondary animate-pulse" />
                <div className="flex-1 space-y-2">
                  <div className="h-3.5 w-1/2 rounded bg-secondary animate-pulse" />
                  <div className="h-3 w-1/4 rounded bg-secondary/70 animate-pulse" />
                </div>
              </div>
            ))}
          </div>
        ) : playlist && shown.length > 0 ? (
          <ol className="max-h-104 divide-y divide-border/60 overflow-y-auto">
            {shown.map(({ track, index }) => {
              const active = track.id === activeTrackId;
              const here = inFolder(track.id);
              const mark = markFor(
                statusOf(track.id),
                here,
                !folder && downloadedIds.has(track.id),
              );
              return (
                <li key={`${index}-${track.id}`} className="flex items-center">
                  {found && (
                    <span className="flex w-10 shrink-0 justify-end">
                      {!here && (
                        <input
                          type="checkbox"
                          checked={isTicked(track.id)}
                          disabled={running}
                          onChange={() =>
                            setChoices((current) => ({
                              ...current,
                              [track.id]: !isTicked(track.id),
                            }))
                          }
                          aria-label={`Download “${track.title}”`}
                          className="h-4 w-4 cursor-pointer accent-primary disabled:cursor-default"
                        />
                      )}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => onPick(track)}
                    aria-pressed={active}
                    aria-label={[
                      track.title,
                      track.artists && `by ${track.artists}`,
                      track.duration != null && formatDuration(track.duration),
                      mark?.detail,
                    ]
                      .filter(Boolean)
                      .join(", ")}
                    title={isYouTube ? "Open this video" : "Find this song on YouTube"}
                    className={cn(
                      "flex min-w-0 flex-1 items-center gap-3 py-2.5 pr-4 text-left transition-colors",
                      found ? "pl-3" : "pl-4",
                      active ? "bg-primary/5" : "hover:bg-secondary/40",
                    )}
                  >
                    <span className="w-6 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                      {index + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-medium text-foreground">
                          {track.title}
                        </span>
                        {track.explicit && (
                          <span
                            title="Explicit"
                            className="shrink-0 rounded-sm bg-muted-foreground/20 px-1 text-[9px] font-bold leading-4 text-muted-foreground"
                          >
                            E
                          </span>
                        )}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {track.artists}
                      </span>
                    </span>
                    {mark && (
                      <span
                        title={mark.detail}
                        className={cn(
                          "inline-flex shrink-0 items-center gap-1 text-xs font-medium tabular-nums",
                          mark.className,
                        )}
                      >
                        <mark.Icon className={cn("h-4 w-4", mark.spin && "animate-spin")} />
                        <span className="hidden sm:inline">{mark.text}</span>
                      </span>
                    )}
                    {track.duration != null && (
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {formatDuration(track.duration)}
                      </span>
                    )}
                    {isYouTube ? (
                      <ChevronRight
                        className={cn(
                          "h-4 w-4 shrink-0",
                          active ? "text-primary" : "text-muted-foreground/60",
                        )}
                      />
                    ) : active && isSearching ? (
                      <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                    ) : (
                      <Search
                        className={cn(
                          "h-4 w-4 shrink-0",
                          active ? "text-primary" : "text-muted-foreground/60",
                        )}
                      />
                    )}
                  </button>
                </li>
              );
            })}
          </ol>
        ) : playlist ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            {tracks.length === 0
              ? `This ${kind} has no songs ${from} shares.`
              : show === "missing" && missingIds.length === 0
                ? `Every song is in ${where}.`
                : `No songs match “${filter.trim()}”.`}
          </p>
        ) : null}

        {playlist?.maybeMore && (
          <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
            {isYouTube
              ? "The app lists the first 500 videos of a playlist. For a later one, copy its link on YouTube and paste it in the box."
              : "Spotify shares only the first 100 songs of a playlist. For a later one, copy its link in Spotify (Share → Copy Song Link) and paste it in the search box."}
          </p>
        )}
        {playlist && !folder && canChooseFolder && tracks.length > 0 && (
          <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
            Choose a folder under <span className="font-medium text-foreground">Save to</span>{" "}
            (above) to see which of these songs you already have — and download the rest in one go.
          </p>
        )}
      </div>
    </section>
  );
}
