import { useState } from "react";
import { AlertCircle, Check, Copy, Eraser, Loader2, Pause, Play, Trash2, X } from "lucide-react";
import type { MusicTrack } from "@shared/schema";
import {
  folderArtistsFor,
  renameFolderSong,
  sanitizeChangeOf,
  tidyOf,
  type PlayerTrack,
} from "@/lib/music";
import { formatDuration } from "@/lib/format";
import { usePlayer } from "@/hooks/use-player";
import { eachAtOnce } from "@/lib/at-once";
import { useBatchRun } from "@/hooks/use-batch-run";
import { cn } from "@/lib/utils";

type FolderTrack = Extract<PlayerTrack, { source: "folder" }>;

/**
 * A song whose name, title or artist would change, what to (`title` and
 * `artist` only when they change), and whether it's ticked to be changed.
 */
type Rename = { track: FolderTrack; name: string; title?: string; artist?: string; keep: boolean };

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
/** The extension it will have: the right one for what's in it ("Song.mp3" that's an M4A: .m4a). */
const newExtOf = (track: FolderTrack) => track.realType ?? extOf(track);
const nameOf = (track: FolderTrack) => fileOf(track).slice(0, -extOf(track).length || undefined);
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
/** Where a song's file is, as compared: "/" between folders, any case. */
const placeOf = (fileName: string) => fileName.replace(/\\/g, "/").toLowerCase();
const folderOf = (track: FolderTrack) => placeOf(track.fileName).replace(/[^/]*$/, "");
/** The song (and file name) that already has the name a rename would give, if any. */
type Clash = { other: FolderTrack; fileName: string };

/**
 * The renames whose new name another song has — one in the folder, or one an
 * earlier rename in the list gives — by the renamed song's key. No number is
 * ever added: such a song is likely a copy, for the person to delete.
 */
function clashesOf(renames: readonly Rename[], folder: readonly FolderTrack[]): Map<string, Clash> {
  const byPlace = new Map(folder.map((track) => [placeOf(track.fileName), track]));
  const clashes = new Map<string, Clash>();
  for (const { track, name, keep } of renames) {
    if (!keep || !name.trim()) continue;
    const fileName = `${name.trim()}${newExtOf(track)}`;
    const place = folderOf(track) + fileName.toLowerCase();
    const other = byPlace.get(place);
    if (other && other.key !== track.key) clashes.set(track.key, { other, fileName });
    else byPlace.set(place, track); // the next one to that name clashes with this one
  }
  return clashes;
}

/**
 * "Sanitize Filename": suggests a tidy name for each listed song whose file
 * name carries what videos and copies add — "(Official Video)", "HQ",
 * "(1998)", a copy's "(1)", "&#39" — or doesn't say its artist ("Artist -
 * Title"), and a tidy title and artist for one whose tags are untidy the same
 * way or name the channel that uploaded it (tidyOf()); then changes only the
 * ones ticked, each editable first. The extension stays, and the song that's
 * playing is left alone. A name another song has already is never given (nor
 * a number added): the two are shown side by side, each to listen to, to
 * delete one if they're the same.
 */
export function SanitizeNames({
  tracks,
  folderTracks,
  atOnce,
  onSongRenamed,
  onRenamed,
  onDelete,
  onClose,
}: {
  /** The songs listed (the filters applied), all from the Save to folder. */
  tracks: readonly FolderTrack[];
  /** All the folder's songs, to see which names are taken. */
  folderTracks: readonly FolderTrack[];
  /** How many songs at once: the app's computer's CPU cores. */
  atOnce: number;
  /** One song was renamed (it had id `from`): here it is as it is now, to show at once. */
  onSongRenamed: (from: string, track: MusicTrack) => void;
  /** Some files were renamed: the list should be read again. */
  onRenamed: () => void;
  /** Delete this song (asking first): one of two with the same name. */
  onDelete: (track: FolderTrack) => void;
  onClose: () => void;
}) {
  const player = usePlayer();
  // The song playing as it opens isn't offered: it's left alone while it plays.
  const [playingKey] = useState(() => player.current?.key ?? null);
  const [stage, setStage] = useState<Stage>(() => {
    // What the whole folder says about its artists: "Song - Artist" put round, a
    // channel's uploads given their artist, each artist spelt as the folder spells it.
    const folder = folderArtistsFor(folderTracks);
    return {
      name: "review",
      renames: tracks.flatMap((track) => {
        if (track.key === playingKey) return [];
        // A tidier name, title or artist, or (for an M4A named .mp3, say) the same
        // name with the right extension.
        const tidy = tidyOf(track, folder);
        if (!tidy && !track.realType) return [];
        return [{ track, ...tidy, name: tidy?.name ?? nameOf(track), keep: true }];
      }),
    };
  });
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const batch = useBatchRun();

  // A song deleted since (one of two with the same name) leaves the list.
  const present = new Set(folderTracks.map((track) => track.key));
  const renames =
    stage.name === "review" ? stage.renames.filter(({ track }) => present.has(track.key)) : [];
  const clashes = clashesOf(renames, folderTracks);

  const rename = async (renames: Rename[]) => {
    const kept = renames.filter(
      (item) => item.keep && item.name.trim() && !clashes.has(item.track.key),
    );
    // A song listened to since (one of two with a name) leaves the player first, inside
    // the click, so its file isn't being played while it's renamed.
    const current = player.current?.key;
    if (current && kept.some(({ track }) => track.key === current)) player.discard(current);
    const signal = batch.start();
    let renamed = 0;
    let failed = 0;
    setOutcomes([]);
    await eachAtOnce(
      kept,
      async ({ track, name, title, artist }) => {
        const from = fileOf(track);
        // Only what changes: its name (or extension), its title, its artist.
        const change = sanitizeChangeOf(track, { name, title, artist });
        try {
          const { track: now } = await renameFolderSong(track.id, change, signal);
          renamed++;
          if (!signal.aborted) onSongRenamed(track.id, now);
          const to = now.path.split(/[\\/]/).pop();
          const tags = [
            change.title && `title “${change.title}”`,
            change.artist && `artist “${change.artist}”`,
          ]
            .filter(Boolean)
            .join(", ");
          const text =
            to === from
              ? `“${from}” has its ${tags}`
              : `“${from}” is now “${to}”${tags ? `, with its ${tags}` : ""}`;
          setOutcomes((all) => [{ key: track.key, text, failed: false }, ...all]);
        } catch (err) {
          if (!signal.aborted) {
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
      },
      atOnce,
      signal,
      (done, total) => setStage({ name: "renaming", done, total }),
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
              renames={renames}
              clashes={clashes}
              listening={{
                key: player.current?.key ?? null,
                playing: player.status === "playing",
              }}
              onListen={(track) =>
                player.current?.key === track.key ? player.toggle() : player.play([track], 0)
              }
              onDelete={onDelete}
              skipsPlaying={tracks.some((track) => track.key === playingKey)}
              onChange={(renames) => setStage({ name: "review", renames })}
              onRename={() => void rename(renames)}
              onClose={onClose}
            />
          )}

          {stage.name === "renaming" && (
            <>
              <p className="flex items-center gap-2 text-foreground" aria-live="polite">
                <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                Renaming {stage.done} of {countSongs(stage.total)}…
              </p>
              <button type="button" className={secondary} onClick={() => batch.stop()}>
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
  clashes,
  listening,
  onListen,
  onDelete,
  skipsPlaying,
  onChange,
  onRename,
  onClose,
}: {
  renames: Rename[];
  clashes: Map<string, Clash>;
  /** The player's song, and whether it's playing (not paused). */
  listening: { key: string | null; playing: boolean };
  /** Play this song on its own, to hear it (or pause it, if it's the one playing). */
  onListen: (track: FolderTrack) => void;
  onDelete: (track: FolderTrack) => void;
  skipsPlaying: boolean;
  onChange: (renames: Rename[]) => void;
  onRename: () => void;
  onClose: () => void;
}) {
  const kept = renames.filter(
    (item) => item.keep && item.name.trim() && !clashes.has(item.track.key),
  ).length;
  const update = (index: number, change: Partial<Rename>) =>
    onChange(renames.map((item, i) => (i === index ? { ...item, ...change } : item)));
  const lengthOf = (track: FolderTrack) =>
    track.duration === null ? "" : ` (${formatDuration(track.duration)})`;

  return (
    <>
      <p className="font-medium text-foreground" role="status">
        {renames.length > 0
          ? `${countSongs(renames.length)} could have a tidier name, title or artist. Untick any to leave as they are, or change one first.`
          : "Every song listed has a tidy name, title and artist already."}
        {clashes.size > 0 &&
          ` ${countSongs(clashes.size)} would have the name of another song: if it's the same song twice, delete one, or change the name.`}
      </p>
      <p className="text-xs text-muted-foreground">
        Takes out what videos and copies add to a name: “(Official Video)”, “HQ”, “Lyrics Video”, a
        year in brackets, a copy's “(1)”; a song whose name doesn't say its artist is named “Artist
        - Title”. Titles and artists are tidied the same way, with the artist a title names rather
        than the channel that uploaded it, and “ft.” as “(feat. …)”. The extension stays (unless
        it's wrong: an M4A named .mp3 becomes .m4a). A name another song has is never given, nor a
        number added. Playlists saved as .m3u8 files list songs by name, so they won't find a
        renamed song.
        {skipsPlaying && " The song that's playing is left out."}
      </p>
      {renames.length > 0 && (
        <ul className="max-h-80 divide-y divide-border/60 overflow-y-auto rounded-lg border border-border bg-card">
          {renames.map(({ track, name, title, artist, keep }, index) => {
            const clash = clashes.get(track.key);
            const renaming = name !== nameOf(track) || !!track.realType;
            return (
              <li key={track.key} className="flex items-start gap-3 px-3 py-2">
                <input
                  type="checkbox"
                  checked={keep && !clash}
                  disabled={!!clash}
                  onChange={() => update(index, { keep: !keep })}
                  aria-label={`Rename “${fileOf(track)}”`}
                  className="mt-1.5 h-4 w-4 shrink-0 accent-primary"
                />
                <span className={cn("min-w-0 flex-1 space-y-1", !keep && "opacity-60")}>
                  <span
                    className={cn(
                      "block truncate text-xs text-muted-foreground",
                      renaming && "line-through",
                    )}
                  >
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
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {newExtOf(track)}
                    </span>
                  </span>
                  {(title !== undefined || artist !== undefined) && (
                    <span className="flex flex-wrap items-center gap-1 text-xs">
                      {artist !== undefined && (
                        <input
                          type="text"
                          value={artist}
                          disabled={!keep}
                          onChange={(event) => update(index, { artist: event.target.value })}
                          aria-label={`Artist for “${fileOf(track)}”`}
                          className="min-w-0 flex-1 basis-32 rounded border border-border bg-background px-2 py-1 text-foreground"
                        />
                      )}
                      {title !== undefined && (
                        <input
                          type="text"
                          value={title}
                          disabled={!keep}
                          onChange={(event) => update(index, { title: event.target.value })}
                          aria-label={`Title for “${fileOf(track)}”`}
                          className="min-w-0 flex-[2] basis-40 rounded border border-border bg-background px-2 py-1 text-foreground"
                        />
                      )}
                      <span className="basis-full text-muted-foreground">
                        Its tags now: “{track.title}”
                        {track.artist ? ` by ${track.artist}` : ", no artist"}
                      </span>
                    </span>
                  )}
                  {clash && (
                    <span className="block space-y-1 text-xs text-amber-700 dark:text-amber-400">
                      <span className="flex items-start gap-1">
                        <Copy className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>
                          “{fileOf(clash.other)}”{lengthOf(clash.other)} has that name already: this
                          one{lengthOf(track)} may be the same song. Listen to both to choose.
                        </span>
                      </span>
                      <span className="flex flex-wrap gap-1.5">
                        {[track, clash.other].map((song) => {
                          const playing = listening.playing && listening.key === song.key;
                          return (
                            <span key={song.key} className="inline-flex min-w-0 gap-1">
                              <button
                                type="button"
                                className={cn(
                                  secondary,
                                  "px-2",
                                  listening.key === song.key && "border-primary text-primary",
                                )}
                                disabled={!!song.notAudio}
                                onClick={() => onListen(song)}
                                aria-label={`${playing ? "Pause" : "Play"} “${fileOf(song)}”`}
                                title={playing ? "Pause" : "Play"}
                              >
                                {playing ? (
                                  <Pause className="h-3.5 w-3.5" />
                                ) : (
                                  <Play className="h-3.5 w-3.5" />
                                )}
                              </button>
                              <button
                                type="button"
                                className={secondary}
                                onClick={() => onDelete(song)}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                                Delete “{fileOf(song)}”
                              </button>
                            </span>
                          );
                        })}
                      </span>
                    </span>
                  )}
                </span>
              </li>
            );
          })}
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
