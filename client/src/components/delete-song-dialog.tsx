import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Loader2, Trash2, X } from "lucide-react";
import type { MusicLibrary } from "@shared/schema";
import { MUSIC_KEY } from "@/hooks/use-folder-music";
import { usePlayer } from "@/hooks/use-player";
import { SONGS_IN_FOLDER_KEY } from "@/hooks/use-songs-in-folder";
import { useToast } from "@/hooks/use-toast";
import { binNameHere, deleteFolderSong, type PlayerTrack } from "@/lib/music";

type DeleteSongDialogProps = {
  /** The folder song to delete. */
  track: PlayerTrack & { source: "folder" };
  onClose: () => void;
};

/**
 * "Delete from folder": asks first, then moves the song's file to this
 * computer's Recycle Bin / Trash, so it can be put back from there. The song
 * leaves the player's queue (the next one carries on) and Your music at
 * once. A drive with no bin (a network or removable one) can only delete it
 * for good, so that's asked again, in so many words.
 *
 * A native <dialog>, like the folder browser: focus stays inside, and Escape
 * or a click outside closes it.
 */
export function DeleteSongDialog({ track, onClose }: DeleteSongDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const player = usePlayer();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [bin, setBin] = useState(binNameHere);
  // Asking to move it to the bin, or (its drive has none) to delete it for good.
  const [step, setStep] = useState<"trash" | "for-good">("trash");
  const [noBinReason, setNoBinReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pressedOnBackdrop = useRef(false);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog && !dialog.open) dialog.showModal();
    return () => opener?.focus();
  }, []);

  const close = () => dialogRef.current?.close(); // → onClose, via the "close" event

  const song = `“${track.title}”${track.artist ? ` by ${track.artist}` : ""}`;

  const remove = async () => {
    // Out of the player first, inside the click (the next song may start), so
    // the file isn't being played or converted while it's moved.
    player.discard(track.key);
    setBusy(true);
    setError(null);
    try {
      const outcome = await deleteFolderSong(track.id, { permanently: step === "for-good" });
      setBin(outcome.bin);
      if (!outcome.deleted) {
        setNoBinReason(outcome.message);
        setStep("for-good");
        return;
      }
      // Gone from Your music now; the folder is looked through again to be sure.
      queryClient.setQueriesData<MusicLibrary>(
        { queryKey: MUSIC_KEY },
        (library) =>
          library && { ...library, tracks: library.tracks.filter((t) => t.id !== track.id) },
      );
      void queryClient.invalidateQueries({ queryKey: MUSIC_KEY });
      void queryClient.invalidateQueries({ queryKey: SONGS_IN_FOLDER_KEY });
      toast({
        title: outcome.trashed ? `Moved to the ${outcome.bin}` : "Deleted for good",
        description: outcome.trashed
          ? `${song} — you can put it back from the ${outcome.bin}.`
          : song,
      });
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  const forGood = step === "for-good";

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
      <div className="rounded-2xl border border-border bg-card shadow-2xl">
        <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-4">
          <h2 id={titleId} className="font-display text-lg font-semibold">
            {forGood ? "Delete it for good?" : "Delete from the folder?"}
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
          <p className="break-words text-foreground">{song}</p>
          <p className="break-all text-xs text-muted-foreground">{track.fileName}</p>
          <p className="text-muted-foreground">
            {forGood
              ? `${noBinReason} Deleting it can't be undone.`
              : `The file goes to the ${bin}, so you can put it back from there.`}
          </p>
          {error && (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-destructive"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>Couldn't delete it: {error}</span>
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
            {forGood ? "Keep it" : "Cancel"}
          </button>
          <button
            type="button"
            autoFocus
            onClick={() => void remove()}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-destructive px-3 py-1.5 text-sm font-semibold text-destructive-foreground hover:bg-destructive/90 transition-colors disabled:opacity-60"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            {forGood ? "Delete for good" : `Move to the ${bin}`}
          </button>
        </div>
      </div>
    </dialog>,
    document.body,
  );
}
