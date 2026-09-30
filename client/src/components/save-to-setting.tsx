import { FolderDown, FolderOpen, X } from "lucide-react";

type SaveToSettingProps = {
  /** Can this browser save into a picked folder? (Chrome/Edge on a computer.) */
  supported: boolean;
  /** The chosen folder's name, or undefined for the browser's downloads folder. */
  folderName?: string;
  onChoose: () => void;
  onClear: () => void;
};

/**
 * Where downloads go. It sits right under the search box, always visible, so
 * it can be set before opening a video — it applies to Download and to every
 * Redownload. Browsers that can't save into a folder get a short explanation
 * instead of a setting that silently isn't there.
 */
export function SaveToSetting({ supported, folderName, onChoose, onClear }: SaveToSettingProps) {
  if (!supported) {
    return (
      <p className="mx-auto flex max-w-lg items-start gap-2 text-left text-sm text-muted-foreground">
        <FolderDown className="w-4 h-4 mt-0.5 shrink-0" />
        <span>
          Downloads go to this browser's downloads folder. To save into a folder you choose, open
          this page in Chrome or Edge on a computer.
        </span>
      </p>
    );
  }

  return (
    <div
      role="group"
      aria-label="Where downloads are saved"
      className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-sm text-muted-foreground"
    >
      <span className="inline-flex items-center gap-1.5">
        {folderName ? (
          <FolderOpen className="w-4 h-4 shrink-0" />
        ) : (
          <FolderDown className="w-4 h-4 shrink-0" />
        )}
        Save to
      </span>
      {folderName ? (
        <span
          className="max-w-[16rem] truncate font-medium text-foreground"
          data-testid="save-folder-name"
          title={folderName}
        >
          {folderName}
        </span>
      ) : (
        <span>your browser's downloads folder</span>
      )}
      <button
        type="button"
        onClick={onChoose}
        className="rounded-lg border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground hover:bg-secondary transition-colors"
      >
        {folderName ? "Change" : "Choose folder"}
      </button>
      {folderName && (
        <button
          type="button"
          onClick={onClear}
          aria-label="Use the browser's downloads folder instead"
          title="Use the browser's downloads folder instead"
          className="rounded-lg p-1 hover:bg-secondary hover:text-foreground transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}
