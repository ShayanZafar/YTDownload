import { rmSync } from "fs";
import os from "os";
import path from "path";

/**
 * The browser tests' own copy of the app (the webServer in playwright.config.ts) keeps its
 * history, settings, source-health report, music player cache (songs a browser can't play,
 * as FLAC), bin (songs deleted from the folder, in place of the system's), trimmed songs' originals, the details log, the Not found marks, the Spotify sign-in and the note of saves in progress here, in the temp folder. They're named after this Playwright run's process id, so
 * runs going at the same time never share them, and each run deletes only its own.
 */
// The run's process id; its test workers (other processes) get it from the
// environment they inherit, so they name the same files.
const run = (process.env.YT_AUDIO_E2E_RUN ??= String(process.pid));

export const testServerFiles = {
  HISTORY_FILE: path.join(os.tmpdir(), `yt-audio-e2e-history-${run}.json`),
  SETTINGS_FILE: path.join(os.tmpdir(), `yt-audio-e2e-settings-${run}.json`),
  SOURCE_HEALTH_FILE: path.join(os.tmpdir(), `yt-audio-e2e-health-${run}.json`),
  PLAYER_CACHE_DIR: path.join(os.tmpdir(), `yt-audio-e2e-player-${run}`),
  TRASH_DIR: path.join(os.tmpdir(), `yt-audio-e2e-trash-${run}`),
  TRIM_BACKUP_DIR: path.join(os.tmpdir(), `yt-audio-e2e-backups-${run}`),
  DETAILS_LOG_FILE: path.join(os.tmpdir(), `yt-audio-e2e-details-${run}.log`),
  DETAILS_NOT_FOUND_FILE: path.join(os.tmpdir(), `yt-audio-e2e-notfound-${run}.json`),
  SPOTIFY_SIGN_IN_FILE: path.join(os.tmpdir(), `yt-audio-e2e-spotify-${run}.json`),
  UNFINISHED_SAVES_FILE: path.join(os.tmpdir(), `yt-audio-e2e-saves-${run}.json`),
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
