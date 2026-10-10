import { useMemo, useState } from "react";
import { Download, FileAudio, History, Loader2, X } from "lucide-react";
import { buildDownloadUrl, type DownloadFormat } from "@shared/routes";
import type { Download as HistoryEntry } from "@shared/schema";
import { Highlight, HistorySearch } from "@/components/history-search";
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
import { folderName, type ActiveSave, type SaveRequest } from "@/lib/save-to-folder";
import { cn } from "@/lib/utils";

// Recent Extractions shows this many at first, and this many more per "Show more".
const HISTORY_PAGE = 25;

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
  onDownload: (event: React.MouseEvent, href: string, request: SaveRequest) => boolean;
};

/**
 * Recent Extractions: the download history with Redownload links, searched
 * and filtered in the browser (lib/history-filter.ts), 25 at a time.
 */
export function RecentExtractions({
  history: allHistory,
  isLoading,
  format,
  folder,
  saves,
  onDownload,
}: RecentExtractionsProps) {
  const isOriginal = format === "original";
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
  const shownHistory = matchingHistory.slice(0, historyLimit);
  const isFilteringHistory = historyQuery.trim() !== "" || historyRange !== "all";
  const clearHistoryFilters = () => {
    setHistoryQuery("");
    setHistoryExact(false);
    setHistoryRange("all");
    setHistoryLimit(HISTORY_PAGE);
  };

  return (
    <section className="max-w-4xl mx-auto w-full space-y-4">
      <div className="flex items-center gap-2 px-2">
        <History className="w-5 h-5 text-muted-foreground" />
        <h2 className="text-xl font-display font-semibold">Recent Extractions</h2>
        {allHistory.length > 0 && (
          <span className="ml-auto text-sm text-muted-foreground tabular-nums" aria-live="polite">
            {isFilteringHistory
              ? `${matchingHistory.length} of ${allHistory.length}`
              : `${allHistory.length} ${allHistory.length === 1 ? "download" : "downloads"}`}
          </span>
        )}
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
                    </p>
                  </div>
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
                        onDownload(event, href, {
                          url: item.url,
                          format,
                          spotifyId: item.spotifyId,
                        })
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
                </li>
              );
            })}
          </ul>
          {matchingHistory.length > shownHistory.length && (
            <button
              type="button"
              onClick={() => setHistoryLimit((n) => n + HISTORY_PAGE)}
              className="w-full rounded-xl border border-border py-2.5 text-sm font-medium text-foreground hover:bg-secondary transition-colors"
            >
              Show more ({matchingHistory.length - shownHistory.length} more)
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
