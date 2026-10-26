import { useEffect, useRef, useState } from "react";
import { AlertCircle, Check, Eraser, Loader2, X } from "lucide-react";
import type { MusicTrack } from "@shared/schema";
import { renameFolderSong, sanitizedNameOf, type PlayerTrack } from "@/lib/music";
import { eachAtOnce } from "@/lib/song-details";
import { cn } from "@/lib/utils";

type FolderTrack = Extract<PlayerTrack, { source: "folder" }>;

/** A song whose name would change, what to, and whether it's ticked to be renamed. */
type Rename = { track: FolderTrack; name: string; keep: boolean };

type Stage =
  | { name: "review"; renames: Rename[] }
  | { name: "renaming"; done: number; total: number }
  | { name: "done"; renamed: number; failed: number };

/** What happened to one song, shown the moment it's done. */
type Outcome = { key: string; text: string; failed: boolean };

const countSongs = (n: number) => `${n.toLocaleString()} ${n === 1 ? "song" : "songs"}`;

const button =
  "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-50";
const primary = `${button} bg-primary text-primary-foreground hover:bg-primary/90`;
const secondary = `${button} border border-border bg-card text-foreground hover:bg-secondary`;

const fileOf = (track: FolderTrack) => track.fileName.split(/[\\/]/).pop() ?? track.fileName;
const extOf = (track: FolderTrack) => /\.[^.]+$/.exec(fileOf(track))?.[0] ?? "";
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * "Sanitize Filename": suggests a tidy name for each listed song whose file
 * name carries what videos and copies add — "(Official Video)", "HQ",
 * "(1998)", a copy's "(1)", "&#39" — and renames only the ones ticked, each
 * name editable first. The extension stays, a name that's taken gets a
 * number, and the song that's playing is left alone.
 */
export function SanitizeNames({
  tracks,
  playingKey,
  atOnce,
  onSongRenamed,
  onRenamed,
  onClose,
}: {
  /** The songs listed (the filters applied), all from the Save to folder. */
  tracks: readonly FolderTrack[];
  /** The song playing now, which isn't renamed while it plays. */
  playingKey: string | null;
  /** How many songs at once: the app's computer's CPU cores. */
  atOnce: number;
  /** One song was renamed (it had id `from`): here it is as it is now, to show at once. */
  onSongRenamed: (from: string, track: MusicTrack) => void;
  /** Some files were renamed: the list should be read again. */
  onRenamed: () => void;
  onClose: () => void;
}) {
  const [stage, setStage] = useState<Stage>(() => ({
    name: "review",
    renames: tracks.flatMap((track) => {
      const name = track.key === playingKey ? undefined : sanitizedNameOf(track);
      return name ? [{ track, name, keep: true }] : [];
    }),
  }));
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  const rename = async (renames: Rename[]) => {
    const kept = renames.filter((item) => item.keep && item.name.trim());
    const abort = new AbortController();
    controller.current = abort;
    let renamed = 0;
    let failed = 0;
    let done = 0;
    setOutcomes([]);
    setStage({ name: "renaming", done, total: kept.length });
    await eachAtOnce(
      kept,
      async ({ track, name }) => {
        const from = fileOf(track);
        try {
          const { track: now } = await renameFolderSong(
            track.id,
            { name: name.trim() },
            abort.signal,
          );
          renamed++;
          if (!abort.signal.aborted) onSongRenamed(track.id, now);
          const to = now.path.split(/[\\/]/).pop();
          setOutcomes((all) => [
            { key: track.key, text: `“${from}” is now “${to}”`, failed: false },
            ...all,
          ]);
        } catch (err) {
          if (!abort.signal.aborted) {
            failed++;
            setOutcomes((all) => [
              {
                key: track.key,
                text: `“${from}” couldn't be renamed: ${messageOf(err)}`,
                failed: true,
              },
              ...all,
            ]);
          }
        }
        done++;
        if (!abort.signal.aborted) setStage({ name: "renaming", done, total: kept.length });
      },
      atOnce,
      abort.signal,
    );
    onRenamed();
    setStage({ name: "done", renamed, failed });
  };

  return (
    <section
      aria-label="Sanitize Filename"
      className="border-b border-border bg-secondary/30 px-4 py-3 text-sm"
    >
      <div className="flex items-start gap-2">
        <Eraser className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1 space-y-3">
          {stage.name === "review" && (
            <Review
              renames={stage.renames}
              skipsPlaying={tracks.some((track) => track.key === playingKey)}
              onChange={(renames) => setStage({ name: "review", renames })}
              onRename={() => void rename(stage.renames)}
              onClose={onClose}
            />
          )}

          {stage.name === "renaming" && (
            <>
              <p className="flex items-center gap-2 text-foreground" aria-live="polite">
                <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                Renaming {stage.done} of {countSongs(stage.total)}…
              </p>
              <button
                type="button"
                className={secondary}
                onClick={() => controller.current?.abort()}
              >
                Stop
              </button>
            </>
          )}

          {stage.name !== "review" && outcomes.length > 0 && (
            <ul
              role="log"
              aria-label="Each song"
              className="max-h-48 space-y-0.5 overflow-y-auto rounded-lg border border-border bg-card px-3 py-2 text-xs"
            >
              {outcomes.map(({ key, text, failed }) => (
                <li
                  key={key}
                  className={cn("flex items-start gap-1.5", failed && "text-destructive")}
                >
                  {failed ? (
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  ) : (
                    <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                  )}
                  <span className="min-w-0 break-words">{text}</span>
                </li>
              ))}
            </ul>
          )}

          {stage.name === "done" && (
            <>
              <p className="flex items-center gap-2 font-medium text-foreground" role="status">
                <Check className="h-4 w-4 shrink-0 text-primary" />
                {stage.renamed > 0
                  ? `Renamed ${countSongs(stage.renamed)}.`
                  : "No songs were renamed."}
                {stage.failed > 0 && ` ${countSongs(stage.failed)} couldn't be.`}
              </p>
              <button type="button" className={secondary} onClick={onClose}>
                Close
              </button>
            </>
          )}
        </div>
        {stage.name !== "renaming" && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Sanitize Filename"
            className="shrink-0 rounded-lg p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    </section>
  );
}

function Review({
  renames,
  skipsPlaying,
  onChange,
  onRename,
  onClose,
}: {
  renames: Rename[];
  skipsPlaying: boolean;
  onChange: (renames: Rename[]) => void;
  onRename: () => void;
  onClose: () => void;
}) {
  const kept = renames.filter((item) => item.keep && item.name.trim()).length;
  const update = (index: number, change: Partial<Rename>) =>
    onChange(renames.map((item, i) => (i === index ? { ...item, ...change } : item)));

  return (
    <>
      <p className="font-medium text-foreground" role="status">
        {renames.length > 0
          ? `${countSongs(renames.length)} could have a tidier name. Untick any to leave as they are, or change a name first.`
          : "Every song listed has a tidy name already."}
      </p>
      <p className="text-xs text-muted-foreground">
        Takes out what videos and copies add to a name: “(Official Video)”, “HQ”, “Lyrics Video”, a
        year in brackets, a copy's “(1)”. The extension stays, and a name that's taken gets a
        number. Playlists saved as .m3u8 files list songs by name, so they won't find a renamed
        song.{skipsPlaying && " The song that's playing is left out."}
      </p>
      {renames.length > 0 && (
        <ul className="max-h-80 divide-y divide-border/60 overflow-y-auto rounded-lg border border-border bg-card">
          {renames.map(({ track, name, keep }, index) => (
            <li key={track.key} className="flex items-start gap-3 px-3 py-2">
              <input
                type="checkbox"
                checked={keep}
                onChange={() => update(index, { keep: !keep })}
                aria-label={`Rename “${fileOf(track)}”`}
                className="mt-1.5 h-4 w-4 shrink-0 accent-primary"
              />
              <span className={cn("min-w-0 flex-1 space-y-1", !keep && "opacity-60")}>
                <span className="block truncate text-xs text-muted-foreground line-through">
                  {fileOf(track)}
                </span>
                <span className="flex items-center gap-1">
                  <input
                    type="text"
                    value={name}
                    disabled={!keep}
                    onChange={(event) => update(index, { name: event.target.value })}
                    aria-label={`New name for “${fileOf(track)}”`}
                    className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
                  />
                  <span className="shrink-0 text-xs text-muted-foreground">{extOf(track)}</span>
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        {renames.length > 0 && (
          <button type="button" className={primary} disabled={kept === 0} onClick={onRename}>
            Rename {countSongs(kept)}
          </button>
        )}
        <button type="button" className={secondary} onClick={onClose}>
          {renames.length > 0 ? "Cancel" : "Close"}
        </button>
      </div>
    </>
  );
}
