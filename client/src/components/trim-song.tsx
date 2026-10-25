import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { AlertCircle, Loader2, Pause, Play, Scissors, SkipForward, X } from "lucide-react";
import type { TimeRange, TrimmedSong, Waveform } from "@shared/schema";
import { usePlayer, usePlayerTime } from "@/hooks/use-player";
import { folderSongFlacUrl, folderSongUrl, type PlayerTrack } from "@/lib/music";
import {
  clampCut,
  fetchWaveform,
  formatCutTime,
  lengthWithout,
  parseCutTime,
  skipCut,
  trimSong,
} from "@/lib/trim";
import { cn } from "@/lib/utils";

type TrimSongProps = {
  /** A song in the Save to folder. */
  track: PlayerTrack & { source: "folder" };
  /** Called once the part is cut out. */
  onTrimmed: (trimmed: TrimmedSong, cut: TimeRange) => void;
  onClose: () => void;
};

/** How far before the cut "Hear the join" starts (seconds). */
const LEAD_IN = 3;

const messageOf = (err: unknown) => (err instanceof Error ? err.message : "Something went wrong.");

// The two handles are range inputs laid over the waveform: only their dots
// take the pointer, so a click anywhere else on it moves the preview there.
const handle = cn(
  "pointer-events-none absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent outline-none",
  "[&::-webkit-slider-runnable-track]:h-full [&::-webkit-slider-runnable-track]:bg-transparent",
  "[&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:mt-[46px] [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:bg-destructive [&::-webkit-slider-thumb]:shadow-md [&::-webkit-slider-thumb]:cursor-ew-resize",
  "[&::-moz-range-track]:bg-transparent [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-white [&::-moz-range-thumb]:bg-destructive [&::-moz-range-thumb]:shadow-md [&::-moz-range-thumb]:cursor-ew-resize",
  "focus-visible:[&::-webkit-slider-thumb]:ring-4 focus-visible:[&::-webkit-slider-thumb]:ring-destructive/40 focus-visible:[&::-moz-range-thumb]:ring-4 focus-visible:[&::-moz-range-thumb]:ring-destructive/40",
);

const smallButton =
  "inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-secondary disabled:opacity-50";

/** A time box: shows the time, takes one typed as 1:23.4 (or seconds) on Enter or leaving it. */
function TimeBox({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: number;
  onChange: (seconds: number) => void;
  children?: ReactNode;
}) {
  const [text, setText] = useState(formatCutTime(value));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setText(formatCutTime(value));
    setInvalid(false);
  }, [value]);
  const commit = () => {
    const seconds = parseCutTime(text);
    if (seconds === undefined) return setInvalid(true);
    setInvalid(false);
    // Shown as a clock again: the new time, once it's taken (it may be moved
    // to stay inside the song), or the same one if nothing changes.
    setText(formatCutTime(value));
    onChange(seconds);
  };
  return (
    <div className="flex items-center gap-2">
      <label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        {label}
        <input
          type="text"
          inputMode="decimal"
          value={text}
          aria-invalid={invalid || undefined}
          onChange={(event) => setText(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            }
          }}
          className={cn(
            "h-8 w-20 rounded-lg border bg-card px-2 text-sm tabular-nums text-foreground",
            invalid ? "border-destructive" : "border-border",
          )}
        />
      </label>
      {children}
    </div>
  );
}

/**
 * The trim window: the song's waveform with two handles — where the part to
 * cut out starts and ends — over it, its quiet stretches to pick from, and a
 * preview that plays the song as it'll be (skipping the cut). "Cut it out"
 * has the app cut that part out of the file and join the rest; the original
 * is kept, for Undo.
 *
 * A native <dialog>, like the folder picker: it keeps keyboard focus inside,
 * and Escape closes it.
 */
export function TrimSong({ track, onTrimmed, onClose }: TrimSongProps) {
  const player = usePlayer();
  const { time: playerAt } = usePlayerTime();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const titleId = useId();
  const [waveform, setWaveform] = useState<Waveform | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cut, setCut] = useState<TimeRange | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The cut, for the preview's skipping (it runs outside React's renders).
  const cutRef = useRef<TimeRange | null>(null);
  cutRef.current = cut;

  const duration = waveform?.duration ?? 0;

  // Open as a modal; the music player pauses while it's open. Focus goes back
  // to whatever opened it afterwards.
  const { status, toggle } = player;
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog && !dialog.open) dialog.showModal();
    return () => opener?.focus();
  }, []);
  const pausedPlayer = useRef(false);
  useEffect(() => {
    if (pausedPlayer.current) return;
    pausedPlayer.current = true;
    if (status === "playing") toggle();
  }, [status, toggle]);

  // The waveform, and the first quiet stretch picked to start with (or a bit in the middle).
  useEffect(() => {
    const controller = new AbortController();
    fetchWaveform(track.id, controller.signal)
      .then((found) => {
        setWaveform(found);
        const [quiet] = found.silences;
        setCut(
          clampCut(
            quiet ?? { start: found.duration * 0.45, end: found.duration * 0.55 },
            found.duration,
            "end",
          ),
        );
      })
      .catch((err) => {
        if (!controller.signal.aborted) setLoadError(messageOf(err));
      });
    return () => controller.abort();
  }, [track.id]);

  // The preview: the song from the app (converted, if this browser can't play
  // it), skipping the cut. Checked every frame while it plays, so the skip is
  // where you'd hear the join.
  const src = useMemo(() => {
    const probe = typeof document !== "undefined" ? document.createElement("audio") : null;
    const canPlay = !track.check || !probe || probe.canPlayType(track.check) !== "";
    return canPlay ? folderSongUrl(track.id) : folderSongFlacUrl(track.id);
  }, [track.id, track.check]);
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      const audio = audioRef.current;
      const range = cutRef.current;
      if (audio && range) {
        const to = skipCut(audio.currentTime, range);
        if (to !== undefined) audio.currentTime = to;
        setTime(audio.currentTime);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);
  // Let go of the song's file when the window closes.
  useEffect(() => {
    const audio = audioRef.current;
    return () => {
      audio?.pause();
      audio?.removeAttribute("src");
      audio?.load();
    };
  }, []);

  const playFrom = (seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, seconds);
    setTime(audio.currentTime);
    void audio.play().catch((err: unknown) => setError(`Couldn't play it: ${messageOf(err)}`));
  };
  const seekTo = (seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, Math.min(duration, seconds));
    setTime(audio.currentTime);
  };
  const togglePreview = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!audio.paused) return audio.pause();
    playFrom(cut ? (skipCut(audio.currentTime, cut) ?? audio.currentTime) : audio.currentTime);
  };

  const move = (moved: "start" | "end", seconds: number) => {
    if (!cut) return;
    setCut(clampCut({ ...cut, [moved]: seconds }, duration, moved));
    setError(null);
  };

  const close = () => dialogRef.current?.close(); // → onClose, via the "close" event

  const save = async () => {
    if (!cut) return;
    setSaving(true);
    setError(null);
    audioRef.current?.pause();
    // The player lets go of the file while it changes, keeping its place in the song.
    const wasAt = player.current?.key === track.key ? playerAt : null;
    if (wasAt !== null) {
      const after = wasAt >= cut.end ? wasAt - (cut.end - cut.start) : Math.min(wasAt, cut.start);
      player.letGo(track.key, after);
    }
    try {
      const trimmed = await trimSong(track.id, cut);
      onTrimmed(trimmed, cut);
      close();
    } catch (err) {
      if (wasAt !== null) player.seek(wasAt);
      setError(messageOf(err));
    } finally {
      setSaving(false);
    }
  };

  const percent = (seconds: number) => (duration > 0 ? (seconds / duration) * 100 : 0);
  const removed = cut ? cut.end - cut.start : 0;

  return createPortal(
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(event) => {
        if (saving) event.preventDefault();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-2xl border-0 bg-transparent p-0 text-foreground backdrop:bg-black/50 backdrop:backdrop-blur-xs"
    >
      <div className="flex max-h-[90vh] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="font-display text-lg font-semibold">
              Trim “{track.title}”
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Drag the two red dots to where the part to cut out starts and ends. The rest is joined
              back together.
            </p>
          </div>
          <button
            type="button"
            onClick={close}
            disabled={saving}
            aria-label="Close"
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors disabled:opacity-50"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 overflow-y-auto px-5 py-4">
          {loadError ? (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>Couldn't read the song: {loadError}</span>
            </p>
          ) : !waveform || !cut ? (
            <div className="flex h-28 items-center justify-center gap-2 rounded-xl bg-secondary/50 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Reading the song…
            </div>
          ) : (
            <>
              {/* The timeline: waveform, the cut, the preview's place, and the two handles. */}
              <div
                data-testid="trim-timeline"
                className="relative h-28 cursor-pointer select-none rounded-xl bg-secondary/50"
                onClick={(event) => {
                  const box = event.currentTarget.getBoundingClientRect();
                  seekTo(((event.clientX - box.left) / box.width) * duration);
                }}
              >
                <svg
                  aria-hidden="true"
                  className="absolute inset-0 h-full w-full"
                  viewBox={`0 0 ${waveform.peaks.length} 100`}
                  preserveAspectRatio="none"
                >
                  {waveform.peaks.map((peak, i) => {
                    // Square-root scaled, so quiet parts still show.
                    const height = Math.max(1, Math.sqrt(peak) * 92);
                    const at = ((i + 0.5) / waveform.peaks.length) * duration;
                    const inCut = at >= cut.start && at <= cut.end;
                    return (
                      <rect
                        key={i}
                        x={i + 0.15}
                        y={50 - height / 2}
                        width={0.7}
                        height={height}
                        className={inCut ? "fill-destructive/70" : "fill-primary/60"}
                      />
                    );
                  })}
                </svg>
                <div
                  aria-hidden="true"
                  className="absolute inset-y-0 border-x-2 border-destructive bg-destructive/15"
                  style={{
                    left: `${percent(cut.start)}%`,
                    width: `${percent(cut.end) - percent(cut.start)}%`,
                  }}
                />
                <div
                  aria-hidden="true"
                  className="absolute inset-y-0 w-0.5 bg-foreground/80"
                  style={{ left: `${percent(time)}%` }}
                />
                {(["start", "end"] as const).map((which) => (
                  <input
                    key={which}
                    type="range"
                    min={0}
                    max={duration}
                    step={0.05}
                    value={cut[which]}
                    aria-label={which === "start" ? "Cut from" : "Cut to"}
                    aria-valuetext={formatCutTime(cut[which])}
                    onChange={(event) => move(which, Number(event.target.value))}
                    onClick={(event) => event.stopPropagation()}
                    className={handle}
                  />
                ))}
              </div>
              <div className="flex justify-between text-xs tabular-nums text-muted-foreground">
                <span>0:00</span>
                <span aria-live="off">{formatCutTime(time)}</span>
                <span>{formatCutTime(duration)}</span>
              </div>

              <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                <TimeBox label="From" value={cut.start} onChange={(s) => move("start", s)}>
                  <button
                    type="button"
                    onClick={() => move("start", time)}
                    className={smallButton}
                    title="Start the cut where the preview is"
                  >
                    Set here
                  </button>
                </TimeBox>
                <TimeBox label="To" value={cut.end} onChange={(s) => move("end", s)}>
                  <button
                    type="button"
                    onClick={() => move("end", time)}
                    className={smallButton}
                    title="End the cut where the preview is"
                  >
                    Set here
                  </button>
                </TimeBox>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={togglePreview}
                  className={smallButton}
                  aria-label={playing ? "Pause the preview" : "Play the preview"}
                >
                  {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                  {playing ? "Pause" : "Play"}
                </button>
                <button
                  type="button"
                  onClick={() => playFrom(cut.start - LEAD_IN)}
                  className={smallButton}
                  title={`Plays from ${LEAD_IN} seconds before the cut, skipping it`}
                >
                  <SkipForward className="h-3.5 w-3.5" />
                  Hear the join
                </button>
                <span className="text-xs text-muted-foreground">
                  The preview skips the cut, so it sounds the way the song will.
                </span>
              </div>

              <div>
                <p className="text-xs font-medium text-muted-foreground">
                  {waveform.silences.length > 0
                    ? "Dead air found — click one to cut it:"
                    : "No dead air found (a second or more of silence) — drag the dots to pick a part."}
                </p>
                {waveform.silences.length > 0 && (
                  <div role="group" aria-label="Dead air" className="mt-2 flex flex-wrap gap-2">
                    {waveform.silences.map((quiet) => {
                      const picked =
                        Math.abs(quiet.start - cut.start) < 0.01 &&
                        Math.abs(quiet.end - cut.end) < 0.01;
                      return (
                        <button
                          key={quiet.start}
                          type="button"
                          aria-pressed={picked}
                          onClick={() => {
                            setCut(clampCut(quiet, duration, "end"));
                            seekTo(Math.max(0, quiet.start - LEAD_IN));
                          }}
                          className={cn(
                            "rounded-full border px-3 py-1 text-xs tabular-nums transition-colors",
                            picked
                              ? "border-destructive bg-destructive/10 text-destructive"
                              : "border-border text-foreground hover:bg-secondary",
                          )}
                        >
                          {formatCutTime(quiet.start)}–{formatCutTime(quiet.end)} (
                          {(quiet.end - quiet.start).toFixed(1)} s)
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}

          {error && (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border px-5 py-3">
          {cut && waveform && (
            <p className="mr-auto text-xs text-muted-foreground" aria-live="polite">
              Cuts {removed.toFixed(1)} s · new length {formatCutTime(lengthWithout(cut, duration))}
              . The original is kept, so you can undo it.
            </p>
          )}
          <button type="button" onClick={close} disabled={saving} className={smallButton}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={!cut || saving}
            className="inline-flex items-center gap-1.5 rounded-lg bg-destructive px-3 py-1.5 text-xs font-semibold text-white hover:bg-destructive/90 transition-colors disabled:opacity-50"
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Scissors className="h-3.5 w-3.5" />
            )}
            {saving ? "Cutting…" : "Cut it out"}
          </button>
        </div>
      </div>
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        data-testid="trim-preview-audio"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
      />
    </dialog>,
    document.body,
  );
}
