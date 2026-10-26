import { useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, Eraser, Loader2, PencilLine, X } from "lucide-react";
import type { MusicTrack } from "@shared/schema";
import { usePlayer } from "@/hooks/use-player";
import { renameFolderSong, sanitizedNameOf, type PlayerTrack } from "@/lib/music";

type RenameSongDialogProps = {
  /** The folder song to rename. */
  track: PlayerTrack & { source: "folder" };
  /** Renamed: here it is as it is now (its id changes with its file name). */
  onRenamed: (from: string, track: MusicTrack) => void;
  onClose: () => void;
};

const field =
  "w-full min-w-0 rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-foreground disabled:opacity-60";

/**
 * "Rename": a folder song's file name (its extension stays) and its title
 * and artist tags, typed in; "Sanitize" fills in the tidy file name Sanitize
 * Filename would suggest. Only what's changed is written. The song that's
 * playing leaves the player first, so its file isn't in use.
 *
 * A native <dialog>, like Delete from folder: focus stays inside, and Escape
 * or a click outside closes it.
 */
export function RenameSongDialog({ track, onRenamed, onClose }: RenameSongDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const player = usePlayer();
  const file = track.fileName.split(/[\\/]/).pop() ?? track.fileName;
  const ext = /\.[^.]+$/.exec(file)?.[0] ?? "";
  const ownName = file.slice(0, file.length - ext.length);
  const [name, setName] = useState(ownName);
  const [title, setTitle] = useState(track.title);
  const [artist, setArtist] = useState(track.artist ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pressedOnBackdrop = useRef(false);
  const tidy = sanitizedNameOf(track);
  const isCurrent = player.current?.key === track.key;

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog && !dialog.open) dialog.showModal();
    return () => opener?.focus();
  }, []);

  const close = () => dialogRef.current?.close(); // → onClose, via the "close" event

  const change = {
    ...(name.trim() && name.trim() !== ownName ? { name: name.trim() } : {}),
    ...(title.trim() && title.trim() !== track.title ? { title: title.trim() } : {}),
    ...(artist.trim() && artist.trim() !== (track.artist ?? "") ? { artist: artist.trim() } : {}),
  };
  const changed = Object.keys(change).length > 0;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!changed || busy) return;
    // Out of the player first, inside the click, so its file isn't in use.
    if (isCurrent) player.discard(track.key);
    setBusy(true);
    setError(null);
    try {
      const { track: now } = await renameFolderSong(track.id, change);
      onRenamed(track.id, now);
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(event) => {
        if (busy) event.preventDefault();
      }}
      onPointerDown={(event) => {
        pressedOnBackdrop.current = event.target === dialogRef.current;
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current && pressedOnBackdrop.current && !busy) close();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-md border-0 bg-transparent p-0 text-foreground backdrop:bg-black/50 backdrop:backdrop-blur-xs"
    >
      <form
        onSubmit={(event) => void save(event)}
        className="rounded-2xl border border-border bg-card shadow-2xl"
      >
        <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-4">
          <h2 id={titleId} className="font-display text-lg font-semibold">
            Rename
          </h2>
          <button
            type="button"
            onClick={close}
            disabled={busy}
            aria-label="Close"
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors disabled:opacity-50"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-3 px-5 py-4 text-sm">
          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted-foreground">File name</span>
            <span className="flex items-center gap-1">
              <input
                className={field}
                value={name}
                disabled={busy}
                autoFocus
                onChange={(event) => setName(event.target.value)}
              />
              <span className="shrink-0 text-xs text-muted-foreground">{ext}</span>
            </span>
          </label>
          {tidy && name === ownName && (
            <button
              type="button"
              onClick={() => setName(tidy)}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-foreground hover:bg-secondary"
            >
              <Eraser className="h-3.5 w-3.5" />
              Sanitize: “{tidy}”
            </button>
          )}
          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Title</span>
            <input
              className={field}
              value={title}
              disabled={busy}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Artist</span>
            <input
              className={field}
              value={artist}
              disabled={busy}
              onChange={(event) => setArtist(event.target.value)}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            The title and artist are written into the file's tags; its other tags and its audio stay
            as they are. A file name that's taken gets a number.
            {isCurrent && " It's playing, so it leaves the player first."}
          </p>
          {error && (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-destructive"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>Couldn't rename it: {error}</span>
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <button
            type="button"
            onClick={close}
            disabled={busy}
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !changed}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-60"
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <PencilLine className="h-4 w-4" />
            )}
            Save
          </button>
        </div>
      </form>
    </dialog>,
    document.body,
  );
}
