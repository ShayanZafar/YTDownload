import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import {
  AlertCircle,
  Disc3,
  FileAudio,
  FolderOpen,
  FolderSearch,
  ListMusic,
  ListEnd,
  ListStart,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Scissors,
  Search,
  Shuffle,
  X,
} from "lucide-react";
import type { SaveSettings, TimeRange, TrimmedSong } from "@shared/schema";
import { TrimSong } from "@/components/trim-song";
import { ToastAction } from "@/components/ui/toast";
import { useToast } from "@/hooks/use-toast";
import { useDeviceMusic } from "@/hooks/use-device-music";
import { useFolderMusic } from "@/hooks/use-folder-music";
import { usePlayer } from "@/hooks/use-player";
import { useStoredChoice } from "@/hooks/use-stored-choice";
import { formatDuration } from "@/lib/format";
import {
  AUDIO_FILE_ACCEPT,
  filterTracks,
  folderTrack,
  musicSortLabels,
  musicSorts,
  sortTracks,
  type MusicSort,
  type PlayerTrack,
} from "@/lib/music";
import { folderName } from "@/lib/save-to-folder";
import { canTrimFile, formatCutTime, undoTrim } from "@/lib/trim";
import { cn } from "@/lib/utils";

type MusicLibraryProps = {
  /** The Save to setting, or undefined while it loads. */
  settings?: SaveSettings;
  /** The Save to folder, when this browser can play from it (null otherwise). */
  folder: string | null;
  onChooseFolder: () => void;
};

// Songs listed at first, and how many more each "Show more" adds.
const PAGE = 100;
// Show a filter box once a list is long enough to need one.
const FILTER_FROM = 9;

const countSongs = (n: number) => `${n.toLocaleString()} ${n === 1 ? "song" : "songs"}`;

// Picking a whole folder works in desktop browsers; phones pick songs.
const canPickFolders = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(pointer: fine)").matches === true &&
  "webkitdirectory" in HTMLInputElement.prototype;

const smallButton =
  "inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-secondary focus-within:ring-2 focus-within:ring-primary/40";

/** "1 song can't play in this browser (.wma)". */
function unplayableNote(tracks: PlayerTrack[]): string {
  const kinds = Array.from(
    new Set(tracks.map((t) => /\.[^.\\/]+$/.exec(t.fileName)?.[0].toLowerCase()).filter(Boolean)),
  );
  return `${countSongs(tracks.length)} can't play in this browser${kinds.length ? ` (${kinds.join(", ")})` : ""}.`;
}

/** Play next, or Add to queue (at the end). */
type Enqueue = "next" | "last";

type SongRowProps = {
  track: PlayerTrack;
  /** Its place in the list, from 1. */
  number: number;
  isCurrent: boolean;
  isPlaying: boolean;
  /** Can this browser play it? */
  ok: boolean;
  onPlay: (track: PlayerTrack) => void;
  onEnqueue: (track: PlayerTrack, where: Enqueue) => void;
  /** Opens the trim window, for a song in the folder. */
  onTrim: (track: PlayerTrack) => void;
};

/** A song in the list: click it to play the list from there, or line it up. */
const SongRow = memo(function SongRow({
  track,
  number,
  isCurrent,
  isPlaying,
  ok,
  onPlay,
  onEnqueue,
  onTrim,
}: SongRowProps) {
  const byline = [track.artist, track.album].filter(Boolean).join(" · ");
  return (
    <li className={cn("flex items-center", isCurrent && "bg-primary/5")}>
      <button
        type="button"
        onClick={() => onPlay(track)}
        disabled={!ok}
        aria-current={isCurrent ? "true" : undefined}
        aria-label={[
          `${isPlaying ? "Pause" : "Play"} “${track.title}”`,
          track.artist && `by ${track.artist}`,
          track.duration != null && formatDuration(track.duration),
          !ok && "this browser can't play it",
        ]
          .filter(Boolean)
          .join(", ")}
        title={track.fileName}
        className={cn(
          "group flex min-w-0 flex-1 items-center gap-3 py-2.5 pl-4 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
          ok ? "pr-2" : "pr-4",
          !isCurrent && "enabled:hover:bg-secondary/40",
        )}
      >
        <span className="flex w-6 shrink-0 justify-end text-xs tabular-nums text-muted-foreground">
          {isCurrent ? (
            isPlaying ? (
              <span className="flex h-3.5 items-end gap-[2px]" aria-hidden="true">
                <span className="w-[3px] animate-[pulse_0.9s_ease-in-out_infinite] rounded-sm bg-primary h-full" />
                <span className="w-[3px] animate-[pulse_0.9s_ease-in-out_0.3s_infinite] rounded-sm bg-primary h-2/3" />
                <span className="w-[3px] animate-[pulse_0.9s_ease-in-out_0.6s_infinite] rounded-sm bg-primary h-5/6" />
              </span>
            ) : (
              <Pause className="h-3.5 w-3.5 text-primary" />
            )
          ) : (
            number
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block truncate text-sm font-medium",
              isCurrent ? "text-primary" : "text-foreground",
            )}
          >
            {track.title}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {ok ? byline || " " : "Can't play in this browser"}
          </span>
        </span>
        {track.duration != null && (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {formatDuration(track.duration)}
          </span>
        )}
        {ok &&
          (isPlaying ? (
            <Pause className="h-4 w-4 shrink-0 text-primary" />
          ) : (
            <Play
              className={cn(
                "h-4 w-4 shrink-0",
                isCurrent ? "text-primary" : "text-muted-foreground/50 group-hover:text-foreground",
              )}
            />
          ))}
      </button>
      {ok && (
        <span className="flex shrink-0 items-center pr-2">
          {(
            [
              ["next", ListStart, "Play next"],
              ["last", ListEnd, "Add to queue"],
            ] as const
          ).map(([where, Icon, label]) => (
            <button
              key={where}
              type="button"
              onClick={() => onEnqueue(track, where)}
              aria-label={`${label}: “${track.title}”`}
              title={label}
              className="rounded-lg p-1.5 text-muted-foreground/60 hover:bg-secondary hover:text-foreground transition-colors"
            >
              <Icon className="h-4 w-4" />
            </button>
          ))}
          {track.source === "folder" && canTrimFile(track.fileName) && (
            <button
              type="button"
              onClick={() => onTrim(track)}
              aria-label={`Trim: “${track.title}”`}
              title="Trim (cut out dead air)"
              className="rounded-lg p-1.5 text-muted-foreground/60 hover:bg-secondary hover:text-foreground transition-colors"
            >
              <Scissors className="h-4 w-4" />
            </button>
          )}
        </span>
      )}
    </li>
  );
});

/**
 * "Your music": the songs the player can play. In a browser on the computer
 * running the app, those are the songs in the Save to folder (the app plays
 * them, converting any this browser can't). Anywhere — on a phone, say —
 * songs stored on the device can be picked to play; they never leave it.
 * Click a song to play the list from there.
 */
export function MusicLibrary({ settings, folder, onChooseFolder }: MusicLibraryProps) {
  const player = usePlayer();
  const { toast } = useToast();
  const folderMusic = useFolderMusic(folder);
  const device = useDeviceMusic();
  const [chosenSource, setSource] = useState<"folder" | "device">("folder");
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useStoredChoice<MusicSort>("music-sort", musicSorts, "added");
  const [limit, setLimit] = useState(PAGE);
  const [pickFolders] = useState(canPickFolders);
  const isLocal = settings?.canSaveToFolder === true;

  const folderTracks = useMemo(
    () => (folderMusic.data?.tracks ?? []).map(folderTrack),
    [folderMusic.data],
  );
  const hasDeviceSongs = device.tracks.length > 0;
  // The folder's songs or the ones picked here; with both, a switch between them.
  const source =
    folder !== null && hasDeviceSongs ? chosenSource : hasDeviceSongs ? "device" : "folder";
  const tracks = source === "folder" ? folderTracks : device.tracks;

  // Can this browser play a picked song? (The app converts folder songs it can't.)
  const canPlayHere = useMemo(() => {
    const probe = typeof document !== "undefined" ? document.createElement("audio") : null;
    const known = new Map<string, boolean>();
    return (track: PlayerTrack) => {
      if (track.source === "folder" || !probe || track.check === "") return true;
      let ok = known.get(track.check);
      if (ok === undefined) {
        ok = probe.canPlayType(track.check) !== "";
        known.set(track.check, ok);
      }
      return ok;
    };
  }, []);

  const shown = useMemo(
    () => sortTracks(filterTracks(tracks, filter), sort),
    [tracks, filter, sort],
  );
  const playable = useMemo(() => shown.filter(canPlayHere), [shown, canPlayHere]);
  const unplayable = useMemo(
    () => (source === "device" ? device.tracks.filter((t) => !canPlayHere(t)) : []),
    [source, device.tracks, canPlayHere],
  );
  const listed = shown.slice(0, limit);

  // Songs already in the player get their newer details (tags read since, say).
  const { refresh } = player;
  useEffect(() => refresh(device.tracks), [refresh, device.tracks]);
  useEffect(() => refresh(folderTracks), [refresh, folderTracks]);
  // A different list starts from the top.
  useEffect(() => setLimit(PAGE), [source, filter, sort, folder]);

  const playFrom = (track: PlayerTrack) => {
    if (player.current?.key === track.key) return player.toggle();
    player.play(playable, Math.max(0, playable.indexOf(track)));
  };

  // Play next / Add to queue: after the current song, or at the end.
  const enqueue = (track: PlayerTrack, where: Enqueue) => {
    const playing = player.current !== null;
    player.enqueue([track], where);
    // It plays now, or Up next shows it.
    if (!playing || player.upNextOpen) return;
    toast({
      title: where === "next" ? "Plays next" : "Added to the queue",
      description: `“${track.title}”${track.artist ? ` by ${track.artist}` : ""}`,
    });
  };

  // Trimming a folder song: the trim window, then a note with Undo.
  const [trimming, setTrimming] = useState<(PlayerTrack & { source: "folder" }) | null>(null);
  const trimmed = (track: PlayerTrack, done: TrimmedSong, cut: TimeRange) => {
    void folderMusic.refetch();
    const undo = () => {
      if (player.current?.key === track.key) player.letGo(track.key, cut.start);
      undoTrim(done.undo)
        .then(() => toast({ title: "Put back as it was", description: `“${track.title}”` }))
        .catch((err: Error) =>
          toast({
            title: "Couldn't undo the trim",
            description: err.message,
            variant: "destructive",
          }),
        )
        .finally(() => void folderMusic.refetch());
    };
    toast({
      title: `Cut ${done.removed.toFixed(1)} s out of “${track.title}”`,
      description: `${formatCutTime(cut.start)}–${formatCutTime(cut.end)} is gone; it's ${formatCutTime(done.duration)} long now.`,
      action: (
        <ToastAction altText="Undo the trim" onClick={undo}>
          Undo
        </ToastAction>
      ),
    });
  };

  // The rows' clicks, which never change (they call the latest playFrom and
  // enqueue), so a row draws again only when its song, place or playing
  // state does: Show more draws just the new rows, however long the list is.
  const actions = useRef({ playFrom, enqueue });
  useLayoutEffect(() => {
    actions.current = { playFrom, enqueue };
  });
  const onTrim = useCallback((track: PlayerTrack) => {
    if (track.source === "folder") setTrimming(track);
  }, []);
  const onPlay = useCallback((track: PlayerTrack) => actions.current.playFrom(track), []);
  const onEnqueue = useCallback(
    (track: PlayerTrack, where: Enqueue) => actions.current.enqueue(track, where),
    [],
  );

  const onPicked = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = ""; // the same songs can be picked again
    if (files.length === 0) return;
    const added = device.add(files);
    if (added > 0) {
      setSource("device");
      setFilter("");
    } else {
      toast({
        title: "No new songs",
        description: files.some((f) => f.type.startsWith("audio/") || /\.\w+$/.test(f.name))
          ? "Those songs are in the list already, or aren't audio files."
          : "Pick audio files, like .mp3 or .m4a.",
      });
    }
  };

  const picker = (label: string, folders = false) => (
    <label className={smallButton}>
      <input
        type="file"
        multiple
        accept={folders ? undefined : AUDIO_FILE_ACCEPT}
        ref={(input) => {
          if (input && folders) input.setAttribute("webkitdirectory", "");
        }}
        onChange={onPicked}
        className="sr-only"
      />
      {folders ? <FolderSearch className="h-3.5 w-3.5" /> : <FileAudio className="h-3.5 w-3.5" />}
      {label}
    </label>
  );

  const clearButton = (
    <button
      type="button"
      onClick={device.clear}
      aria-label="Clear the opened songs"
      title="Clear the opened songs"
      className="shrink-0 rounded-lg p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
    >
      <X className="h-4 w-4" />
    </button>
  );

  const isLoadingFolder = source === "folder" && folder !== null && folderMusic.isLoading;
  const folderError = source === "folder" && folder !== null ? folderMusic.error : null;
  const where = folder ? `“${folderName(folder)}”` : "";

  return (
    <section aria-label="Your music" className="mt-12 max-w-4xl mx-auto w-full space-y-4">
      <div className="flex items-center gap-2 px-2">
        <Disc3 className="w-5 h-5 text-muted-foreground" />
        <h2 className="text-xl font-display font-semibold">Your music</h2>
        {tracks.length > 0 && (
          <span className="ml-auto text-sm text-muted-foreground tabular-nums" aria-live="polite">
            {filter.trim()
              ? `${shown.length} of ${countSongs(tracks.length)}`
              : countSongs(tracks.length)}
          </span>
        )}
      </div>

      <div className="rounded-2xl border border-border bg-card overflow-hidden">
        {/* Where the songs come from, and adding more. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3 text-sm text-muted-foreground">
          {isLocal && folder ? (
            <p className="flex min-w-0 flex-1 items-center gap-1.5">
              <FolderOpen className="h-4 w-4 shrink-0" />
              <span className="truncate">
                Songs in{" "}
                <span className="font-medium text-foreground" title={folder}>
                  {where}
                </span>
                , the Save to folder
              </span>
            </p>
          ) : isLocal ? (
            <p className="min-w-0 flex-1">
              Choose a folder under <span className="font-medium text-foreground">Save to</span> to
              play the songs in it here — or open songs from this computer.
            </p>
          ) : settings ? (
            <p className="min-w-0 flex-1">
              Play songs stored on this device. They stay on it — nothing is uploaded.
            </p>
          ) : (
            <p className="min-w-0 flex-1">&nbsp;</p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {isLocal && folder && (
              <button
                type="button"
                onClick={() => void folderMusic.refetch()}
                disabled={folderMusic.isFetching}
                aria-label="Look through the folder again"
                title="Look through the folder again"
                className="rounded-lg p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors disabled:opacity-60"
              >
                <RefreshCw className={cn("h-4 w-4", folderMusic.isFetching && "animate-spin")} />
              </button>
            )}
            {isLocal && !folder && (
              <button type="button" onClick={onChooseFolder} className={smallButton}>
                <FolderOpen className="h-3.5 w-3.5" />
                Choose the Save to folder
              </button>
            )}
            {settings && picker(isLocal ? "Open songs" : "Choose songs")}
            {settings && pickFolders && picker("Open a folder", true)}
            {source === "device" && folder === null && clearButton}
          </div>
        </div>

        {/* With songs from both places: which to show. */}
        {folder !== null && hasDeviceSongs && (
          <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
            <div
              role="group"
              aria-label="Show songs from"
              className="inline-flex rounded-full border border-border bg-secondary/60 p-1"
            >
              {(
                [
                  ["folder", `In ${where} (${folderTracks.length})`],
                  ["device", `Opened here (${device.tracks.length})`],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={source === value}
                  onClick={() => setSource(value)}
                  className={cn(
                    "max-w-56 truncate rounded-full px-3 py-1 text-xs font-medium transition-colors",
                    source === value
                      ? "bg-card text-foreground shadow-xs"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            {source === "device" && clearButton}
          </div>
        )}

        {folderError && (
          <p
            role="alert"
            className="m-4 flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Couldn't look through {where}: {folderError.message}
            </span>
          </p>
        )}

        {/* Filter, order, play all. */}
        {tracks.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
            {tracks.length >= FILTER_FROM && (
              <label className="flex min-w-40 flex-1 items-center gap-2 rounded-lg bg-secondary/50 px-3">
                <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
                <input
                  type="search"
                  aria-label="Filter your music"
                  placeholder="Filter songs"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  className="h-9 min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-hidden"
                />
              </label>
            )}
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="sr-only sm:not-sr-only">Order</span>
              <select
                aria-label="Order songs by"
                value={sort}
                onChange={(event) => setSort(event.target.value as MusicSort)}
                className="h-9 rounded-lg border border-border bg-card px-2 text-xs font-medium text-foreground"
              >
                {musicSorts.map((value) => (
                  <option key={value} value={value}>
                    {musicSortLabels[value]}
                  </option>
                ))}
              </select>
            </label>
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                disabled={playable.length === 0}
                onClick={() => player.play(playable, 0, { shuffle: false })}
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                <Play className="h-3.5 w-3.5" />
                Play all
              </button>
              <button
                type="button"
                disabled={playable.length === 0}
                onClick={() =>
                  player.play(playable, Math.floor(Math.random() * playable.length), {
                    shuffle: true,
                  })
                }
                className={smallButton}
              >
                <Shuffle className="h-3.5 w-3.5" />
                Shuffle
              </button>
            </div>
          </div>
        )}

        {isLoadingFolder ? (
          <div className="divide-y divide-border/60" aria-hidden="true">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-3">
                <div className="h-3 w-6 rounded bg-secondary animate-pulse" />
                <div className="flex-1 space-y-2">
                  <div className="h-3.5 w-1/2 rounded bg-secondary animate-pulse" />
                  <div className="h-3 w-1/4 rounded bg-secondary/70 animate-pulse" />
                </div>
              </div>
            ))}
          </div>
        ) : listed.length > 0 ? (
          <ol className="max-h-112 divide-y divide-border/60 overflow-y-auto">
            {listed.map((track, index) => {
              const isCurrent = player.current?.key === track.key;
              return (
                <SongRow
                  key={track.key}
                  track={track}
                  number={index + 1}
                  isCurrent={isCurrent}
                  isPlaying={isCurrent && player.status === "playing"}
                  ok={canPlayHere(track)}
                  onPlay={onPlay}
                  onEnqueue={onEnqueue}
                  onTrim={onTrim}
                />
              );
            })}
          </ol>
        ) : tracks.length > 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            No songs match “{filter.trim()}”.
          </p>
        ) : source === "folder" && folder && folderMusic.data ? (
          <div className="px-4 py-10 text-center">
            <ListMusic className="mx-auto mb-3 h-8 w-8 text-muted-foreground/60" />
            <p className="text-sm font-medium text-foreground">No songs in {where} yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Downloads you save there show up here, ready to play.
            </p>
          </div>
        ) : null}

        {shown.length > listed.length && (
          <button
            type="button"
            onClick={() => setLimit((n) => n + PAGE)}
            className="w-full border-t border-border py-2.5 text-sm font-medium text-foreground hover:bg-secondary transition-colors"
          >
            Show more ({(shown.length - listed.length).toLocaleString()} more)
          </button>
        )}

        {(source === "device" && (device.reading > 0 || unplayable.length > 0)) ||
        (source === "folder" && folderMusic.data && !folderMusic.data.complete) ? (
          <p className="flex items-center gap-2 border-t border-border bg-secondary/40 px-4 py-2 text-xs text-muted-foreground">
            {source === "device" && device.reading > 0 && (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
            )}
            <span>
              {source === "folder"
                ? `${where} has more songs than the app looks through — these are the first ${countSongs(folderTracks.length)}.`
                : [
                    device.reading > 0 && `Reading the songs' tags… (${device.reading} to go)`,
                    unplayable.length > 0 && unplayableNote(unplayable),
                  ]
                    .filter(Boolean)
                    .join(" ")}
            </span>
          </p>
        ) : null}
      </div>
      {trimming && (
        <TrimSong
          key={trimming.key}
          track={trimming}
          onTrimmed={(done, cut) => trimmed(trimming, done, cut)}
          onClose={() => setTrimming(null)}
        />
      )}
    </section>
  );
}
