import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "@shared/routes";
import type { QualityBar, SaveSettings } from "@shared/schema";
import { saveQualityBar } from "@/lib/housekeeping";
import { queryClient } from "@/lib/queryClient";
import { fetchSaveSettings, updateSaveFolder } from "@/lib/save-to-folder";

const SETTINGS_KEY = [api.settings.get.path];

/**
 * The "Save to" setting, kept by the app (so every browser on this computer
 * shares it). `folder` is null when downloads go to the browser's own
 * downloads folder — always the case on another device, which can't save into
 * a folder on this computer (`canSaveToFolder` is false there).
 */
export function useSaveSettings() {
  const { data } = useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: fetchSaveSettings,
    // Another tab may have changed it.
    refetchOnWindowFocus: true,
  });
  const { mutateAsync } = useMutation({
    mutationFn: updateSaveFolder,
    onSuccess: (settings) => queryClient.setQueryData<SaveSettings>(SETTINGS_KEY, settings),
  });

  const { mutate: setQualityBar } = useMutation({
    mutationFn: saveQualityBar,
    // Shown at once; the answer confirms it.
    onMutate: (qualityBar: QualityBar) =>
      queryClient.setQueryData<SaveSettings>(
        SETTINGS_KEY,
        (settings) => settings && { ...settings, qualityBar },
      ),
    onSuccess: (settings) => queryClient.setQueryData<SaveSettings>(SETTINGS_KEY, settings),
  });

  return {
    /** Undefined until the setting has loaded. */
    settings: data,
    folder: data?.canSaveToFolder ? data.saveFolder : null,
    /** Saves into this folder from now on (null: the browser's downloads). Rejects if it can't be used. */
    setFolder: mutateAsync,
    /** Saves Housekeeping's quality bar. */
    setQualityBar,
    /** Reloads the setting, e.g. after a save found the folder gone. */
    refresh: () => queryClient.invalidateQueries({ queryKey: SETTINGS_KEY }),
  };
}
