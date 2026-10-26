import { useMemo, useState } from "react";
import { Download, FileAudio, History, Loader2, Pause, Play, Trash2, X } from "lucide-react";
import { buildDownloadUrl, type DownloadFormat } from "@shared/routes";
import type { Download as HistoryEntry } from "@shared/schema";
import { Highlight, HistorySearch } from "@/components/history-search";
import { useFolderMusic } from "@/hooks/use-folder-music";
import { useHistoryActions } from "@/hooks/use-history-actions";
import { useHistoryInFolder } from "@/hooks/use-history-in-folder";
import { usePlayer } from "@/hooks/use-player";
import { formatBytes, timeAgo, validDate } from "@/lib/format";
import {
  filterHistory,
  filterHistoryByTitle,
  historyRangeHints,
  historyRangeLabels,
  historyRangePhrases,
  historyRanges,
  type HistoryRange,
} from "@/lib/history-filter";
import { folderTrack, playlistQueue } from "@/lib/music";
import { folderName, type ActiveSave, type SaveRequest } from "@/lib/save-to-folder";
import { cn } from "@/lib/utils";

// Recent Extractions shows this many at first, and this many more per "Show more".
const HISTORY_PAGE = 25;

// With a "Save to" folder: every download, or only those in it, or those not.
const folderViews = ["all", "in", "missing"] as const;
type FolderView = (typeof folderViews)[number];

type RecentExtractionsProps = {
  /** The download history, newest first. */
  history: HistoryEntry[];
  isLoading: boolean;
  /** MP3 or the original audio, for the Redownload links. */
  format: DownloadFormat;
  /** The "Save to" folder, or null for the browser's downloads. */
  folder: string | null;
  /** Saves into the folder that are running, by their download link. */
  saves: Record<string, ActiveSave>;
  /** A Redownload link was clicked: false when the page handles it (a save into the folder). */
  /** `title`: what the song is called while it's saved. */
  onDownload: (
    event: React.MouseEvent,
    href: string,
    request: SaveRequest,
    title: string,
  ) => boolean;
  /** Finds a download's song (its id in the player) in Your music. */
  onLocate: (song: string) => void;
};

/**
 * Recent Extractions: the download history with Redownload links, searched
 * and filtered in the browser (lib/history-filter.ts), 25 at a time. A song
 * can be taken out of it (×), or the whole list cleared, with Undo after.
 * With a "Save to" folder (on the computer running the app), each download
 * says whether it's in the folder still, finds it in Your music (In folder)
 * and plays from there; the list can
 * show only the downloads in it, or only those that aren't.
 */
export function RecentExtractions({
  history: allHistory,
  isLoading,
  format,
  folder,
  saves,
  onDownload,
  onLocate,
}: RecentExtractionsProps) {
  const isOriginal = format === "original";
  const historyActions = useHistoryActions();
  // "Clear history" asks first, in place of the button.
  const [confirmingClear, setConfirmingClear] = useState(false);
  // Searching and filtering the list (all in the browser).
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyExact, setHistoryExact] = useState(false); // a suggestion was picked
  const [historyRange, setHistoryRange] = useState<HistoryRange>("all");
  const [historyLimit, setHistoryLimit] = useState(HISTORY_PAGE);
  const historyInRange = useMemo(
    () => filterHistory(allHistory, "", historyRange),
    [allHistory, historyRange],
  );
  const matchingHistory = useMemo(
    () =>
      historyExact
        ? filterHistoryByTitle(historyInRange, historyQuery, "all")
        : filterHistory(historyInRange, historyQuery, "all"),
    [historyInRange, historyQuery, historyExact],
  );
  // Which downloads are in the folder, and the folder's songs, to play them.
  const player = usePlayer();
  const inFolder = useHistoryInFolder(folder, allHistory);
  const folderMusic = useFolderMusic(folder);
  const found = inFolder.data?.found;
  const [folderView, setFolderView] = useState<FolderView>("all");
  const view = found ? folderView : "all";
  const listedHistory = useMemo(
    () =>
      view === "all" || !found
        ? matchingHistory
        : matchingHistory.filter((item) => (found[item.id] !== undefined) === (view === "in")),
    [matchingHistory, found, view],
  );
  // The listed downloads in the folder, as the player's songs, newest first.
  const folderQueue = useMemo(
    () =>
      found
        ? playlistQueue(
            listedHistory.map((item) => ({ id: String(item.id) })),
            found,
            (folderMusic.data?.tracks ?? []).map(folderTrack),
          )
        : [],
    [listedHistory, found, folderMusic.data],
  );
  const shownHistory = listedHistory.slice(0, historyLimit);
  const isFilteringHistory = historyQuery.trim() !== "" || historyRange !== "all" || view !== "all";
  const clearHistoryFilters = () => {
    setHistoryQuery("");
    setHistoryExact(false);
    setHistoryRange("all");
    setFolderView("all");
    setHistoryLimit(HISTORY_PAGE);
  };
  const folderViewLabels: Record<FolderView, string> = {
    all: "All",
    in: "In folder",
    missing: "Not in folder",
  };

  return (
    <section className="max-w-4xl mx-auto w-full space-y-4">
      <div className="flex items-center gap-2 px-2">
        <History className="w-5 h-5 text-muted-foreground" />
        <h2 className="text-xl font-display font-semibold">Recent Extractions</h2>
        {allHistory.length > 0 && (
          <span className="ml-auto text-sm text-muted-foreground tabular-nums" aria-live="polite">
            {isFilteringHistory
              ? `${listedHistory.length} of ${allHistory.length}`
              : `${allHistory.length} ${allHistory.length === 1 ? "download" : "downloads"}`}
          </span>
        )}
        {allHistory.length > 0 &&
          (confirmingClear ? (
            <div role="group" aria-label="Clear the history?" className="flex items-center gap-1">
              <span className="hidden text-xs text-muted-foreground sm:inline">Clear all?</span>
              <button
                type="button"
                autoFocus
                onClick={() => {
                  setConfirmingClear(false);
                  clearHistoryFilters();
                  void historyActions.clear();
                }}
                className="rounded-lg bg-destructive px-2.5 py-1 text-xs font-medium text-destructive-foreground hover:bg-destructive/90 transition-colors"
              >
                Clear history
              </button>
              <button
                type="button"
                onClick={() => setConfirmingClear(false)}
                className="rounded-lg px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingClear(true)}
              title="Empty the list (the downloaded files stay)"
              className="rounded-lg px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
            >
              Clear history
            </button>
          ))}
      </div>

      {allHistory.length > 0 && (
        <div className="space-y-2">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <HistorySearch
              entries={historyInRange}
              value={historyQuery}
              exact={historyExact}
              onChange={(value) => {
                setHistoryQuery(value);
                setHistoryExact(false);
                setHistoryLimit(HISTORY_PAGE);
              }}
              onPick={(title) => {
                setHistoryQuery(title);
                setHistoryExact(true);
                setHistoryLimit(HISTORY_PAGE);
              }}
            />
            <div
              role="group"
              aria-label="Show downloads from"
              className="inline-flex shrink-0 self-start rounded-full border border-border bg-secondary/60 p-1 sm:self-auto"
            >
              {historyRanges.map((range) => (
                <button
                  key={range}
                  type="button"
                  aria-pressed={historyRange === range}
                  onClick={() => {
                    setHistoryRange(range);
                    setHistoryLimit(HISTORY_PAGE);
                  }}
                  title={historyRangeHints[range]}
                  className={cn(
                    "rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
                    historyRange === range
                      ? "bg-card text-foreground shadow-xs"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {historyRangeLabels[range]}
                </button>
              ))}
            </div>
          </div>
          {folder && found && (
            <div
              role="group"
              aria-label={`Downloads in “${folderName(folder)}”`}
              className="inline-flex rounded-full border border-border bg-secondary/60 p-1"
            >
              {folderViews.map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={view === option}
                  onClick={() => {
                    setFolderView(option);
                    setHistoryLimit(HISTORY_PAGE);
                  }}
                  title={
                    option === "all"
                      ? "Every download"
                      : option === "in"
                        ? `Only the downloads that are in “${folderName(folder)}”`
                        : `Only the downloads that aren't in “${folderName(folder)}” (moved, renamed, deleted, or saved elsewhere)`
                  }
                  className={cn(
                    "rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
                    view === option
                      ? "bg-card text-foreground shadow-xs"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {folderViewLabels[option]}
                </button>
              ))}
            </div>
          )}
          {historyExact && (
            <p className="px-2 text-xs text-muted-foreground">
              Showing only “{historyQuery}”.{" "}
              <button
                type="button"
                onClick={() => {
                  setHistoryQuery("");
                  setHistoryExact(false);
                }}
                className="font-medium text-foreground underline underline-offset-2"
              >
                Show everything
              </button>
            </p>
          )}
        </div>
      )}

      {isLoading ? (
        <div className="rounded-2xl border border-border bg-card divide-y divide-border/60 overflow-hidden">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-3">
              <div className="w-9 h-9 shrink-0 rounded-lg bg-secondary animate-pulse" />
              <div className="flex-1 space-y-2">
                <div className="h-3.5 w-2/3 rounded bg-secondary animate-pulse" />
                <div className="h-3 w-1/4 rounded bg-secondary/70 animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      ) : shownHistory.length > 0 ? (
        <>
          <ul className="rounded-2xl border border-border bg-card divide-y divide-border/60 overflow-hidden">
            {shownHistory.map((item) => {
              const href = buildDownloadUrl(item.url, format, { spotifyId: item.spotifyId });
              const save = saves[href];
              const inThere = found?.[item.id];
              const track = inThere && folderQueue.find((t) => t.fileName === inThere.file);
              const isCurrent = !!track && player.current?.key === track.key;
              const isPlaying = isCurrent && player.status !== "paused";
              return (
                <li
                  key={item.id}
                  className="flex items-center gap-4 px-4 py-3 hover:bg-secondary/40 transition-colors"
                >
                  <div className="w-9 h-9 shrink-0 rounded-lg bg-primary/5 flex items-center justify-center text-primary">
                    <FileAudio className="w-4 h-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground truncate" title={item.title}>
                      <Highlight text={item.title} query={historyExact ? "" : historyQuery} />
                    </p>
                    <p
                      className="text-xs text-muted-foreground"
                      title={validDate(item.downloadedAt)?.toLocaleString()}
                    >
                      {timeAgo(item.downloadedAt)}
                      {item.source === "soundcloud" && " · from SoundCloud"}
                      {folder && found && (
                        <span>
                          {" · "}
                          {inThere ? (
                            <button
                              type="button"
                              onClick={() => onLocate(inThere.song)}
                              aria-label={`Show ${item.title} in Your music`}
                              title={`Show “${inThere.file}” in Your music`}
                              className="font-medium text-primary underline-offset-2 hover:underline"
                            >
                              In folder
                            </button>
                          ) : (
                            <span
                              title={
                                inFolder.data?.complete === false
                                  ? `Not among the songs looked at in “${folderName(folder)}” (it has more than the app looks through)`
                                  : `Not in “${folderName(folder)}”: moved, renamed, deleted, or saved elsewhere`
                              }
                            >
                              Not in folder
                            </span>
                          )}
                        </span>
                      )}
                    </p>
                  </div>
                  {inThere && (
                    <button
                      type="button"
                      disabled={!track}
                      onClick={() => {
                        if (!track) return;
                        if (isCurrent) return player.toggle();
                        player.play(folderQueue, folderQueue.indexOf(track), { shuffle: false });
                      }}
                      aria-label={`${isPlaying ? "Pause" : "Play"} ${item.title} from the folder`}
                      title={`${isPlaying ? "Pause" : "Play"} “${inThere.file}” from “${folderName(folder ?? "")}”`}
                      className="shrink-0 rounded-lg p-1.5 text-primary hover:bg-secondary transition-colors disabled:opacity-40"
                    >
                      {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                    </button>
                  )}
                  {save ? (
                    <button
                      type="button"
                      onClick={save.cancel}
                      aria-label={`Cancel saving ${item.title}`}
                      title="Cancel"
                      className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-secondary transition-colors"
                    >
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      {save.bytes > 0 && (
                        <span className="tabular-nums">{formatBytes(save.bytes)}</span>
                      )}
                      <X className="w-3.5 h-3.5" />
                    </button>
                  ) : (
                    <a
                      href={href}
                      download
                      onClick={(event) =>
                        onDownload(
                          event,
                          href,
                          { url: item.url, format, spotifyId: item.spotifyId },
                          item.title,
                        )
                      }
                      aria-label={`Redownload ${item.title}`}
                      title={
                        folder
                          ? `Save again to “${folderName(folder)}”`
                          : isOriginal
                            ? "Redownload the original audio"
                            : "Redownload as MP3"
                      }
                      className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-secondary transition-colors"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span className="hidden sm:inline">Redownload</span>
                    </a>
                  )}
                  <button
                    type="button"
                    onClick={() => void historyActions.remove(item)}
                    aria-label={`Remove ${item.title} from the history`}
                    title="Remove from the history (the file stays)"
                    className="-mr-1.5 shrink-0 rounded-lg p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </li>
              );
            })}
          </ul>
          {listedHistory.length > shownHistory.length && (
            <button
              type="button"
              onClick={() => setHistoryLimit((n) => n + HISTORY_PAGE)}
              className="w-full rounded-xl border border-border py-2.5 text-sm font-medium text-foreground hover:bg-secondary transition-colors"
            >
              Show more ({listedHistory.length - shownHistory.length} more)
            </button>
          )}
        </>
      ) : allHistory.length > 0 ? (
        <div className="text-center py-10 px-4 rounded-3xl border border-dashed border-border/60 bg-secondary/20">
          <p className="text-sm font-medium text-foreground">Nothing found</p>
          <p className="text-sm text-muted-foreground mt-1">
            No extractions{" "}
            {[
              historyRangePhrases[historyRange],
              view === "in" && folder && `in “${folderName(folder)}”`,
              view === "missing" && folder && `missing from “${folderName(folder)}”`,
              historyQuery.trim() && `match “${historyQuery.trim()}”`,
            ]
              .filter(Boolean)
              .join(" ")}
            .
          </p>
          <button
            type="button"
            onClick={clearHistoryFilters}
            className="mt-3 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-secondary transition-colors"
          >
            Clear search and filters
          </button>
        </div>
      ) : (
        <div className="text-center py-16 px-4 rounded-3xl border border-dashed border-border/60 bg-secondary/20 flex flex-col items-center">
          <div className="w-12 h-12 rounded-full bg-secondary flex items-center justify-center mb-4">
            <FileAudio className="w-6 h-6 text-muted-foreground" />
          </div>
          <h3 className="text-lg font-medium text-foreground">No downloads yet</h3>
          <p className="text-sm text-muted-foreground mt-1 max-w-sm">
            Your recent audio extractions will appear here for quick access later.
          </p>
        </div>
      )}
    </section>
  );
}
