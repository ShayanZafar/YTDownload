import { rmSync } from "fs";
import os from "os";
import path from "path";

/**
 * The browser tests' own copy of the app (the webServer in playwright.config.ts) keeps its
 * history, settings and music player cache (songs a browser can't play, as FLAC) here, in the
 * temp folder. They're named after this Playwright run's process id, so runs going at the same
 * time never share them, and each run deletes only its own.
 */
export const testServerFiles = {
  HISTORY_FILE: path.join(os.tmpdir(), `yt-audio-e2e-history-${process.pid}.json`),
  SETTINGS_FILE: path.join(os.tmpdir(), `yt-audio-e2e-settings-${process.pid}.json`),
  PLAYER_CACHE_DIR: path.join(os.tmpdir(), `yt-audio-e2e-player-${process.pid}`),
};

/**
 * The run's globalTeardown: deletes those files once the run is over. Playwright calls it
 * before it stops the webServer, which until then could write them again (and Windows may
 * refuse to delete a file it has open), so they go as this process exits — by then Playwright
 * has killed the server and waited for it.
 */
export default function deleteTestServerFiles() {
  process.once("exit", () => {
    for (const file of Object.values(testServerFiles)) {
      try {
        rmSync(file, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? err;
        console.warn(`Couldn't delete ${file} (${code}); \`npm run clean\` will.`);
      }
    }
  });
}
