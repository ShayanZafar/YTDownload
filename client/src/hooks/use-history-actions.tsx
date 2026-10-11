import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { api, buildUrl } from "@shared/routes";
import { downloadSchema, type Download } from "@shared/schema";
import { ToastAction } from "@/components/ui/toast";
import { useToast } from "@/hooks/use-toast";
import { requestJson } from "@/lib/save-to-folder";

const historyKey = [api.downloads.list.path];

/** Puts removed entries back in the history. */
function restoreDownloads(entries: Download[]) {
  return requestJson(z.array(downloadSchema), api.downloads.restore.path, {
    method: api.downloads.restore.method,
    json: { entries },
  });
}

/**
 * Taking songs out of Recent Extractions — one, or all of them — with Undo in
 * the note that says so. Only the history changes: downloaded files stay.
 * The list changes at once, and comes back if the app says no.
 */
export function useHistoryActions() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: historyKey }),
    [queryClient],
  );

  /** Offers Undo for what was just taken out. */
  const undoable = useCallback(
    (title: string, entries: Download[]) => {
      const undo = () => {
        restoreDownloads(entries)
          .catch((err: Error) =>
            toast({
              title: "Couldn't put it back",
              description: err.message,
              variant: "destructive",
            }),
          )
          .finally(refresh);
      };
      toast({
        title,
        description: "The downloaded files stay where they are.",
        action: (
          <ToastAction altText="Undo" onClick={undo}>
            Undo
          </ToastAction>
        ),
      });
    },
    [toast, refresh],
  );

  const remove = useCallback(
    async (entry: Download) => {
      await queryClient.cancelQueries({ queryKey: historyKey });
      queryClient.setQueryData<Download[]>(historyKey, (list) =>
        list?.filter((e) => e.id !== entry.id),
      );
      try {
        const removed = await requestJson(
          downloadSchema,
          buildUrl(api.downloads.remove.path, { id: entry.id }),
          { method: api.downloads.remove.method },
        );
        undoable(`Removed “${removed.title}” from the history`, [removed]);
      } catch (err) {
        toast({
          title: "Couldn't remove it",
          description: (err as Error).message,
          variant: "destructive",
        });
      } finally {
        void refresh();
      }
    },
    [queryClient, toast, undoable, refresh],
  );

  const clear = useCallback(async () => {
    await queryClient.cancelQueries({ queryKey: historyKey });
    queryClient.setQueryData<Download[]>(historyKey, []);
    try {
      const removed = await requestJson(z.array(downloadSchema), api.downloads.clear.path, {
        method: api.downloads.clear.method,
      });
      if (removed.length > 0) {
        undoable(
          `Cleared ${removed.length.toLocaleString()} ${removed.length === 1 ? "download" : "downloads"} from the history`,
          removed,
        );
      }
    } catch (err) {
      toast({
        title: "Couldn't clear the history",
        description: (err as Error).message,
        variant: "destructive",
      });
    } finally {
      void refresh();
    }
  }, [queryClient, toast, undoable, refresh]);

  return { remove, clear };
}
