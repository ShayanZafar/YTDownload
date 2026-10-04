import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertCircle,
  ArrowUp,
  ChevronRight,
  Download,
  FileText,
  Folder,
  FolderPlus,
  HardDrive,
  Home,
  Loader2,
  Monitor,
  Music,
  X,
  type LucideIcon,
} from "lucide-react";
import type { FolderListing } from "@shared/schema";
import { createFolder, folderName, listFolders } from "@/lib/save-to-folder";
import { cn } from "@/lib/utils";

type FolderPickerProps = {
  /**
   * Called with the folder picked. If it rejects, its message is shown and the
   * picker stays open (e.g. a folder the app isn't allowed to write into).
   */
  onChoose: (folder: string) => Promise<unknown>;
  onClose: () => void;
};

const PLACE_ICONS: Record<string, LucideIcon> = {
  Music,
  Downloads: Download,
  Desktop: Monitor,
  Documents: FileText,
  Home,
};

const messageOf = (err: unknown) => (err instanceof Error ? err.message : "Something went wrong.");

/**
 * The app's own folder browser for "Save to" — browsers can't show a folder
 * picker that tells the app a real folder, so the app lists the folders on
 * this computer itself. Opens where downloads go now (or Music). Click a
 * folder to open it, type or paste a path, or make a new folder; then "Use".
 *
 * A native <dialog> (every current browser has one): it keeps keyboard focus
 * inside, and Escape or clicking outside closes it.
 */
export function FolderPicker({ onChoose, onClose }: FolderPickerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pathBoxRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const titleId = useId();
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [typedPath, setTypedPath] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The new folder's name while one is being made; null otherwise.
  const [newName, setNewName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  // After opening a folder from the list, the button that had focus is gone —
  // put focus on the new list instead of losing it.
  const focusListNext = useRef(false);
  const pressedOnBackdrop = useRef(false);

  const browse = async (path?: string) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    focusListNext.current = !!listRef.current?.contains(document.activeElement);
    // A path typed while this loads (say, pasted while the picker is still
    // opening) stays in the box when the answer comes: Enter opens what was typed.
    const pathShown = typedPath;
    setLoading(true);
    setError(null);
    try {
      const next = await listFolders(path, controller.signal);
      setListing(next);
      setTypedPath((shown) => (shown === pathShown ? next.path : shown));
      setNewName(null);
    } catch (err) {
      if (!controller.signal.aborted) setError(messageOf(err));
    } finally {
      if (request.current === controller) setLoading(false);
    }
  };

  // Open as a modal straight away, starting where downloads go now; give
  // focus back to whatever opened it afterwards.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog && !dialog.open) dialog.showModal();
    pathBoxRef.current?.focus();
    return () => {
      request.current?.abort();
      opener?.focus();
    };
  }, []);

  useEffect(() => {
    void browse(); // once, on open
  }, []);

  useEffect(() => {
    if (!listing || !focusListNext.current) return;
    focusListNext.current = false;
    const first = listRef.current?.querySelector("button");
    (first ?? dialogRef.current?.querySelector<HTMLElement>("[data-up-button]"))?.focus();
  }, [listing]);

  const close = () => dialogRef.current?.close(); // → onClose, via the "close" event

  const choose = async () => {
    if (!listing) return;
    setBusy(true);
    setError(null);
    try {
      await onChoose(listing.path);
      close();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const makeFolder = async () => {
    if (!listing || newName === null || !newName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const made = await createFolder(listing.path, newName);
      await browse(made.path);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const here = listing ? folderName(listing.path) : "";

  // Rendered straight into <body>, so the page's layout styles (spacing,
  // centered text) can't reach it.
  return createPortal(
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(event) => {
        // Escape while naming a new folder only stops naming it.
        if (newName !== null) {
          event.preventDefault();
          setNewName(null);
        }
      }}
      onPointerDown={(event) => {
        pressedOnBackdrop.current = event.target === dialogRef.current;
      }}
      onClick={(event) => {
        // A click on the dimmed backdrop (not one that began inside, e.g.
        // while selecting text) closes it.
        if (event.target === dialogRef.current && pressedOnBackdrop.current) close();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-xl border-0 bg-transparent p-0 text-foreground backdrop:bg-black/50 backdrop:backdrop-blur-xs"
    >
      <div className="flex max-h-[85vh] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        {/* Title */}
        <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-4">
          <h2 id={titleId} className="font-display text-lg font-semibold">
            Choose where to save downloads
          </h2>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Quick links */}
        {listing && listing.places.length > 0 && (
          <div
            role="group"
            aria-label="Places"
            className="flex flex-wrap gap-2 border-b border-border px-5 py-3"
          >
            {listing.places.map((place) => {
              const Icon = PLACE_ICONS[place.name] ?? HardDrive;
              const current = place.path === listing.path;
              return (
                <button
                  key={place.path}
                  type="button"
                  onClick={() => void browse(place.path)}
                  title={place.path}
                  className={cn(
                    "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                    current
                      ? "border-primary/40 bg-primary/10 text-foreground"
                      : "border-border text-muted-foreground hover:bg-secondary hover:text-foreground",
                  )}
                >
                  <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                  {place.name}
                </button>
              );
            })}
          </div>
        )}

        {/* Where we are: go up, or type a path */}
        <div className="flex items-center gap-2 px-5 pt-3">
          <button
            type="button"
            data-up-button
            onClick={() => listing?.parent && void browse(listing.parent)}
            disabled={!listing?.parent}
            aria-label={listing?.parent ? `Up to ${folderName(listing.parent)}` : "Up"}
            title="Up one folder"
            className="shrink-0 rounded-lg border border-border p-2 text-foreground hover:bg-secondary transition-colors disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ArrowUp className="h-4 w-4" />
          </button>
          <form
            className="flex min-w-0 flex-1 items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (typedPath.trim()) void browse(typedPath.trim());
            }}
          >
            <input
              ref={pathBoxRef}
              type="text"
              aria-label="Folder path"
              spellCheck={false}
              autoComplete="off"
              value={typedPath}
              onChange={(event) => setTypedPath(event.target.value)}
              placeholder="Type or paste a folder path"
              className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 font-mono text-xs text-foreground focus:outline-hidden focus:ring-2 focus:ring-primary/25"
            />
            <button
              type="submit"
              className="h-9 shrink-0 rounded-lg border border-border px-3 text-xs font-medium text-foreground hover:bg-secondary transition-colors"
            >
              Go
            </button>
          </form>
        </div>

        {error && (
          <p
            role="alert"
            className="mx-5 mt-3 flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="min-w-0 wrap-break-word">{error}</span>
          </p>
        )}

        {/* The folders in here */}
        <div
          aria-busy={loading}
          className={cn(
            "mx-5 mt-3 min-h-48 flex-1 overflow-y-auto rounded-xl border border-border transition-opacity",
            loading && listing && "opacity-60",
          )}
        >
          {newName !== null && (
            <form
              className="flex items-center gap-2 border-b border-border bg-secondary/40 px-3 py-2"
              onSubmit={(event) => {
                event.preventDefault();
                void makeFolder();
              }}
            >
              <FolderPlus className="h-4 w-4 shrink-0 text-muted-foreground" />
              <input
                autoFocus
                type="text"
                aria-label="New folder name"
                value={newName}
                onFocus={(event) => event.target.select()}
                onChange={(event) => setNewName(event.target.value)}
                className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-primary/25"
              />
              <button
                type="submit"
                disabled={busy || !newName.trim()}
                className="h-8 shrink-0 rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground disabled:opacity-50"
              >
                Create
              </button>
              <button
                type="button"
                onClick={() => setNewName(null)}
                aria-label="Don't make a new folder"
                className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </form>
          )}

          {!listing ? (
            <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Opening…
                </>
              ) : (
                "Couldn't open a folder. Type a folder path above."
              )}
            </div>
          ) : listing.folders.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-muted-foreground">
              No folders in here. Save into “{here}”, or make a new folder.
            </p>
          ) : (
            <ul
              ref={listRef}
              aria-label={`Folders in ${here}`}
              className="divide-y divide-border/60"
            >
              {listing.folders.map((folder) => (
                <li key={folder.path}>
                  <button
                    type="button"
                    onClick={() => void browse(folder.path)}
                    className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-secondary/60 focus-visible:bg-secondary/60 focus-visible:outline-hidden transition-colors"
                  >
                    <Folder className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{folder.name}</span>
                    <ChevronRight
                      className="h-4 w-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2 px-5 py-4">
          <button
            type="button"
            onClick={() => setNewName((name) => name ?? "New folder")}
            disabled={!listing || busy}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
          >
            <FolderPlus className="h-4 w-4" />
            New folder
          </button>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={close}
              className="rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void choose()}
              disabled={!listing || busy || loading}
              title={listing?.path}
              className="inline-flex max-w-[16rem] items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover-elevate disabled:opacity-50"
            >
              {busy && newName === null && <Loader2 className="h-4 w-4 shrink-0 animate-spin" />}
              <span className="truncate">Use “{here || "…"}”</span>
            </button>
          </div>
        </div>
      </div>
    </dialog>,
    document.body,
  );
}
