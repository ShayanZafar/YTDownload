import { useEffect, useState } from "react";
import {
  canPickFolder,
  loadRememberedFolder,
  pickFolder,
  rememberFolder,
  type SaveFolder,
} from "@/lib/save-folder";

/**
 * The "Save to" setting: a folder picked in this browser, remembered between
 * visits. `folder` is undefined when downloads go to the browser's own
 * downloads folder — always the case in browsers that can't pick one.
 */
export function useSaveFolder() {
  const [supported] = useState(canPickFolder);
  const [folder, setFolder] = useState<SaveFolder | undefined>();

  useEffect(() => {
    if (!supported) return;
    let live = true;
    loadRememberedFolder().then((saved) => {
      if (live && saved) setFolder(saved);
    });
    return () => {
      live = false;
    };
  }, [supported]);

  /** Opens the folder picker; resolves to the folder, or undefined if closed. */
  const choose = async () => {
    const picked = await pickFolder();
    if (picked) {
      setFolder(picked);
      await rememberFolder(picked);
    }
    return picked;
  };

  /** Back to the browser's downloads folder. */
  const clear = () => {
    setFolder(undefined);
    void rememberFolder(undefined);
  };

  return { supported, folder, choose, clear };
}
