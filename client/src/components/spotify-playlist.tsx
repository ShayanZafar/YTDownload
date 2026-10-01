import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  ListMusic,
  Loader2,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import type { SpotifyPlaylist, SpotifyPlaylistTrack } from "@shared/schema";
import { formatDuration } from "@/lib/format";
import { searchableText } from "@/lib/history-filter";
import { cn } from "@/lib/utils";

type SpotifyPlaylistPanelProps = {
  /** The playlist or album, once it has loaded. */
  playlist?: SpotifyPlaylist;
  isLoading: boolean;
  isRefreshing: boolean;
  error: Error | null;
  /** The song whose YouTube matches are showing (or being looked for). */
  activeTrackId?: string;
  isSearching: boolean;
  /** Spotify ids of the songs already in the download history. */
  downloadedIds: ReadonlySet<string>;
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

/**
 * The songs in a Spotify playlist or album. Clicking one looks for it on
 * YouTube, exactly like pasting that song's Spotify link: the best match is
 * picked, ready to download, with the other matches listed below it. Songs
 * already downloaded are marked, so you can work through a playlist.
 */
export function SpotifyPlaylistPanel({
  playlist,
  isLoading,
  isRefreshing,
  error,
  activeTrackId,
  isSearching,
  downloadedIds,
  onPick,
  onRefresh,
  onClose,
}: SpotifyPlaylistPanelProps) {
  const [filter, setFilter] = useState("");
  // A different playlist starts unfiltered.
  useEffect(() => setFilter(""), [playlist?.id]);

  const tracks = useMemo(() => playlist?.tracks ?? [], [playlist]);
  const shown = useMemo(
    () =>
      tracks
        .map((track, index) => ({ track, index }))
        .filter(({ track }) => matches(track, filter)),
    [tracks, filter],
  );
  const downloadedCount = useMemo(
    () => new Set(tracks.filter((t) => downloadedIds.has(t.id)).map((t) => t.id)).size,
    [tracks, downloadedIds],
  );
  const kind = playlist?.kind ?? "playlist";

  return (
    <section aria-label={`Spotify ${kind}`} className="max-w-3xl mx-auto w-full">
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
              Spotify {kind}
            </p>
            <h2 className="truncate text-base font-semibold text-foreground">
              {playlist?.name ?? (isLoading ? "Opening…" : "Couldn't open it")}
            </h2>
            {playlist && (
              <p className="truncate text-xs text-muted-foreground">
                {[
                  playlist.by && `by ${playlist.by}`,
                  `${tracks.length} ${tracks.length === 1 ? "song" : "songs"}`,
                  downloadedCount > 0 && `${downloadedCount} downloaded`,
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
                aria-label="Open in Spotify"
                title="Open in Spotify"
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
                aria-label="Reload the list from Spotify"
                title="Reload the list from Spotify"
                className="rounded-lg p-2 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors disabled:opacity-60"
              >
                <RefreshCw className={cn("h-4 w-4", isRefreshing && "animate-spin")} />
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label={`Close the Spotify ${kind}`}
              title="Close"
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
                className="h-9 min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
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
          <ol className="max-h-[26rem] divide-y divide-border/60 overflow-y-auto">
            {shown.map(({ track, index }) => {
              const active = track.id === activeTrackId;
              const downloaded = downloadedIds.has(track.id);
              return (
                <li key={`${index}-${track.id}`}>
                  <button
                    type="button"
                    onClick={() => onPick(track)}
                    aria-pressed={active}
                    aria-label={[
                      track.title,
                      track.artists && `by ${track.artists}`,
                      track.duration != null && formatDuration(track.duration),
                      downloaded && "downloaded",
                    ]
                      .filter(Boolean)
                      .join(", ")}
                    title="Find this song on YouTube"
                    className={cn(
                      "flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors",
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
                    {downloaded && (
                      <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary">
                        <CheckCircle2 className="h-4 w-4" />
                        <span className="hidden sm:inline">Downloaded</span>
                      </span>
                    )}
                    {track.duration != null && (
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {formatDuration(track.duration)}
                      </span>
                    )}
                    {active && isSearching ? (
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
              ? `This ${kind} has no songs Spotify shares.`
              : `No songs match “${filter.trim()}”.`}
          </p>
        ) : null}

        {playlist?.maybeMore && (
          <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
            Spotify shares only the first 100 songs of a playlist. For a later one, copy its link in
            Spotify (Share → Copy Song Link) and paste it in the search box.
          </p>
        )}
      </div>
    </section>
  );
}
