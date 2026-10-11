import { BadgeCheck, Check, Cloud, Play, Timer, X } from "lucide-react";
import {
  SAME_LENGTH_SECONDS,
  type AudioSource,
  type SearchResult,
  type SpotifyTrack,
} from "@shared/schema";
import { extractVideoId } from "@shared/youtube-link";
import { VideoPreview } from "@/components/video-preview";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";

type SearchResultsProps = {
  isSearching: boolean;
  results?: SearchResult[];
  /** The Spotify song searched for, when the search was its link. */
  spotify?: SpotifyTrack;
  searchedFor?: string;
  /** Where the results are from: YouTube, or SoundCloud. */
  source?: AudioSource;
  /** The search asked SoundCloud alone (rather than SoundCloud standing in for YouTube). */
  soundCloudOnly?: boolean;
  /** Runs the same search on SoundCloud alone — offered over YouTube's results. */
  onSearchSoundCloud?: () => void;
  /** The video in the preview card. */
  selectedUrl?: string;
  /** The result whose video is playing in the list. */
  previewing: string | null;
  onTogglePreview: (id: string) => void;
  onClosePreview: () => void;
  onPick: (result: SearchResult, song?: SpotifyTrack) => void;
  onClose: () => void;
};

/**
 * The song search's results (or a Spotify song's matches) — YouTube's, or
 * SoundCloud's when YouTube couldn't answer or you asked SoundCloud (each
 * marked "SoundCloud"): click one to choose it, or a YouTube video's
 * thumbnail to watch or listen to it right in the list. Over YouTube's
 * results, **Search SoundCloud** looks there instead — for a song YouTube
 * won't hand over while it's limiting this computer.
 */
export function SearchResults({
  isSearching,
  results,
  spotify,
  searchedFor,
  source,
  soundCloudOnly = false,
  onSearchSoundCloud,
  selectedUrl,
  previewing,
  onTogglePreview,
  onClosePreview,
  onPick,
  onClose,
}: SearchResultsProps) {
  // SoundCloud's results: asked for, or standing in for YouTube's (its search
  // failed or found nothing — YouTube may be limiting this computer).
  const fromSoundCloud =
    source === "soundcloud" || (results?.some((result) => result.source === "soundcloud") ?? false);
  return (
    <section aria-label="Search results" className="max-w-3xl mx-auto w-full space-y-4">
      <div className="flex items-center justify-between gap-4 px-2">
        <h2 className="text-xl font-display font-semibold truncate">
          {isSearching
            ? "Searching..."
            : spotify
              ? `${fromSoundCloud ? "SoundCloud" : "YouTube"} matches`
              : `Results for “${searchedFor}”`}
        </h2>
        <div className="flex shrink-0 items-center gap-3">
          {!isSearching && results && results.length > 0 && (
            <p className="hidden sm:block text-xs text-muted-foreground">
              {spotify
                ? "Same length as the Spotify song first"
                : fromSoundCloud
                  ? soundCloudOnly
                    ? "From SoundCloud"
                    : "From SoundCloud: YouTube couldn't answer"
                  : "Official uploads (artist or label) first"}
            </p>
          )}
          {!isSearching && !fromSoundCloud && onSearchSoundCloud && (
            <button
              type="button"
              onClick={onSearchSoundCloud}
              title="Look for this on SoundCloud instead — when YouTube won't hand a song over"
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
            >
              <Cloud className="w-4 h-4" />
              <span>Search SoundCloud</span>
            </button>
          )}
          {/* Done with the results (e.g. after downloading): hide them. The
              chosen video stays in the preview card above. */}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close search results"
            title="Close search results"
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
          >
            <X className="w-4 h-4" />
            <span className="hidden sm:inline">Close</span>
          </button>
        </div>
      </div>

      {!isSearching && spotify && (
        <div className="flex items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3">
          {spotify.thumbnail && (
            <img
              src={spotify.thumbnail}
              alt=""
              className="w-12 h-12 shrink-0 rounded-md object-cover"
            />
          )}
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              From Spotify
            </p>
            <p className="text-sm font-medium text-foreground truncate">{spotify.title}</p>
            <p className="text-xs text-muted-foreground truncate">
              {spotify.artists.join(", ")}
              {spotify.duration != null && ` · ${formatDuration(spotify.duration)}`}
            </p>
          </div>
        </div>
      )}

      {isSearching ? (
        <div className="rounded-2xl border border-border bg-card divide-y divide-border/60 overflow-hidden">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-3">
              <div className="w-24 sm:w-28 aspect-video shrink-0 rounded-lg bg-secondary animate-pulse" />
              <div className="flex-1 space-y-2">
                <div className="h-3.5 w-3/4 rounded bg-secondary animate-pulse" />
                <div className="h-3 w-1/3 rounded bg-secondary/70 animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      ) : results && results.length > 0 ? (
        <ul className="rounded-2xl border border-border bg-card divide-y divide-border/60 overflow-hidden">
          {results.map((result) => {
            const isPicked = selectedUrl === result.url;
            const sameLength =
              spotify?.duration != null &&
              result.duration != null &&
              Math.abs(result.duration - spotify.duration) <= SAME_LENGTH_SECONDS;
            const videoId = extractVideoId(result.url);
            const isPreviewing = videoId !== null && previewing === result.id;
            return (
              <li
                key={result.id}
                className={cn(
                  "transition-colors",
                  isPicked ? "bg-primary/5" : !isPreviewing && "hover:bg-secondary/40",
                )}
              >
                <div className="flex items-stretch">
                  {/* The thumbnail plays the video right here, before choosing it */}
                  <button
                    type="button"
                    disabled={videoId === null}
                    onClick={() => onTogglePreview(result.id)}
                    aria-pressed={isPreviewing}
                    aria-label={`${isPreviewing ? "Close preview of" : "Preview"} ${result.title}`}
                    title={
                      videoId === null
                        ? undefined
                        : isPreviewing
                          ? "Close the preview"
                          : "Watch or listen before downloading"
                    }
                    className="group shrink-0 self-center py-3 pl-4"
                  >
                    <div className="relative w-24 sm:w-28 aspect-video overflow-hidden rounded-lg bg-secondary">
                      {result.thumbnail && (
                        <img
                          src={result.thumbnail}
                          alt=""
                          loading="lazy"
                          className="w-full h-full object-cover"
                        />
                      )}
                      {videoId !== null && (
                        <span
                          className={cn(
                            "absolute inset-0 flex items-center justify-center transition-colors",
                            isPreviewing ? "bg-black/55" : "bg-black/0 group-hover:bg-black/35",
                          )}
                        >
                          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-black/70 text-white">
                            {isPreviewing ? (
                              <X className="w-4 h-4" />
                            ) : (
                              <Play className="w-4 h-4 translate-x-px fill-current" />
                            )}
                          </span>
                        </span>
                      )}
                      {result.duration != null && (
                        <span className="absolute bottom-1 right-1 rounded bg-black/75 px-1 text-[10px] font-semibold text-white">
                          {formatDuration(result.duration)}
                        </span>
                      )}
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => onPick(result, spotify)}
                    aria-pressed={isPicked}
                    aria-label={[
                      result.title,
                      result.channel && `by ${result.channel}`,
                      result.official && "official upload",
                      result.source === "soundcloud" && "on SoundCloud",
                      sameLength && "same length as the Spotify song",
                      result.duration != null && formatDuration(result.duration),
                    ]
                      .filter(Boolean)
                      .join(", ")}
                    className="min-w-0 flex-1 flex items-center gap-4 py-3 pl-4 pr-4 text-left"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-foreground line-clamp-2">
                        {result.title}
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                        <span className="truncate max-w-full">{result.channel}</span>
                        {result.official && (
                          <span
                            title="Uploaded by the artist or their label"
                            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary"
                          >
                            <BadgeCheck className="w-3 h-3" />
                            Official
                          </span>
                        )}
                        {result.source === "soundcloud" && (
                          <span
                            title="On SoundCloud"
                            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[10px] font-semibold text-foreground"
                          >
                            <Cloud className="w-3 h-3" />
                            SoundCloud
                          </span>
                        )}
                        {sameLength && (
                          <span
                            title="Same length as the Spotify song, so most likely the same recording"
                            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[10px] font-semibold text-foreground"
                          >
                            <Timer className="w-3 h-3" />
                            Same length
                          </span>
                        )}
                      </div>
                    </div>
                    {isPicked ? (
                      <span className="shrink-0 inline-flex items-center gap-1 text-xs font-semibold text-primary">
                        <Check className="w-4 h-4" />
                        <span className="hidden sm:inline">Selected</span>
                      </span>
                    ) : (
                      <span className="hidden sm:inline-flex shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground">
                        Choose
                      </span>
                    )}
                  </button>
                </div>
                {isPreviewing && (
                  <VideoPreview
                    videoId={videoId}
                    title={result.title}
                    url={result.url}
                    isPicked={isPicked}
                    onChoose={() => onPick(result, spotify)}
                    onClose={onClosePreview}
                  />
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="text-center py-10 px-4 rounded-3xl border border-dashed border-border/60 bg-secondary/20">
          <p className="text-sm font-medium text-foreground">
            {spotify ? "No uploads of this song found" : "No songs found"}
          </p>
          <p className="text-sm text-muted-foreground mt-1">
            Try the artist and song title, or paste a YouTube or Spotify link.
          </p>
        </div>
      )}
    </section>
  );
}
