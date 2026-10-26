import { useMemo, useState } from "react";
import {
  AlertCircle,
  Check,
  CircleArrowUp,
  Loader2,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import {
  qualityBars,
  type BetterCopy,
  type FolderFile,
  type MusicTrack,
  type QualityBar,
  type SongCheck,
} from "@shared/schema";
import { formatBytes } from "@/lib/format";
import {
  betterCopyText,
  checkFolderSong,
  copiesOf,
  fetchOtherFiles,
  findBetterCopy,
  problemHeadings,
  problemKinds,
  qualityBarLabels,
  replaceWithBetterCopy,
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
import { eachAtOnce } from "@/lib/at-once";
import { useBatchRun } from "@/hooks/use-batch-run";

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

/** A low-quality song's better copy: being looked for, found, none, being put in, or failed. */
type Better =
  | { status: "finding" }
  | { status: "found"; copy: BetterCopy }
  | { status: "none"; reason: string }
  | { status: "replacing"; copy: BetterCopy }
  | { status: "failed"; reason: string };

type Stage =
  | { name: "intro" }
  | { name: "checking"; done: number; total: number }
  | { name: "review"; stopped: boolean; confirming: boolean; note?: string }
  | { name: "finding"; done: number; total: number }
  | { name: "replacing"; done: number; total: number }
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
/** How a song is encoded, in a few words: "320 kbps", "lossless". */
const qualityOf = (check: SongCheck) =>
  check.lossless ? "lossless" : check.kbps !== null ? `${check.kbps} kbps` : "";

/** Why a song is an extra copy, and which copy is kept. */
function copyText({ keep, check, kept }: { keep: FolderTrack; check: SongCheck; kept: SongCheck }) {
  const quality =
    qualityOf(kept) && qualityOf(check) && qualityOf(kept) !== qualityOf(check)
      ? ` (${qualityOf(kept)}; this one ${qualityOf(check)})`
      : "";
  return `The same song as “${fileOf(keep.fileName)}”, the same length: that one is kept${quality}.`;
}
/** What the list is for, as a sentence ends: "The list is for songs below 128 kbps". */
const barText: Record<QualityBar, string> = {
  "128": "songs below 128 kbps",
  "192": "songs below 192 kbps",
  "256": "songs below 256 kbps",
  lossless: "songs that aren't lossless",
  off: "no quality bar",
};
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * "Housekeeping": reads each listed song all the way through, on the app's
 * computer, one per CPU core, and lists the ones that aren't audio, are cut
 * short, can't be read through, or sound worse than the quality bar the
 * person chose, the extra copies of songs in the folder twice (copiesOf():
 * the best copy is kept) — and the folder's files that aren't songs at all. Nothing is
 * deleted until the person has seen the list and pressed Delete; then the
 * ticked ones go to the Recycle Bin / Trash (a drive with none is asked
 * about again). A song that sounds worse than the bar can be replaced by a
 * better copy instead (Find better copies, then Replace: server/better-copy.ts),
 * its old file going to the bin. The song that's playing is left alone.
 */
export function Housekeeping({
  tracks,
  playingKey,
  atOnce,
  qualityBar,
  onQualityBar,
  onDeleted,
  onReplaced,
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
  /** This song was replaced by a better copy: as it is now (the same id). */
  onReplaced: (track: MusicTrack) => void;
  onClose: () => void;
}) {
  const [stage, setStage] = useState<Stage>({ name: "intro" });
  // The bar the list is for: the one chosen when Check was last pressed.
  const [listedBar, setListedBar] = useState<QualityBar>(qualityBar);
  const [checks, setChecks] = useState<Map<string, SongCheck | string>>(new Map());
  const [others, setOthers] = useState<FolderFile[]>([]);
  // What the person ticked or unticked, over each item's own default.
  const [ticks, setTicks] = useState<Map<string, boolean>>(new Map());
  const [gone, setGone] = useState<Set<string>>(new Set());
  // Better copies of the low-quality songs, and which the person unticked.
  const [better, setBetter] = useState<Map<string, Better>>(new Map());
  const [replaceTicks, setReplaceTicks] = useState<Map<string, boolean>>(new Map());
  const batch = useBatchRun();

  // Once every song is checked: the copies of songs in the folder twice, among the
  // ones that play through. A copy sounding worse than the bar is listed as a copy.
  const checked = stage.name === "review";
  const copies = useMemo(() => {
    const extra = new Map<string, { keep: FolderTrack; check: SongCheck; kept: SongCheck }>();
    if (!checked) return extra;
    const byKey = new Map(tracks.map((track) => [track.key, track]));
    const playable = tracks.flatMap((track) => {
      const check = checks.get(track.key);
      if (!check || typeof check === "string" || gone.has(track.key)) return [];
      if (check.notAudio || check.cutShort || check.damaged) return [];
      return [{ ...track, check }];
    });
    for (const { keep, extra: others } of copiesOf(playable)) {
      for (const other of others) {
        extra.set(other.key, { keep: byKey.get(keep.key)!, check: other.check, kept: keep.check });
      }
    }
    return extra;
  }, [checked, tracks, checks, gone]);

  const items: Item[] = [];
  for (const track of tracks) {
    const check = checks.get(track.key);
    if (check === undefined || gone.has(track.key)) continue;
    const copy = copies.get(track.key);
    const problem =
      typeof check === "string"
        ? { kind: "damaged" as const, text: `Couldn't be checked: ${check}` }
        : copy
          ? { kind: "copy" as const, text: copyText(copy) }
          : songProblem(check, listedBar);
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
  // The low-quality songs a better copy can still be looked for, and the ones ticked to replace.
  const lowQuality = items.filter((item) => item.kind === "lowQuality" && !item.playing);
  const findable = lowQuality.filter((item) => {
    const status = better.get(item.key)?.status;
    return status === undefined || status === "failed";
  });
  const isReplaceTicked = (item: Item) => replaceTicks.get(item.key) ?? true;
  const toReplace = lowQuality.filter(
    (item) => better.get(item.key)?.status === "found" && isReplaceTicked(item),
  );

  const check = async () => {
    const signal = batch.start();
    setListedBar(qualityBar);
    setChecks(new Map());
    setGone(new Set());
    setBetter(new Map());
    setReplaceTicks(new Map());
    const otherFiles = fetchOtherFiles(signal).then(setOthers, () => setOthers([]));
    await eachAtOnce(
      tracks,
      async (track) => {
        let answer: SongCheck | string;
        try {
          answer = await checkFolderSong(track.id, signal);
        } catch (err) {
          if (signal.aborted) return;
          answer = messageOf(err);
        }
        setChecks((all) => new Map(all).set(track.key, answer));
      },
      atOnce,
      signal,
      (done, total) => setStage({ name: "checking", done, total }),
    );
    await otherFiles;
    setStage({ name: "review", stopped: signal.aborted, confirming: false });
  };

  const setBetterOf = (key: string, state: Better | undefined) =>
    setBetter((all) => {
      const next = new Map(all);
      if (state) next.set(key, state);
      else next.delete(key);
      return next;
    });

  // Better copies: each low-quality song looked for online, one per CPU core.
  const findCopies = async (chosen: Item[]) => {
    const signal = batch.start();
    for (const item of chosen) setBetterOf(item.key, { status: "finding" });
    await eachAtOnce(
      chosen,
      async (item) => {
        let state: Better | undefined;
        try {
          const { copy, reason } = await findBetterCopy(songIdOf.get(item.key)!, signal);
          state = copy
            ? { status: "found", copy }
            : { status: "none", reason: reason ?? "No better copy was found." };
        } catch (err) {
          state = signal.aborted
            ? undefined
            : { status: "none", reason: `Couldn't look for one: ${messageOf(err)}` };
        }
        setBetterOf(item.key, state);
        // A song with a better copy is replaced, not deleted, unless the person says otherwise.
        if (state?.status === "found") setTicks((all) => new Map(all).set(item.key, false));
      },
      atOnce,
      signal,
      (done, total) => setStage({ name: "finding", done, total }),
    );
    // Stopped: the ones not looked for yet are as they were.
    setBetter((all) => new Map([...all].filter(([, state]) => state.status !== "finding")));
    setStage({ name: "review", stopped: signal.aborted, confirming: false });
  };

  const replaceCopies = async (chosen: Item[]) => {
    const signal = batch.start();
    let replaced = 0;
    let failed = 0;
    let bin = binNameHere();
    await eachAtOnce(
      chosen,
      async (item) => {
        const state = better.get(item.key);
        if (state?.status !== "found") return;
        setBetterOf(item.key, { status: "replacing", copy: state.copy });
        try {
          const answer = await replaceWithBetterCopy(
            songIdOf.get(item.key)!,
            state.copy.url,
            signal,
          );
          replaced++;
          bin = answer.bin;
          // Its new check: it passes the bar now, so it leaves the list.
          setChecks((all) => new Map(all).set(item.key, answer.check));
          setBetterOf(item.key, undefined);
          onReplaced(answer.track);
        } catch (err) {
          if (signal.aborted) setBetterOf(item.key, state);
          else {
            failed++;
            setBetterOf(item.key, { status: "failed", reason: messageOf(err) });
          }
        }
      },
      atOnce,
      signal,
      (done, total) => setStage({ name: "replacing", done, total }),
    );
    const note = [
      replaced > 0 &&
        `Replaced ${count(replaced, "song")} with a better copy; the old ${replaced === 1 ? "one is" : "ones are"} in the ${bin}.`,
      failed > 0 && `${count(failed, "song")} couldn't be replaced.`,
    ]
      .filter(Boolean)
      .join(" ");
    setStage({ name: "review", stopped: signal.aborted, confirming: false, note });
  };

  const remove = async (chosen: Item[], permanently: boolean, deletedBefore = 0) => {
    const signal = batch.start();
    let deleted = deletedBefore;
    let failed = 0;
    let bin = binNameHere();
    const noBin: Item[] = [];
    const deletedKeys: string[] = [];
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
      },
      atOnce,
      signal,
      (done, total) => setStage({ name: "deleting", done, total }),
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
                can't be read through, sound worse than the bar below, or are extra copies of a song
                — and the folder's other files.
              </p>
              <p className="text-xs text-muted-foreground">
                Each song is read all the way through on this computer,{" "}
                {count(Math.max(1, atOnce), "song")} at a time. Nothing is deleted until you've seen
                the list and pressed Delete, and deleted files go to the {binNameHere()}. A song
                that sounds worse than the bar can be replaced by a better copy instead.
              </p>
            </>
          )}

          {(stage.name === "intro" || stage.name === "review") && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-foreground">
              <label className="flex items-center gap-2">
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
              </label>
              {stage.name === "review" && qualityBar !== listedBar ? (
                <>
                  {/* The songs are read already: the new bar only needs their bitrates. */}
                  <button
                    type="button"
                    className={primary}
                    onClick={() => setListedBar(qualityBar)}
                  >
                    Check {count(checks.size, "song")}
                  </button>
                  <span className="text-muted-foreground">
                    The list is for {barText[listedBar]} until you press Check.
                  </span>
                </>
              ) : (
                <span className="text-muted-foreground">
                  Lossless files (FLAC, WAV) always pass.
                </span>
              )}
            </div>
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
              <button type="button" className={secondary} onClick={() => batch.stop()}>
                Stop
              </button>
            </>
          )}

          {(stage.name === "finding" || stage.name === "replacing") && (
            <>
              <p className="flex items-center gap-2 text-foreground" aria-live="polite">
                <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                {stage.name === "finding"
                  ? `Looked for a better copy of ${stage.done.toLocaleString()} of ${count(stage.total, "song")}…`
                  : `Replaced ${stage.done.toLocaleString()} of ${count(stage.total, "song")}…`}
              </p>
              <button type="button" className={secondary} onClick={() => batch.stop()}>
                Stop
              </button>
            </>
          )}

          {stage.name === "review" && (
            <p className="font-medium text-foreground" role="status">
              {stage.note && `${stage.note} `}
              {stage.stopped && "Stopped. "}
              {items.length === 0
                ? "Nothing to clean up: every song checked plays through and passes the bar."
                : `${count(items.length, "file")} to look at. Untick any to keep, then delete the rest.`}
            </p>
          )}

          {(stage.name === "checking" ||
            stage.name === "review" ||
            stage.name === "finding" ||
            stage.name === "replacing") &&
            items.length > 0 && (
              <div className="max-h-96 space-y-3 overflow-y-auto rounded-lg border border-border bg-card px-3 py-2">
                {problemKinds.map((kind) => {
                  const group = byKind(kind);
                  if (group.length === 0) return null;
                  return (
                    <section key={kind} aria-label={problemHeadings[kind]}>
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-xs font-semibold text-foreground">
                          {problemHeadings[kind]} ({group.length.toLocaleString()})
                        </h3>
                        {kind === "lowQuality" &&
                          stage.name === "review" &&
                          findable.length > 0 && (
                            <button
                              type="button"
                              className={secondary}
                              onClick={() => void findCopies(findable)}
                            >
                              <Search className="h-3.5 w-3.5" />
                              Find better copies
                            </button>
                          )}
                        {kind === "lowQuality" &&
                          stage.name === "review" &&
                          toReplace.length > 0 && (
                            <button
                              type="button"
                              className={primary}
                              onClick={() => void replaceCopies(toReplace)}
                            >
                              <CircleArrowUp className="h-3.5 w-3.5" />
                              Replace {count(toReplace.length, "song")}
                            </button>
                          )}
                      </div>
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
                              {item.kind === "lowQuality" && (
                                <BetterCopyLine
                                  state={better.get(item.key)}
                                  ticked={isReplaceTicked(item)}
                                  disabled={stage.name !== "review"}
                                  name={item.name}
                                  onTick={() =>
                                    setReplaceTicks((all) =>
                                      new Map(all).set(item.key, !isReplaceTicked(item)),
                                    )
                                  }
                                />
                              )}
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
        {!["checking", "finding", "replacing", "deleting"].includes(stage.name) && (
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

/** What's become of a low-quality song's better copy, under its line in the list. */
function BetterCopyLine({
  state,
  ticked,
  disabled,
  name,
  onTick,
}: {
  state: Better | undefined;
  ticked: boolean;
  disabled: boolean;
  name: string;
  onTick: () => void;
}) {
  if (!state) return null;
  const line = "mt-1 flex items-start gap-1.5 text-xs";
  switch (state.status) {
    case "finding":
      return (
        <span className={`${line} text-muted-foreground`}>
          <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin" />
          Looking for a better copy…
        </span>
      );
    case "found":
      return (
        <label className={`${line} text-foreground`}>
          <input
            type="checkbox"
            checked={ticked}
            disabled={disabled}
            onChange={onTick}
            aria-label={`Replace “${name}”`}
            className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary"
          />
          <span>Replace it with {betterCopyText(state.copy)}.</span>
        </label>
      );
    case "none":
      return <span className={`${line} text-muted-foreground`}>{state.reason}</span>;
    case "replacing":
      return (
        <span className={`${line} text-foreground`}>
          <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin" />
          Replacing it with {betterCopyText(state.copy)}…
        </span>
      );
    case "failed":
      return (
        <span className={`${line} text-destructive`} role="alert">
          Couldn't replace it: {state.reason}
        </span>
      );
  }
}
