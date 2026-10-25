import { useCallback, useEffect, useState } from "react";
import {
  ListMusic,
  Loader2,
  MicVocal,
  Music,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume1,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { LyricsPanel } from "@/components/lyrics-panel";
import { UpNext } from "@/components/up-next";
import { usePlayer, usePlayerTime } from "@/hooks/use-player";
import { usePlayerShortcuts } from "@/hooks/use-player-shortcuts";
import { useToast } from "@/hooks/use-toast";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";

const repeatLabels = {
  off: "Repeat: off",
  all: "Repeat: all songs",
  one: "Repeat: this song",
} as const;

// Phones set the volume with their buttons (and iPhones ignore a page's volume).
const hasFinePointer = () =>
  typeof window !== "undefined" && window.matchMedia?.("(pointer: fine)").matches === true;

const iconButton =
  "inline-flex shrink-0 items-center justify-center rounded-full p-2 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent";

/**
 * The player, pinned to the bottom of the page while a song is loaded: the
 * song, play/pause, previous/next, a seek bar, shuffle, repeat and volume.
 * The page keeps room for it at the end, so it never hides anything. Its
 * keyboard shortcuts work anywhere on the page (their keys are in the tooltips).
 */
export function PlayerBar() {
  const player = usePlayer();
  const { time, duration } = usePlayerTime();
  const [coverFailed, setCoverFailed] = useState(false);
  const [showVolume] = useState(hasFinePointer);
  const { current, status, cover, upNextOpen, setUpNextOpen } = player;
  usePlayerShortcuts();
  const closeUpNext = useCallback(() => setUpNextOpen(false), [setUpNextOpen]);
  // The lyrics open in the same place as Up next: one at a time.
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const closeLyrics = useCallback(() => setLyricsOpen(false), []);
  // A note in the corner would cover Up next, which shows what it said anyway.
  const { dismiss } = useToast();
  const toggleUpNext = () => {
    if (!upNextOpen) {
      dismiss();
      setLyricsOpen(false);
    }
    setUpNextOpen(!upNextOpen);
  };
  const toggleLyrics = () => {
    if (!lyricsOpen) setUpNextOpen(false);
    setLyricsOpen(!lyricsOpen);
  };

  // A folder song without a cover answers with nothing: show the note instead.
  useEffect(() => setCoverFailed(false), [cover]);

  // Toasts move up out of its way.
  const visible = current !== null;
  useEffect(() => {
    if (!visible) return;
    document.documentElement.style.setProperty("--player-height", "6.5rem");
    return () => {
      document.documentElement.style.removeProperty("--player-height");
    };
  }, [visible]);

  if (!current) return null;

  const length = duration ?? current.duration;
  const playing = status === "playing";
  const loading = status === "loading";
  const VolumeIcon =
    player.muted || player.volume === 0 ? VolumeX : player.volume < 0.5 ? Volume1 : Volume2;
  const notice = player.error ?? player.warning;
  const detail = notice
    ? notice
    : loading && player.converting
      ? "Converting for this browser (lossless)…"
      : [current.artist, current.album].filter(Boolean).join(" · ");

  return (
    <>
      {/* Room for the bar at the end of the page. */}
      <div aria-hidden="true" className="h-28" />
      <section
        aria-label="Music player"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 pb-[env(safe-area-inset-bottom)] shadow-[0_-8px_24px_-12px_rgba(0,0,0,0.15)] backdrop-blur-xl"
      >
        {upNextOpen && <UpNext onClose={closeUpNext} />}
        {lyricsOpen && !upNextOpen && <LyricsPanel onClose={closeLyrics} />}
        <div className="mx-auto max-w-5xl px-3 sm:px-6">
          <div className="flex items-center gap-2 pt-2 text-[11px] tabular-nums text-muted-foreground sm:gap-3">
            <span className="w-10 text-right">
              {formatDuration(Math.min(time, length ?? time))}
            </span>
            <input
              type="range"
              aria-label="Seek"
              title="Seek (← → 5 seconds, J L 10 seconds; ? for all the shortcuts)"
              aria-valuetext={`${formatDuration(time)} of ${length ? formatDuration(length) : "unknown"}`}
              min={0}
              max={length ?? 0}
              step="any"
              value={Math.min(time, length ?? 0)}
              disabled={!length || player.error !== null}
              onChange={(event) => player.seek(Number(event.target.value))}
              className="h-1.5 min-w-0 flex-1 cursor-pointer accent-primary disabled:cursor-default"
            />
            <span className="w-10">{length ? formatDuration(length) : "–:––"}</span>
          </div>

          <div className="flex items-center gap-2 pb-2 pt-1 sm:gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-md bg-secondary text-muted-foreground">
              {cover && !coverFailed ? (
                <img
                  src={cover}
                  alt=""
                  onError={() => setCoverFailed(true)}
                  className="h-full w-full object-cover"
                />
              ) : (
                <Music className="h-5 w-5" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p
                className="truncate text-sm font-semibold text-foreground"
                title={current.fileName}
                data-testid="player-title"
              >
                {current.title}
              </p>
              <p
                className={cn(
                  "truncate text-xs",
                  notice ? "text-destructive" : "text-muted-foreground",
                )}
                role={notice ? "alert" : undefined}
              >
                {detail || " "}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
              <button
                type="button"
                onClick={player.toggleShuffle}
                aria-pressed={player.shuffle}
                aria-label="Shuffle"
                title={player.shuffle ? "Shuffle: on" : "Shuffle: off"}
                className={cn(
                  iconButton,
                  "hidden sm:inline-flex",
                  player.shuffle && "text-primary",
                )}
              >
                <Shuffle className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={player.previous}
                aria-label="Previous song"
                title="Previous, or back to the start (Shift+P)"
                className={iconButton}
              >
                <SkipBack className="h-5 w-5" />
              </button>
              <button
                type="button"
                onClick={player.toggle}
                aria-label={playing || loading ? "Pause" : "Play"}
                title={`${playing || loading ? "Pause" : "Play"} (Space or K)`}
                className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-md transition-transform hover:scale-105 active:scale-95"
              >
                {loading ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : playing ? (
                  <Pause className="h-5 w-5" />
                ) : (
                  <Play className="ml-0.5 h-5 w-5" />
                )}
              </button>
              <button
                type="button"
                onClick={player.next}
                disabled={!player.hasNext}
                aria-label="Next song"
                title="Next (Shift+N)"
                className={iconButton}
              >
                <SkipForward className="h-5 w-5" />
              </button>
              <button
                type="button"
                onClick={player.cycleRepeat}
                aria-label={repeatLabels[player.repeat]}
                title={repeatLabels[player.repeat]}
                className={cn(
                  iconButton,
                  "hidden sm:inline-flex",
                  player.repeat !== "off" && "text-primary",
                )}
              >
                {player.repeat === "one" ? (
                  <Repeat1 className="h-4 w-4" />
                ) : (
                  <Repeat className="h-4 w-4" />
                )}
              </button>
            </div>

            {showVolume && (
              <div className="hidden shrink-0 items-center gap-1 md:flex">
                <button
                  type="button"
                  onClick={player.toggleMute}
                  aria-label={player.muted ? "Unmute" : "Mute"}
                  title={player.muted ? "Unmute (M)" : "Mute (M)"}
                  className={iconButton}
                >
                  <VolumeIcon className="h-4 w-4" />
                </button>
                <input
                  type="range"
                  aria-label="Volume"
                  min={0}
                  max={1}
                  step={0.01}
                  value={player.muted ? 0 : player.volume}
                  onChange={(event) => player.setVolume(Number(event.target.value))}
                  className="h-1.5 w-24 cursor-pointer accent-primary"
                />
              </div>
            )}

            <button
              type="button"
              onClick={toggleLyrics}
              aria-expanded={lyricsOpen}
              aria-controls="player-lyrics"
              aria-label="Lyrics"
              title="Lyrics"
              className={cn(iconButton, lyricsOpen && "text-primary")}
            >
              <MicVocal className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={toggleUpNext}
              aria-expanded={upNextOpen}
              aria-controls="player-up-next"
              aria-label="Up next"
              title={
                player.upNext.length > 0
                  ? `Up next: ${player.upNext.length.toLocaleString()} ${player.upNext.length === 1 ? "song" : "songs"}`
                  : "Up next"
              }
              className={cn(iconButton, upNextOpen && "text-primary")}
            >
              <ListMusic className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={player.close}
              aria-label="Close the player"
              title="Stop and close"
              className={iconButton}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      </section>
    </>
  );
}
