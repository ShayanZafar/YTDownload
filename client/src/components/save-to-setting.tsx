import { FolderDown, FolderOpen, X } from "lucide-react";
import type { SaveSettings } from "@shared/schema";
import { folderName } from "@/lib/save-to-folder";

type SaveToSettingProps = {
  /** The setting, or undefined while it loads. */
  settings?: SaveSettings;
  onChoose: () => void;
  onClear: () => void;
};

/**
 * Where downloads go. It sits right under the search box, always visible, so
 * it can be set before opening a video — it applies to Download and to every
 * Redownload. Another device (a phone using the app over Wi-Fi) can't save
 * into a folder on this computer, so it gets a short note instead.
 */
export function SaveToSetting({ settings, onChoose, onClear }: SaveToSettingProps) {
  if (settings && !settings.canSaveToFolder) {
    return (
      <p className="mx-auto flex max-w-lg items-start gap-2 text-left text-sm text-muted-foreground">
        <FolderDown className="w-4 h-4 mt-0.5 shrink-0" />
        <span>
          Downloads go to this device's downloads folder. Saving into a folder you choose works in a
          browser on the computer running the app.
        </span>
      </p>
    );
  }

  const folder = settings?.saveFolder ?? null;
  return (
    <div
      role="group"
      aria-label="Where downloads are saved"
      className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-sm text-muted-foreground"
    >
      <span className="inline-flex items-center gap-1.5">
        {folder ? (
          <FolderOpen className="w-4 h-4 shrink-0" />
        ) : (
          <FolderDown className="w-4 h-4 shrink-0" />
        )}
        Save to
      </span>
      {folder ? (
        <span
          className="max-w-[16rem] truncate font-medium text-foreground"
          data-testid="save-folder-name"
          title={folder}
        >
          {folderName(folder)}
        </span>
      ) : (
        <span>your browser's downloads folder</span>
      )}
      <button
        type="button"
        onClick={onChoose}
        className="rounded-lg border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground hover:bg-secondary transition-colors"
      >
        {folder ? "Change" : "Choose folder"}
      </button>
      {folder && (
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
