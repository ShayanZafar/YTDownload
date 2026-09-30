import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Pencil } from "lucide-react";
import { safeFileName } from "@shared/filename";

type RenameableTitleProps = {
  /** The video's own title, shown until you rename the file. */
  title: string;
  /** The new file name, or null to use the title. */
  fileName: string | null;
  /** Shown after the name while renaming, e.g. ".mp3". */
  extension: string;
  extensionHint?: string;
  /** Called with the new name, or null to go back to the title. */
  onRename: (fileName: string | null) => void;
};

/**
 * The preview card's title, which is also the downloaded file's name. It shows
 * the video's title with a dashed underline and a pencil; click it to rename
 * the file right there, as a browser's "Save as" dialog would let you. Enter
 * (or clicking away) keeps the new name, Escape cancels.
 */
export function RenameableTitle({
  title,
  fileName,
  extension,
  extensionHint,
  onRename,
}: RenameableTitleProps) {
  const [editing, setEditing] = useState(false);
  // Also kept in a ref: Enter or Escape ends editing, and a blur that follows
  // in the same moment must not act on the stale "still editing" state.
  const editingRef = useRef(false);
  const [draft, setDraft] = useState("");
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const hintId = useId();
  const defaultName = safeFileName(title);
  const shown = fileName ?? title;

  const start = () => {
    setDraft(fileName ?? defaultName);
    editingRef.current = true;
    setEditing(true);
  };

  const finish = (keep: boolean) => {
    if (!editingRef.current) return;
    editingRef.current = false;
    returnFocus.current = boxRef.current === document.activeElement;
    setEditing(false);
    if (!keep) return;
    const cleaned = safeFileName(draft, "");
    onRename(!cleaned || cleaned === defaultName ? null : cleaned);
  };

  // Select the whole name when editing starts, like a Save As dialog does;
  // after Enter or Escape, put the keyboard focus back on the title.
  useEffect(() => {
    if (editing) {
      boxRef.current?.focus();
      boxRef.current?.select();
    } else if (returnFocus.current) {
      returnFocus.current = false;
      buttonRef.current?.focus();
    }
  }, [editing]);

  // Grow the box to fit the name, so a long title can be seen in full.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    box.style.height = "auto";
    box.style.height = `${box.scrollHeight}px`;
  }, [editing, draft]);

  if (editing) {
    const willSaveAs = safeFileName(draft, "");
    const adjusted = willSaveAs !== "" && willSaveAs !== draft.trim();
    return (
      <div className="w-full text-left">
        <div className="flex items-end gap-1 rounded-xl bg-card px-2 py-1 ring-2 ring-primary/25">
          <textarea
            ref={boxRef}
            rows={1}
            aria-label="File name"
            aria-describedby={hintId}
            spellCheck={false}
            value={draft}
            onChange={(event) => setDraft(event.target.value.replace(/[\r\n]+/g, " "))}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return; // Enter that confirms Japanese/Chinese input
              if (event.key === "Enter") {
                event.preventDefault();
                finish(true);
              } else if (event.key === "Escape") {
                event.preventDefault();
                finish(false);
              }
            }}
            onBlur={() => finish(true)}
            className="min-w-0 flex-1 resize-none overflow-hidden bg-transparent font-display text-xl font-bold leading-snug text-foreground focus:outline-none md:text-2xl"
          />
          <span
            className="shrink-0 pb-1 text-base font-medium text-muted-foreground"
            title={extensionHint}
          >
            {extension}
          </span>
        </div>
        <p id={hintId} className="mt-1 text-xs text-muted-foreground">
          {adjusted ? `Will be saved as “${willSaveAs}${extension}” · ` : ""}
          Enter to keep · Esc to cancel
        </p>
      </div>
    );
  }

  return (
    <div className="w-full md:w-auto">
      <h3 className="font-display text-xl font-bold text-foreground md:text-2xl">
        <button
          ref={buttonRef}
          type="button"
          onClick={start}
          aria-label={`Rename file: ${shown}`}
          title="Click to rename the downloaded file"
          className="group -mx-1.5 rounded-lg px-1.5 text-center transition-colors hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25 md:text-left"
        >
          <span className="line-clamp-3 underline decoration-muted-foreground/40 decoration-dashed decoration-2 underline-offset-[6px] group-hover:decoration-foreground/60">
            {shown}
          </span>
          <span className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-muted-foreground group-hover:text-foreground">
            <Pencil className="h-3 w-3" aria-hidden="true" />
            Rename file
          </span>
        </button>
      </h3>
      {fileName !== null && (
        <p className="mt-1 text-xs text-muted-foreground">
          Renamed from “{title}” ·{" "}
          <button
            type="button"
            onClick={() => onRename(null)}
            className="font-medium text-foreground underline underline-offset-2"
          >
            Use the original title
          </button>
        </p>
      )}
    </div>
  );
}
