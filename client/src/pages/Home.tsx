import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useToast } from "@/hooks/use-toast";
import { Layout } from "@/components/layout";
import { useVideoInfo, useRecentDownloads, useSongSearch } from "@/hooks/use-youtube";
import { useDownloadFormat } from "@/hooks/use-download-format";
import { useStoredChoice } from "@/hooks/use-stored-choice";
import { asLink, formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { buildDownloadUrl } from "@shared/routes";
import type { SearchResult } from "@shared/schema";
import { formatDistanceToNow } from "date-fns";
import {
  Search,
  ArrowRight,
  Music,
  Loader2,
  Download,
  AlertCircle,
  FileAudio,
  History,
  Link2,
  BadgeCheck,
  Check,
} from "lucide-react";

// Paste a link, or search by song title. The last one used is remembered.
const inputModes = ["link", "search"] as const;
type InputMode = (typeof inputModes)[number];

// What the preview card shows: a video opened from a link or picked from the
// search results.
type Selected = {
  url: string;
  title: string;
  thumbnail: string;
  channel?: string;
  duration?: number | null;
};

// A download started from this page that hasn't shown up in the history yet.
// The server only records a download once it has fully completed, so we keep
// refreshing the history until it appears — or give up after a while, since
// a cancelled download never will.
type PendingDownload = { url: string; afterId: number; startedAt: number };
const PENDING_TIMEOUT_MS = 15 * 60_000;
const HISTORY_POLL_MS = 3_000;

// The history file is plain JSON on disk, so don't trust its dates blindly:
// an unreadable one shows as "Recently" instead of crashing the list.
function validDate(iso: string): Date | undefined {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function timeAgo(iso: string): string {
  const date = validDate(iso);
  return date ? formatDistanceToNow(date, { addSuffix: true }) : "Recently";
}

export default function Home() {
  const [text, setText] = useState("");
  const [mode, setMode] = useStoredChoice<InputMode>("input-mode", inputModes, "link");
  const [selected, setSelected] = useState<Selected | null>(null);
  const [format, setFormat] = useDownloadFormat();
  const isOriginal = format === "original";
  const { toast } = useToast();
  const [pending, setPending] = useState<PendingDownload[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const previewRef = useRef<HTMLElement>(null);
  const [scrollRequest, setScrollRequest] = useState(0);

  const {
    mutate: fetchInfo,
    isPending: isFetchingInfo,
    error: infoError,
    reset: resetInfo,
  } = useVideoInfo();
  const {
    mutate: search,
    isPending: isSearching,
    data: results,
    variables: searchedFor,
    error: searchError,
    reset: resetSearch,
  } = useSongSearch();
  const { data: recentDownloads, isLoading: isLoadingHistory } = useRecentDownloads(
    pending.length > 0 ? HISTORY_POLL_MS : false,
  );
  const isBusy = isFetchingInfo || isSearching;
  const error = infoError ?? searchError;

  // Stop waiting for a download once it's in the history (or has timed out).
  useEffect(() => {
    if (pending.length === 0) return;
    const prune = () =>
      setPending((current) =>
        current.filter(
          (p) =>
            Date.now() - p.startedAt < PENDING_TIMEOUT_MS &&
            !recentDownloads?.some((d) => d.url === p.url && d.id > p.afterId),
        ),
      );
    prune();
    const timer = setInterval(prune, 30_000);
    return () => clearInterval(timer);
  }, [recentDownloads, pending.length]);

  // After picking a search result, bring the preview card (with its Download
  // button) into view — it sits above the results list.
  useEffect(() => {
    if (scrollRequest === 0) return;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    previewRef.current?.scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "center",
    });
  }, [scrollRequest]);

  const watchForDownload = (downloadUrl: string) => {
    const afterId = Math.max(0, ...(recentDownloads ?? []).map((d) => d.id));
    setPending((current) => [...current, { url: downloadUrl, afterId, startedAt: Date.now() }]);
  };

  const switchMode = (next: InputMode) => {
    setMode(next);
    inputRef.current?.focus();
  };

  const extract = (link: string) => {
    fetchInfo(link, {
      onSuccess: (info) => setSelected(info),
      onError: (err) => {
        toast({
          title: "Couldn't fetch video",
          description: err.message,
          variant: "destructive",
        });
      },
    });
  };

  const runSearch = (query: string) => {
    search(query, {
      onError: (err) => {
        toast({ title: "Search failed", description: err.message, variant: "destructive" });
      },
    });
  };

  // Whatever the mode, a link is opened and anything else is searched for —
  // switching the toggle to match, so pasting a link into the search box works.
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const value = text.trim();
    if (!value) return;

    const link = asLink(value);
    if (link) {
      if (mode !== "link") setMode("link");
      extract(link);
    } else {
      if (mode !== "search") setMode("search");
      runSearch(value);
    }
  };

  const pick = (result: SearchResult) => {
    resetInfo();
    setSelected({
      url: result.url,
      title: result.title,
      thumbnail: result.thumbnail,
      channel: result.channel,
      duration: result.duration,
    });
    setScrollRequest((n) => n + 1);
  };

  const clear = () => {
    resetInfo();
    resetSearch();
    setSelected(null);
    setText("");
    inputRef.current?.focus();
  };

  const handleDownload = () => {
    if (!selected) return;

    toast({
      title: "Download Started",
      description: isOriginal
        ? "Fetching the original audio from YouTube. It'll appear in Recent Extractions once it finishes."
        : "Converting to MP3. It'll appear in Recent Extractions once it finishes.",
    });
    watchForDownload(selected.url);
  };

  return (
    <Layout>
      {/* Hero Section */}
      <section className="flex flex-col items-center text-center space-y-6 w-full max-w-2xl mx-auto pt-8">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-secondary text-secondary-foreground text-sm font-medium border border-border">
          <span className="flex h-2 w-2 rounded-full bg-primary animate-pulse" />
          High Quality Audio Extraction
        </div>

        <h1 className="text-3xl sm:text-4xl md:text-6xl font-display font-extrabold tracking-tight text-foreground leading-[1.1]">
          Convert any YouTube video to{" "}
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary/80 to-primary">
            pure audio.
          </span>
        </h1>

        <p className="text-lg text-muted-foreground leading-relaxed max-w-xl">
          Paste a link or search for a song to extract crisp, high-quality audio from your favorite
          music, videos, podcasts, and lectures.
        </p>

        {/* Link / Search switch */}
        <div
          role="group"
          aria-label="Find audio by"
          className="mt-8 inline-flex rounded-full border border-border bg-secondary/60 p-1"
        >
          {(
            [
              ["link", "Paste a link", Link2],
              ["search", "Search by song", Search],
            ] as const
          ).map(([value, label, Icon]) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              onClick={() => switchMode(value)}
              className={cn(
                "inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-colors",
                mode === value
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="w-4 h-4" />
              {label}
            </button>
          ))}
        </div>

        {/* Input Form */}
        <form onSubmit={handleSubmit} noValidate className="w-full relative mt-4 group">
          <div className="absolute inset-0 bg-primary/5 blur-2xl rounded-3xl transition-opacity duration-500 opacity-0 group-hover:opacity-100" />
          <div className="relative flex items-center w-full bg-card rounded-2xl shadow-lg shadow-black/5 border border-border focus-within:ring-4 focus-within:ring-primary/10 transition-all duration-300 p-2">
            {mode === "link" ? (
              <Link2 className="w-5 h-5 sm:w-6 sm:h-6 shrink-0 text-muted-foreground ml-3 sm:ml-4 mr-1 sm:mr-2" />
            ) : (
              <Search className="w-5 h-5 sm:w-6 sm:h-6 shrink-0 text-muted-foreground ml-3 sm:ml-4 mr-1 sm:mr-2" />
            )}
            <input
              ref={inputRef}
              type={mode === "link" ? "url" : "search"}
              aria-label={mode === "link" ? "YouTube link" : "Song search"}
              placeholder={
                mode === "link"
                  ? "https://www.youtube.com/watch?v=..."
                  : "Artist and song, e.g. Daft Punk Get Lucky"
              }
              enterKeyHint={mode === "link" ? "go" : "search"}
              className="flex-1 w-0 min-w-0 bg-transparent border-none text-foreground placeholder:text-muted-foreground h-14 px-2 text-base sm:text-lg focus:outline-none"
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                if (infoError) resetInfo();
                if (searchError) resetSearch();
              }}
            />
            <button
              type="submit"
              disabled={isBusy || !text.trim()}
              aria-label={mode === "link" ? "Extract" : "Search"}
              className="h-14 shrink-0 px-4 sm:px-6 md:px-8 rounded-xl bg-primary text-primary-foreground font-semibold flex items-center gap-2 hover-elevate disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:-translate-y-0 transition-all"
            >
              {isBusy ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  <span className="hidden sm:inline">
                    {isSearching ? "Searching..." : "Processing..."}
                  </span>
                </>
              ) : mode === "link" ? (
                <>
                  <span className="hidden sm:inline">Extract</span>
                  <ArrowRight className="w-5 h-5" />
                </>
              ) : (
                <>
                  <span className="hidden sm:inline">Search</span>
                  <Search className="w-5 h-5" />
                </>
              )}
            </button>
          </div>
        </form>
      </section>

      {/* Result Section */}
      <AnimatePresence mode="wait">
        {selected && (
          <motion.section
            key="preview"
            ref={previewRef}
            initial={{ opacity: 0, y: 20, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20, scale: 0.98 }}
            transition={{ duration: 0.4, ease: [0.23, 1, 0.32, 1] }}
            className="w-full max-w-3xl mx-auto scroll-mt-24"
          >
            <div className="glass-card rounded-[2rem] p-4 md:p-6 flex flex-col md:flex-row gap-6 items-center">
              {/* Thumbnail */}
              <div className="w-full md:w-1/2 aspect-video relative rounded-2xl overflow-hidden shadow-md group">
                <img
                  src={selected.thumbnail}
                  alt={selected.title}
                  className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                <div className="absolute bottom-3 left-3 bg-black/70 backdrop-blur-md text-white text-xs font-semibold px-2.5 py-1 rounded-md flex items-center gap-1.5">
                  <Music className="w-3 h-3" /> Audio Track
                </div>
              </div>

              {/* Info & Action */}
              <div className="flex-1 flex flex-col items-center text-center md:items-start md:text-left gap-4 w-full">
                <div>
                  <h3 className="font-display font-bold text-xl md:text-2xl line-clamp-3 text-foreground">
                    {selected.title}
                  </h3>
                  {selected.channel && (
                    <p className="mt-1 text-sm text-muted-foreground">
                      {selected.channel}
                      {selected.duration != null && ` · ${formatDuration(selected.duration)}`}
                    </p>
                  )}
                </div>

                <p className="text-sm text-muted-foreground line-clamp-1">
                  {isOriginal
                    ? "Ready to download the original audio."
                    : "Ready to download as a 320 kbps MP3."}
                </p>

                <div className="mt-2 w-full">
                  <a
                    href={buildDownloadUrl(selected.url, format)}
                    download
                    onClick={handleDownload}
                    className="w-full flex items-center justify-center gap-2 h-14 rounded-xl bg-foreground text-background font-semibold hover-elevate active-elevate-2 transition-all shadow-xl shadow-foreground/20"
                  >
                    <Download className="w-5 h-5" />
                    Download Audio
                    <span className="font-normal opacity-60">
                      · {isOriginal ? "Original" : "MP3"}
                    </span>
                  </a>

                  <div className="mt-3 flex items-start justify-between gap-4 rounded-xl border border-border px-4 py-3 text-left">
                    <div>
                      <Label
                        htmlFor="original-audio"
                        className="text-sm font-medium text-foreground cursor-pointer"
                      >
                        Original audio
                      </Label>
                      <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                        YouTube's own stream, not converted (usually .opus). Smaller and untouched;
                        plays in VLC, but not on some phones and car stereos.
                      </p>
                    </div>
                    <Switch
                      id="original-audio"
                      checked={isOriginal}
                      onCheckedChange={(on) => setFormat(on ? "original" : "mp3")}
                      className="mt-0.5"
                    />
                  </div>

                  <button
                    onClick={clear}
                    className="w-full mt-3 text-sm text-muted-foreground hover:text-foreground transition-colors font-medium"
                  >
                    Clear and start over
                  </button>
                </div>
              </div>
            </div>
          </motion.section>
        )}

        {error && (
          <motion.div
            key="error"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="max-w-2xl mx-auto w-full"
          >
            <div className="bg-destructive/10 text-destructive-foreground border border-destructive/20 rounded-2xl p-4 flex items-center gap-3">
              <AlertCircle className="w-5 h-5 text-destructive" />
              <p className="text-sm font-medium text-destructive">{error.message}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Search results */}
      {(isSearching || results) && (
        <section aria-label="Search results" className="max-w-3xl mx-auto w-full space-y-4">
          <div className="flex items-baseline justify-between gap-4 px-2">
            <h2 className="text-xl font-display font-semibold truncate">
              {isSearching ? "Searching YouTube..." : `Results for “${searchedFor}”`}
            </h2>
            {!isSearching && results && results.length > 0 && (
              <p className="hidden sm:block shrink-0 text-xs text-muted-foreground">
                Official uploads (artist or label) first
              </p>
            )}
          </div>

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
                const isPicked = selected?.url === result.url;
                return (
                  <li key={result.id}>
                    <button
                      type="button"
                      onClick={() => pick(result)}
                      aria-pressed={isPicked}
                      aria-label={[
                        result.title,
                        result.channel && `by ${result.channel}`,
                        result.official && "official upload",
                        result.duration != null && formatDuration(result.duration),
                      ]
                        .filter(Boolean)
                        .join(", ")}
                      className={cn(
                        "w-full flex items-center gap-4 px-4 py-3 text-left transition-colors",
                        isPicked ? "bg-primary/5" : "hover:bg-secondary/40",
                      )}
                    >
                      <div className="relative w-24 sm:w-28 aspect-video shrink-0 overflow-hidden rounded-lg bg-secondary">
                        <img
                          src={result.thumbnail}
                          alt=""
                          loading="lazy"
                          className="w-full h-full object-cover"
                        />
                        {result.duration != null && (
                          <span className="absolute bottom-1 right-1 rounded bg-black/75 px-1 text-[10px] font-semibold text-white">
                            {formatDuration(result.duration)}
                          </span>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-foreground line-clamp-2">
                          {result.title}
                        </p>
                        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                          <span className="truncate">{result.channel}</span>
                          {result.official && (
                            <span
                              title="Uploaded by the artist or their label"
                              className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary"
                            >
                              <BadgeCheck className="w-3 h-3" />
                              Official
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
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="text-center py-10 px-4 rounded-3xl border border-dashed border-border/60 bg-secondary/20">
              <p className="text-sm font-medium text-foreground">No songs found</p>
              <p className="text-sm text-muted-foreground mt-1">
                Try the artist and song title, or paste a YouTube link.
              </p>
            </div>
          )}
        </section>
      )}

      {/* Recent History */}
      <section className="mt-12 max-w-4xl mx-auto w-full space-y-6">
        <div className="flex items-center gap-2 px-2">
          <History className="w-5 h-5 text-muted-foreground" />
          <h2 className="text-xl font-display font-semibold">Recent Extractions</h2>
        </div>

        {isLoadingHistory ? (
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
        ) : recentDownloads && recentDownloads.length > 0 ? (
          <ul className="rounded-2xl border border-border bg-card divide-y divide-border/60 overflow-hidden">
            {recentDownloads.map((item) => (
              <li
                key={item.id}
                className="flex items-center gap-4 px-4 py-3 hover:bg-secondary/40 transition-colors"
              >
                <div className="w-9 h-9 shrink-0 rounded-lg bg-primary/5 flex items-center justify-center text-primary">
                  <FileAudio className="w-4 h-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground truncate" title={item.title}>
                    {item.title}
                  </p>
                  <p
                    className="text-xs text-muted-foreground"
                    title={validDate(item.downloadedAt)?.toLocaleString()}
                  >
                    {timeAgo(item.downloadedAt)}
                  </p>
                </div>
                <a
                  href={buildDownloadUrl(item.url, format)}
                  download
                  onClick={() => watchForDownload(item.url)}
                  aria-label={`Redownload ${item.title}`}
                  title={isOriginal ? "Redownload the original audio" : "Redownload as MP3"}
                  className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-secondary transition-colors"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Redownload</span>
                </a>
              </li>
            ))}
          </ul>
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
    </Layout>
  );
}
