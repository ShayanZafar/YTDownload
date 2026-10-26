import { useEffect, useRef, useState } from "react";
import { AlertCircle, Check, Loader2, ShieldCheck, Trash2, X } from "lucide-react";
import { qualityBars, type FolderFile, type QualityBar, type SongCheck } from "@shared/schema";
import { formatBytes } from "@/lib/format";
import {
  checkFolderSong,
  fetchOtherFiles,
  problemHeadings,
  problemKinds,
  qualityBarLabels,
  songProblem,
  type ProblemKind,
} from "@/lib/housekeeping";
import {
  binNameHere,
  deleteFolderSong,
  deleteOtherFolderFile,
  type DeleteOutcome,
  type PlayerTrack,
} from "@/lib/music";
import { eachAtOnce } from "@/lib/song-details";

type FolderTrack = Extract<PlayerTrack, { source: "folder" }>;

/** One file Housekeeping lists: a song with something wrong, or a file that isn't a song. */
type Item = {
  key: string;
  kind: ProblemKind;
  /** Its file name. */
  name: string;
  text: string;
  /** Ticked to be deleted unless the person says otherwise. */
  ticked: boolean;
  /** The song playing: left alone. */
  playing: boolean;
  remove: (permanently: boolean) => Promise<DeleteOutcome>;
};

type Stage =
  | { name: "intro" }
  | { name: "checking"; done: number; total: number }
  | { name: "review"; stopped: boolean; confirming: boolean }
  | { name: "deleting"; done: number; total: number }
  | { name: "no-bin"; deleted: number; left: Item[]; bin: string }
  | { name: "done"; deleted: number; trashed: boolean; failed: number };

const count = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

const button =
  "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-50";
const primary = `${button} bg-primary text-primary-foreground hover:bg-primary/90`;
const secondary = `${button} border border-border bg-card text-foreground hover:bg-secondary`;
const danger = `${button} bg-destructive text-destructive-foreground hover:bg-destructive/90`;

const fileOf = (path: string) => path.split(/[\\/]/).pop() ?? path;
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * "Housekeeping": reads each listed song all the way through, on the app's
 * computer, one per CPU core, and lists the ones that aren't audio, are cut
 * short, can't be read through, or sound worse than the quality bar the
 * person chose — and the folder's files that aren't songs at all. Nothing is
 * deleted until the person has seen the list and pressed Delete; then the
 * ticked ones go to the Recycle Bin / Trash (a drive with none is asked
 * about again). The song that's playing is left alone.
 */
export function Housekeeping({
  tracks,
  playingKey,
  atOnce,
  qualityBar,
  onQualityBar,
  onDeleted,
  onClose,
}: {
  /** The songs listed (the filters applied), all from the Save to folder. */
  tracks: readonly FolderTrack[];
  playingKey: string | null;
  /** How many songs at once: the app's computer's CPU cores. */
  atOnce: number;
  qualityBar: QualityBar;
  onQualityBar: (bar: QualityBar) => void;
  /** These songs (by id) are gone from the folder; other files may be too. */
  onDeleted: (songIds: string[]) => void;
  onClose: () => void;
}) {
  const [stage, setStage] = useState<Stage>({ name: "intro" });
  const [checks, setChecks] = useState<Map<string, SongCheck | string>>(new Map());
  const [others, setOthers] = useState<FolderFile[]>([]);
  // What the person ticked or unticked, over each item's own default.
  const [ticks, setTicks] = useState<Map<string, boolean>>(new Map());
  const [gone, setGone] = useState<Set<string>>(new Set());
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  const items: Item[] = [];
  for (const track of tracks) {
    const check = checks.get(track.key);
    if (check === undefined || gone.has(track.key)) continue;
    const problem =
      typeof check === "string"
        ? { kind: "damaged" as const, text: `Couldn't be checked: ${check}` }
        : songProblem(check, qualityBar);
    if (!problem) continue;
    items.push({
      key: track.key,
      kind: problem.kind,
      name: fileOf(track.fileName),
      text: problem.text,
      ticked: typeof check !== "string",
      playing: track.key === playingKey,
      remove: (permanently) => deleteFolderSong(track.id, { permanently }),
    });
  }
  for (const file of others) {
    const key = `file:${file.id}`;
    if (gone.has(key)) continue;
    items.push({
      key,
      kind: "other",
      name: fileOf(file.path),
      text: `${file.what[0].toUpperCase()}${file.what.slice(1)}, ${formatBytes(file.size)}.`,
      ticked: file.leftover,
      playing: false,
      remove: (permanently) => deleteOtherFolderFile(file.id, { permanently }),
    });
  }
  const isTicked = (item: Item) => !item.playing && (ticks.get(item.key) ?? item.ticked);
  const ticked = items.filter(isTicked);
  const songIdOf = new Map(tracks.map((track) => [track.key, track.id]));

  const check = async () => {
    const abort = new AbortController();
    controller.current = abort;
    let done = 0;
    setChecks(new Map());
    setGone(new Set());
    setStage({ name: "checking", done, total: tracks.length });
    const otherFiles = fetchOtherFiles(abort.signal).then(setOthers, () => setOthers([]));
    await eachAtOnce(
      tracks,
      async (track) => {
        let answer: SongCheck | string;
        try {
          answer = await checkFolderSong(track.id, abort.signal);
        } catch (err) {
          if (abort.signal.aborted) return;
          answer = messageOf(err);
        }
        setChecks((all) => new Map(all).set(track.key, answer));
        done++;
        setStage({ name: "checking", done, total: tracks.length });
      },
      atOnce,
      abort.signal,
    );
    await otherFiles;
    setStage({ name: "review", stopped: abort.signal.aborted, confirming: false });
  };

  const remove = async (chosen: Item[], permanently: boolean, deletedBefore = 0) => {
    const abort = new AbortController();
    controller.current = abort;
    let done = 0;
    let deleted = deletedBefore;
    let failed = 0;
    let bin = binNameHere();
    const noBin: Item[] = [];
    const deletedKeys: string[] = [];
    setStage({ name: "deleting", done, total: chosen.length });
    await eachAtOnce(
      chosen,
      async (item) => {
        try {
          const outcome = await item.remove(permanently);
          bin = outcome.bin;
          if (outcome.deleted) {
            deleted++;
            deletedKeys.push(item.key);
          } else noBin.push(item);
        } catch {
          failed++;
        }
        done++;
        setStage({ name: "deleting", done, total: chosen.length });
      },
      atOnce,
      abort.signal,
    );
    setGone((all) => new Set([...all, ...deletedKeys]));
    onDeleted(deletedKeys.flatMap((key) => songIdOf.get(key) ?? []));
    if (noBin.length > 0) setStage({ name: "no-bin", deleted, left: noBin, bin });
    else setStage({ name: "done", deleted, trashed: !permanently, failed });
  };

  const byKind = (kind: ProblemKind) => items.filter((item) => item.kind === kind);

  return (
    <section
      aria-label="Housekeeping"
      className="border-b border-border bg-secondary/30 px-4 py-3 text-sm"
    >
      <div className="flex items-start gap-2">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1 space-y-3">
          {stage.name === "intro" && (
            <>
              <p className="font-medium text-foreground">
                Check {count(tracks.length, "song")} for files that aren't audio, are cut short,
                can't be read through, or sound worse than the bar below — and the folder's other
                files.
              </p>
              <p className="text-xs text-muted-foreground">
                Each song is read all the way through on this computer,{" "}
                {count(Math.max(1, atOnce), "song")} at a time. Nothing is deleted until you've seen
                the list and pressed Delete, and deleted files go to the {binNameHere()}.
              </p>
            </>
          )}

          {(stage.name === "intro" || stage.name === "review") && (
            <label className="flex flex-wrap items-center gap-2 text-xs text-foreground">
              Low quality:
              <select
                value={qualityBar}
                aria-label="Low quality"
                onChange={(event) => onQualityBar(event.target.value as QualityBar)}
                className="rounded border border-border bg-background px-2 py-1 text-xs"
              >
                {qualityBars.map((bar) => (
                  <option key={bar} value={bar}>
                    {qualityBarLabels[bar]}
                  </option>
                ))}
              </select>
              <span className="text-muted-foreground">Lossless files (FLAC, WAV) always pass.</span>
            </label>
          )}

          {stage.name === "intro" && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={primary}
                disabled={tracks.length === 0}
                onClick={() => void check()}
              >
                Check {count(tracks.length, "song")}
              </button>
              <button type="button" className={secondary} onClick={onClose}>
                Cancel
              </button>
            </div>
          )}

          {stage.name === "checking" && (
            <>
              <p className="flex items-center gap-2 text-foreground" aria-live="polite">
                <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                Checked {stage.done.toLocaleString()} of {count(stage.total, "song")}…
                {items.length > 0 && ` ${count(items.length, "file")} to look at so far.`}
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

          {stage.name === "review" && (
            <p className="font-medium text-foreground" role="status">
              {stage.stopped && "Stopped. "}
              {items.length === 0
                ? "Nothing to clean up: every song checked plays through and passes the bar."
                : `${count(items.length, "file")} to look at. Untick any to keep, then delete the rest.`}
            </p>
          )}

          {(stage.name === "checking" || stage.name === "review") && items.length > 0 && (
            <div className="max-h-96 space-y-3 overflow-y-auto rounded-lg border border-border bg-card px-3 py-2">
              {problemKinds.map((kind) => {
                const group = byKind(kind);
                if (group.length === 0) return null;
                return (
                  <section key={kind} aria-label={problemHeadings[kind]}>
                    <h3 className="text-xs font-semibold text-foreground">
                      {problemHeadings[kind]} ({group.length.toLocaleString()})
                    </h3>
                    <ul className="divide-y divide-border/60">
                      {group.map((item) => (
                        <li key={item.key} className="flex items-start gap-2 py-1.5">
                          <input
                            type="checkbox"
                            checked={isTicked(item)}
                            disabled={item.playing || stage.name !== "review"}
                            onChange={() =>
                              setTicks((all) => new Map(all).set(item.key, !isTicked(item)))
                            }
                            aria-label={`Delete “${item.name}”`}
                            className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block break-words text-xs text-foreground">
                              {item.name}
                            </span>
                            <span className="block text-xs text-muted-foreground">
                              {item.text}
                              {item.playing && " It's playing, so it's left alone."}
                            </span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
            </div>
          )}

          {stage.name === "review" && (
            <div className="flex flex-wrap items-center gap-2">
              {stage.confirming ? (
                <>
                  <span className="text-xs text-foreground">
                    Move {count(ticked.length, "file")} to the {binNameHere()}? You can put them
                    back from there.
                  </span>
                  <button
                    type="button"
                    className={danger}
                    onClick={() => void remove(ticked, false)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Move to the {binNameHere()}
                  </button>
                  <button
                    type="button"
                    className={secondary}
                    onClick={() => setStage({ ...stage, confirming: false })}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  {items.length > 0 && (
                    <button
                      type="button"
                      className={danger}
                      disabled={ticked.length === 0}
                      onClick={() => setStage({ ...stage, confirming: true })}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Delete {count(ticked.length, "file")}
                    </button>
                  )}
                  <button type="button" className={secondary} onClick={() => void check()}>
                    Check again
                  </button>
                  <button type="button" className={secondary} onClick={onClose}>
                    Close
                  </button>
                </>
              )}
            </div>
          )}

          {stage.name === "deleting" && (
            <p className="flex items-center gap-2 text-foreground" aria-live="polite">
              <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
              Deleting {stage.done.toLocaleString()} of {count(stage.total, "file")}…
            </p>
          )}

          {stage.name === "no-bin" && (
            <>
              <p className="flex items-start gap-2 text-foreground" role="alert">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                {count(stage.left.length, "file")} can't go to the {stage.bin}: their drive doesn't
                have one (a network or USB drive). Delete them for good? That can't be undone.
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={danger}
                  onClick={() => void remove(stage.left, true, stage.deleted)}
                >
                  Delete for good
                </button>
                <button
                  type="button"
                  className={secondary}
                  onClick={() =>
                    setStage({ name: "done", deleted: stage.deleted, trashed: true, failed: 0 })
                  }
                >
                  Keep them
                </button>
              </div>
            </>
          )}

          {stage.name === "done" && (
            <>
              <p className="flex items-center gap-2 font-medium text-foreground" role="status">
                <Check className="h-4 w-4 shrink-0 text-primary" />
                {stage.deleted > 0
                  ? stage.trashed
                    ? `Moved ${count(stage.deleted, "file")} to the ${binNameHere()}.`
                    : `Deleted ${count(stage.deleted, "file")}.`
                  : "Nothing was deleted."}
                {stage.failed > 0 && ` ${count(stage.failed, "file")} couldn't be deleted.`}
              </p>
              <div className="flex flex-wrap gap-2">
                <button type="button" className={secondary} onClick={() => void check()}>
                  Check again
                </button>
                <button type="button" className={secondary} onClick={onClose}>
                  Close
                </button>
              </div>
            </>
          )}
        </div>
        {stage.name !== "checking" && stage.name !== "deleting" && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Housekeeping"
            className="shrink-0 rounded-lg p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    </section>
  );
}
