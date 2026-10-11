import { useEffect, useMemo, useRef } from "react";
import { Loader2, MicVocal, X } from "lucide-react";
import { useLyrics } from "@/hooks/use-lyrics";
import { usePlayer, usePlayerTime } from "@/hooks/use-player";
import { currentLine } from "@/lib/lyrics";
import { cn } from "@/lib/utils";

// After you scroll the lyrics yourself, they stay where you put them this long.
const HANDS_OFF_MS = 4000;

/**
 * The song's lyrics, opened from the player bar. Synced lyrics follow the
 * song — the line being sung is highlighted and kept in view — and clicking a
 * line plays from there. Otherwise the words are shown as they are. They come
 * from LRCLIB, a free lyrics library (server/lyrics.ts).
 */
export function LyricsPanel({ onClose }: { onClose: () => void }) {
  const player = usePlayer();
  const { time } = usePlayerTime();
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const scrolledByHand = useRef(0);
  const { current } = player;
  const { data, isLoading, error, refetch, isFetching } = useLyrics(current, true);
  const lyrics = data?.lyrics ?? null;
  const lines = useMemo(() => lyrics?.synced ?? [], [lyrics]);
  const now = currentLine(lines, time);

  // Esc closes it, and keyboard users start inside it.
  useEffect(() => {
    panelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Keep the line being sung in the middle of the list (only the list scrolls,
  // never the page), unless you've just scrolled it yourself.
  useEffect(() => {
    const list = listRef.current;
    const line = list?.children[Math.max(now, 0)] as HTMLElement | undefined;
    if (!list || !line || Date.now() - scrolledByHand.current < HANDS_OFF_MS) return;
    list.scrollTop = line.offsetTop - list.clientHeight / 2 + line.clientHeight / 2;
  }, [now, lines]);

  const notedHandScroll = () => {
    scrolledByHand.current = Date.now();
  };

  return (
    <div
      ref={panelRef}
      id="player-lyrics"
      role="region"
      aria-label="Lyrics"
      tabIndex={-1}
      className="absolute bottom-full right-3 mb-2 flex max-h-[60vh] w-[min(28rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xl focus:outline-hidden sm:right-6"
    >
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <MicVocal className="h-4 w-4 shrink-0 text-muted-foreground" />
        <h2 className="text-sm font-semibold text-foreground">Lyrics</h2>
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {current ? [current.title, current.artist].filter(Boolean).join(" · ") : ""}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close the lyrics"
          className="ml-auto shrink-0 rounded-lg p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {isLoading ? (
        <p className="flex items-center justify-center gap-2 px-4 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Looking up the lyrics…
        </p>
      ) : error ? (
        <div className="px-4 py-6 text-center text-sm" role="alert">
          <p className="text-destructive">{error.message}</p>
          <button
            type="button"
            onClick={() => void refetch()}
            disabled={isFetching}
            className="mt-3 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
          >
            Try again
          </button>
        </div>
      ) : !lyrics ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">
          No lyrics found for this song.
        </p>
      ) : lyrics.instrumental ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">
          This one's an instrumental: no words.
        </p>
      ) : lines.length > 0 ? (
        <ol
          ref={listRef}
          aria-label="Lines of the song"
          onWheel={notedHandScroll}
          onTouchMove={notedHandScroll}
          className="relative overflow-y-auto px-2 py-3"
        >
          {lines.map((line, i) => (
            <li key={`${i}-${line.time}`}>
              <button
                type="button"
                onClick={() => player.seek(line.time)}
                aria-current={i === now ? "true" : undefined}
                title="Play from here"
                className={cn(
                  "block w-full rounded-lg px-2 py-1 text-left text-[15px] leading-snug transition-colors hover:bg-secondary/60",
                  i === now
                    ? "font-semibold text-foreground"
                    : i < now
                      ? "text-muted-foreground/70"
                      : "text-muted-foreground",
                )}
              >
                {line.text || "♪"}
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="overflow-y-auto whitespace-pre-line px-4 py-3 text-[15px] leading-relaxed text-foreground">
          {lyrics.plain}
        </p>
      )}

      <p className="border-t border-border px-4 py-1.5 text-[11px] text-muted-foreground">
        From{" "}
        <a
          href="https://lrclib.net"
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2 hover:text-foreground"
        >
          LRCLIB
        </a>
        {lyrics && !lyrics.instrumental && lines.length === 0 ? " (not timed for this song)" : ""}
      </p>
    </div>
  );
}
