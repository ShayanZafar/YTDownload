import { useEffect, useRef, useState } from "react";
import { AlertCircle, Check, Loader2, Minus, Wand2, X } from "lucide-react";
import { api } from "@shared/routes";
import type { MusicTrack, SongLookup } from "@shared/schema";
import type { PlayerTrack } from "@/lib/music";
import {
  catalogueName,
  detailLabels,
  eachAtOnce,
  foundWhere,
  lookUpSongDetails,
  writeSongDetails,
} from "@/lib/song-details";
import { cn } from "@/lib/utils";

type FolderTrack = Extract<PlayerTrack, { source: "folder" }>;

/** A song the catalogues found details for, and whether it's ticked to be written. */
type Found = {
  track: FolderTrack;
  lookup: SongLookup & { found: NonNullable<SongLookup["found"]> };
  keep: boolean;
};

type Stage =
  | { name: "intro" }
  | { name: "looking"; done: number; total: number }
  | {
      name: "review";
      found: Found[];
      notFound: number;
      complete: number;
      unwritable: string[];
      failed: { title: string; message: string }[];
      stopped: boolean;
    }
  | { name: "writing"; done: number; total: number }
  | { name: "done"; added: number; failed: { title: string; message: string }[] };

/** What happened to one song, shown the moment it's done. */
type Outcome = {
  key: string;
  title: string;
  result: "found" | "none" | "failed";
  text: string;
};

const countSongs = (n: number) => `${n.toLocaleString()} ${n === 1 ? "song" : "songs"}`;

const button =
  "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-50";
const primary = `${button} bg-primary text-primary-foreground hover:bg-primary/90`;
const secondary = `${button} border border-border bg-card text-foreground hover:bg-secondary`;

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * "Fill in details": looks the listed songs up in the music catalogues
 * (iTunes, then Deezer), shows what was found for the details each lacks —
 * genre, album, year, track number, cover — and writes the ones ticked into
 * the files. Nothing is written before the person says so, and tags a song
 * has already stay as they are. The song that's playing is left alone.
 */
export function FillInDetails({
  tracks,
  playingKey,
  atOnce,
  onSongWritten,
  onWritten,
  onClose,
}: {
  /** The songs listed (the filters applied), all from the Save to folder. */
  tracks: readonly FolderTrack[];
  /** The song playing now, which isn't changed while it plays. */
  playingKey: string | null;
  /** How many songs at once: the app's computer's CPU cores. */
  atOnce: number;
  /** One song's details are written: here it is as it is now, to show at once. */
  onSongWritten: (track: MusicTrack) => void;
  /** Some files were changed, or marked Not found: the list should be read again. */
  onWritten: () => void;
  onClose: () => void;
}) {
  const [stage, setStage] = useState<Stage>({ name: "intro" });
  // Each song's outcome, newest first, as each is done.
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const report = (outcome: Outcome) => setOutcomes((all) => [outcome, ...all]);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  const playable = tracks.filter((track) => track.key !== playingKey);
  const skipsPlaying = playable.length < tracks.length;
  // Songs marked Not found are left out — unless they're all that's listed (the
  // Details filter set to Not found): then they're looked up again.
  const retrying = playable.length > 0 && playable.every((track) => track.detailsNotFound);
  const toLookUp = retrying ? playable : playable.filter((track) => !track.detailsNotFound);
  const leftOut = playable.length - toLookUp.length;

  const lookUp = async () => {
    const abort = new AbortController();
    controller.current = abort;
    const found: Found[] = [];
    const failed: { title: string; message: string }[] = [];
    const unwritable: string[] = [];
    let notFound = 0;
    let complete = 0;
    let done = 0;
    setOutcomes([]);
    setStage({ name: "looking", done, total: toLookUp.length });
    await eachAtOnce(
      toLookUp,
      async (track) => {
        const { key, title } = track;
        try {
          const lookup = await lookUpSongDetails(track.id, abort.signal);
          if (lookup.problem) {
            failed.push({ title, message: lookup.problem });
            report({ key, title, result: "failed", text: `can't be changed: ${lookup.problem}` });
          } else if (lookup.missing.length === 0) {
            complete++;
            report({ key, title, result: "none", text: "has every detail already" });
          } else if (!lookup.writable) {
            unwritable.push(track.fileName);
            report({ key, title, result: "none", text: "this kind of file can't hold tags" });
          } else if (lookup.found) {
            found.push({ track, lookup: { ...lookup, found: lookup.found }, keep: true });
            report({
              key,
              title,
              result: "found",
              text: `${foundWhere(lookup.source)}: ${detailLabels(lookup.found).join(" · ")}`,
            });
          } else {
            notFound++;
            report({
              key,
              title,
              result: "none",
              text: [
                lookup.notFound
                  ? "not found in iTunes, Deezer or MusicBrainz (marked Not found)"
                  : "not found",
                lookup.notes.join("; "),
              ]
                .filter(Boolean)
                .join(": "),
            });
          }
        } catch (err) {
          if (!abort.signal.aborted) {
            failed.push({ title, message: messageOf(err) });
            report({
              key,
              title,
              result: "failed",
              text: `couldn't be looked up: ${messageOf(err)}`,
            });
          }
        }
        done++;
        if (!abort.signal.aborted) setStage({ name: "looking", done, total: toLookUp.length });
      },
      atOnce,
      abort.signal,
    );
    // Songs found or not found are marked so (or no longer): the list shows it.
    onWritten();
    const order = new Map(toLookUp.map((track, i) => [track.key, i]));
    found.sort((a, b) => order.get(a.track.key)! - order.get(b.track.key)!);
    setStage({
      name: "review",
      found,
      notFound,
      complete,
      unwritable,
      failed,
      stopped: abort.signal.aborted,
    });
  };

  const write = async (found: Found[]) => {
    const kept = found.filter((item) => item.keep);
    const abort = new AbortController();
    controller.current = abort;
    const failed: { title: string; message: string }[] = [];
    let added = 0;
    let done = 0;
    setOutcomes([]);
    setStage({ name: "writing", done, total: kept.length });
    await eachAtOnce(
      kept,
      async ({ track, lookup }) => {
        const { key, title } = track;
        try {
          const written = await writeSongDetails(track.id, lookup.found, abort.signal);
          if (written.added.length > 0) {
            added++;
            if (!abort.signal.aborted) onSongWritten(written.track);
            report({ key, title, result: "found", text: "details added" });
          } else {
            report({ key, title, result: "none", text: "had them all by now" });
          }
        } catch (err) {
          if (!abort.signal.aborted) {
            failed.push({ title, message: messageOf(err) });
            report({
              key,
              title,
              result: "failed",
              text: `couldn't be changed: ${messageOf(err)}`,
            });
          }
        }
        done++;
        if (!abort.signal.aborted) setStage({ name: "writing", done, total: kept.length });
      },
      atOnce,
      abort.signal,
    );
    onWritten();
    setStage({ name: "done", added, failed });
  };

  const stop = () => controller.current?.abort();

  return (
    <section
      aria-label="Fill in details"
      className="border-b border-border bg-secondary/30 px-4 py-3 text-sm"
    >
      <div className="flex items-start gap-2">
        <Wand2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1 space-y-3">
          {stage.name === "intro" && (
            <>
              <p className="text-muted-foreground">
                Looks up the songs listed that are missing a genre, album, year, track number or
                cover in Apple's iTunes catalogue, then Deezer's, then MusicBrainz's, by their
                title, artist and length. You'll see what was found before anything is written, and
                tags the songs already have stay as they are.
                {skipsPlaying && " The song that's playing is left out."}
                {leftOut > 0 &&
                  ` ${countSongs(leftOut)} marked Not found (no catalogue had them) ${leftOut === 1 ? "is" : "are"} left out: choose Not found under Details to look them up again.`}
                {retrying && " These songs are marked Not found: they're looked up again."}
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={primary}
                  disabled={toLookUp.length === 0}
                  onClick={() => void lookUp()}
                >
                  Look up {countSongs(toLookUp.length)}
                </button>
                <button type="button" className={secondary} onClick={onClose}>
                  Close
                </button>
              </div>
            </>
          )}

          {(stage.name === "looking" || stage.name === "writing") && (
            <>
              <p className="flex items-center gap-2 text-foreground" aria-live="polite">
                <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                {stage.name === "looking" ? "Looking up" : "Writing details:"} {stage.done} of{" "}
                {countSongs(stage.total)}…
              </p>
              <div
                className="h-1.5 overflow-hidden rounded-full bg-secondary"
                role="progressbar"
                aria-label={stage.name === "looking" ? "Looking up songs" : "Writing details"}
                aria-valuemin={0}
                aria-valuemax={stage.total}
                aria-valuenow={stage.done}
              >
                <div
                  className="h-full bg-primary transition-[width]"
                  style={{ width: `${stage.total ? (stage.done / stage.total) * 100 : 0}%` }}
                />
              </div>
              <button type="button" className={secondary} onClick={stop}>
                Stop
              </button>
            </>
          )}

          {stage.name !== "intro" && <Outcomes outcomes={outcomes} />}

          {stage.name === "review" && (
            <Review
              stage={stage}
              onChange={(found) => setStage({ ...stage, found })}
              onWrite={() => void write(stage.found)}
              onClose={onClose}
            />
          )}

          {stage.name === "done" && (
            <>
              <p className="flex items-center gap-2 font-medium text-foreground" role="status">
                <Check className="h-4 w-4 shrink-0 text-primary" />
                {stage.added > 0
                  ? `Added details to ${countSongs(stage.added)}.`
                  : "No songs were changed."}
              </p>
              <Failures failed={stage.failed} doing="couldn't be changed" />
              <button type="button" className={secondary} onClick={onClose}>
                Close
              </button>
            </>
          )}
        </div>
        {stage.name !== "looking" && stage.name !== "writing" && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Fill in details"
            className="shrink-0 rounded-lg p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    </section>
  );
}

const OUTCOME_ICONS = {
  found: <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />,
  none: <Minus className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />,
  failed: <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />,
};

/** Every song done so far and what happened to it, the newest at the top. */
function Outcomes({ outcomes }: { outcomes: Outcome[] }) {
  if (outcomes.length === 0) return null;
  return (
    <details open className="text-xs">
      <summary className="cursor-pointer text-muted-foreground">
        Each song ({outcomes.length.toLocaleString()})
      </summary>
      <ul
        role="log"
        aria-label="Each song"
        className="mt-1 max-h-48 space-y-0.5 overflow-y-auto rounded-lg border border-border bg-card px-3 py-2"
      >
        {outcomes.map(({ key, title, result, text }) => (
          <li key={key} className="flex items-start gap-1.5">
            {OUTCOME_ICONS[result]}
            <span className={cn("min-w-0", result === "failed" && "text-destructive")}>
              <span className="font-medium text-foreground">“{title}”</span> {text}
            </span>
          </li>
        ))}
      </ul>
      <a
        href={api.music.detailsLog.path}
        target="_blank"
        rel="noreferrer"
        className="mt-1 inline-block text-muted-foreground underline hover:text-foreground"
      >
        The details log: every song looked up, written or downloaded, and why
      </a>
    </details>
  );
}

function Failures({
  failed,
  doing,
}: {
  failed: { title: string; message: string }[];
  doing: string;
}) {
  if (failed.length === 0) return null;
  return (
    <div className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
      <p className="flex items-center gap-1.5 font-medium">
        <AlertCircle className="h-3.5 w-3.5 shrink-0" />
        {countSongs(failed.length)} {doing}:
      </p>
      <ul className="mt-1 space-y-0.5">
        {failed.slice(0, 5).map(({ title, message }, i) => (
          <li key={i}>
            “{title}”: {message}
          </li>
        ))}
        {failed.length > 5 && <li>…and {failed.length - 5} more.</li>}
      </ul>
    </div>
  );
}

function Review({
  stage,
  onChange,
  onWrite,
  onClose,
}: {
  stage: Extract<Stage, { name: "review" }>;
  onChange: (found: Found[]) => void;
  onWrite: () => void;
  onClose: () => void;
}) {
  const { found, notFound, complete, unwritable, failed, stopped } = stage;
  const kept = found.filter((item) => item.keep).length;
  const others = [
    complete > 0 && `${countSongs(complete)} had every detail already`,
    notFound > 0 && `${countSongs(notFound)} ${notFound === 1 ? "wasn't" : "weren't"} found`,
    unwritable.length > 0 &&
      `${countSongs(unwritable.length)} can't hold tags (${Array.from(
        new Set(unwritable.map((name) => /\.[^.\\/]+$/.exec(name)?.[0].toLowerCase() ?? "")),
      )
        .filter(Boolean)
        .join(", ")})`,
  ].filter(Boolean);
  const toggle = (index: number) =>
    onChange(found.map((item, i) => (i === index ? { ...item, keep: !item.keep } : item)));

  return (
    <>
      <p className="font-medium text-foreground" role="status">
        {found.length > 0
          ? `Found details for ${countSongs(found.length)}. Untick any that aren't the right song.`
          : "No details found to add."}
        {stopped && " (Stopped part-way.)"}
      </p>
      {others.length > 0 && <p className="text-xs text-muted-foreground">{others.join(" · ")}.</p>}
      <Failures failed={failed} doing="couldn't be looked up" />
      {found.length > 0 && (
        <ul className="max-h-80 divide-y divide-border/60 overflow-y-auto rounded-lg border border-border bg-card">
          {found.map(({ track, lookup, keep }, index) => {
            const { match, found: details, source } = lookup;
            return (
              <li key={track.key}>
                <label className="flex cursor-pointer items-start gap-3 px-3 py-2">
                  <input
                    type="checkbox"
                    checked={keep}
                    onChange={() => toggle(index)}
                    aria-label={`Add details to “${track.title}”`}
                    className="mt-1 h-4 w-4 shrink-0 accent-primary"
                  />
                  {details.coverUrl ? (
                    <img
                      src={details.coverUrl}
                      alt=""
                      loading="lazy"
                      className="h-10 w-10 shrink-0 rounded bg-secondary object-cover"
                    />
                  ) : null}
                  <span className={cn("min-w-0 flex-1", !keep && "opacity-60")}>
                    <span className="block truncate font-medium text-foreground">
                      {track.title}
                      {track.artist && (
                        <span className="font-normal text-muted-foreground"> · {track.artist}</span>
                      )}
                    </span>
                    <span className="block text-xs text-foreground">
                      Adds {detailLabels(details).join(" · ")}
                    </span>
                    {match && (
                      <span className="block truncate text-xs text-muted-foreground">
                        Matched “{match.title}” by {match.artist}
                        {match.album && `, on ${match.album}`} ({catalogueName(source)})
                      </span>
                    )}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        {found.length > 0 && (
          <button type="button" className={primary} disabled={kept === 0} onClick={onWrite}>
            Add details to {countSongs(kept)}
          </button>
        )}
        <button type="button" className={secondary} onClick={onClose}>
          {found.length > 0 ? "Cancel" : "Close"}
        </button>
      </div>
    </>
  );
}
