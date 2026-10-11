import { useEffect, useRef } from "react";
import { ListMusic, X } from "lucide-react";
import { usePlayer } from "@/hooks/use-player";
import { formatDuration } from "@/lib/format";

// Songs listed (a whole folder can be queued; the rest are counted).
const SHOWN = 100;

const countSongs = (n: number) => `${n.toLocaleString()} ${n === 1 ? "song" : "songs"}`;

/**
 * The player's queue, opened from the player bar: the songs after the
 * current one, in the order they'll play. Click one to play it now, or take
 * it out of the queue (×); Clear empties it.
 */
export function UpNext({ onClose }: { onClose: () => void }) {
  const player = usePlayer();
  const panelRef = useRef<HTMLDivElement>(null);
  const { upNext } = player;

  // Esc closes it, and keyboard users start inside it.
  useEffect(() => {
    panelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      ref={panelRef}
      id="player-up-next"
      role="region"
      aria-label="Up next"
      tabIndex={-1}
      className="absolute bottom-full right-3 mb-2 flex max-h-[60vh] w-[min(26rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xl focus:outline-hidden sm:right-6"
    >
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <ListMusic className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold text-foreground">Up next</h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          {upNext.length > 0 ? countSongs(upNext.length) : ""}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {upNext.length > 0 && (
            <button
              type="button"
              onClick={player.clearUpNext}
              className="rounded-lg px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
            >
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Up next"
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {upNext.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">
          {player.repeat === "all"
            ? "The list starts again after this song."
            : "Nothing after this song. Add songs with Play next or Add to queue in Your music."}
        </p>
      ) : (
        <ol className="divide-y divide-border/60 overflow-y-auto" aria-label="Songs up next">
          {upNext.slice(0, SHOWN).map(({ track, position }) => (
            <li key={track.key} className="group flex items-center">
              <button
                type="button"
                onClick={() => player.jump(position)}
                aria-label={[`Play “${track.title}” now`, track.artist && `by ${track.artist}`]
                  .filter(Boolean)
                  .join(", ")}
                title={track.fileName}
                className="flex min-w-0 flex-1 items-center gap-3 py-2 pl-4 pr-2 text-left hover:bg-secondary/40 transition-colors"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">
                    {track.title}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {track.artist ?? " "}
                  </span>
                </span>
                {track.duration != null && (
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {formatDuration(track.duration)}
                  </span>
                )}
              </button>
              <button
                type="button"
                onClick={() => player.remove(position)}
                aria-label={`Remove “${track.title}” from the queue`}
                title="Remove from the queue"
                className="mr-2 shrink-0 rounded-lg p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
          {upNext.length > SHOWN && (
            <li className="px-4 py-2 text-xs text-muted-foreground">
              …and {countSongs(upNext.length - SHOWN)} more
            </li>
          )}
        </ol>
      )}
    </div>
  );
}
