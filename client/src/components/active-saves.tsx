import { Loader2, X } from "lucide-react";
import { formatBytes } from "@/lib/format";
import { folderName, type ActiveSave } from "@/lib/save-to-folder";

type ActiveSavesProps = {
  /** The saves into the folder running now, by download link. */
  saves: Record<string, ActiveSave>;
  /** The one the preview card shows already (its download link), left out here. */
  shownHref?: string;
};

/**
 * The songs still being saved into the folder that the preview card doesn't
 * show: picking or searching for another song never stops a save, so it goes
 * on here, with its progress and a Cancel button — the only thing that stops it.
 */
export function ActiveSaves({ saves, shownHref }: ActiveSavesProps) {
  const running = Object.entries(saves).filter(([href]) => href !== shownHref);
  if (running.length === 0) return null;
  return (
    <section aria-label="Still downloading" className="max-w-3xl mx-auto w-full">
      <ul className="rounded-2xl border border-border bg-card divide-y divide-border/60 overflow-hidden">
        {running.map(([href, save]) => (
          <li key={href} className="flex items-center gap-3 px-4 py-2.5 text-left">
            <Loader2 className="w-4 h-4 shrink-0 animate-spin text-primary" />
            <p role="status" className="flex-1 min-w-0 text-sm">
              <span className="block truncate font-medium text-foreground">{save.title}</span>
              <span className="block truncate text-xs text-muted-foreground">
                Saving to {folderName(save.folder)} ·{" "}
                <span className="tabular-nums">
                  {save.bytes > 0 ? formatBytes(save.bytes) : "starting…"}
                </span>
              </span>
            </p>
            <button
              type="button"
              onClick={save.cancel}
              aria-label={`Cancel saving ${save.title}`}
              className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-secondary transition-colors"
            >
              <X className="w-3.5 h-3.5" />
              Cancel
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
