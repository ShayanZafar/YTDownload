/**
 * Stopping the app cleanly (Ctrl+C, closing its window, Stop on macOS and
 * Linux): what's under way is told to stop and tidy up before the process
 * exits — saves in progress stop yt-dlp and ffmpeg and delete their .part
 * files, downloads stop theirs, and the songs' tags read since the last look
 * are written to data/song-tags.json. A second signal, or tidying that takes
 * longer than SHUTDOWN_GRACE_MS, exits at once.
 *
 * Windows' Stop.cmd ends the app with `taskkill /F`, which no program can
 * notice; what that leaves (a .part file, an unfinished tag write) is found
 * at the next start instead (Housekeeping, `restoreUnfinishedTagWrites()`).
 */

/** The longest the app waits for its work to tidy up before it exits anyway. */
export const SHUTDOWN_GRACE_MS = 5_000;

type Tidy = () => unknown;
const tidies = new Set<Tidy>();

/** Runs `tidy` if the app stops before the function this returns is called. */
export function onShutdown(tidy: Tidy): () => void {
  tidies.add(tidy);
  return () => tidies.delete(tidy);
}

/** Runs every tidy-up at once; settles when all have, or after `graceMs`. Never rejects. */
export async function runShutdown(graceMs = SHUTDOWN_GRACE_MS): Promise<void> {
  const running = [...tidies].map((tidy) =>
    Promise.resolve()
      .then(tidy)
      .catch((err) => console.error("Couldn't tidy up while stopping:", err)),
  );
  tidies.clear();
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.all(running),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, graceMs);
    }),
  ]);
  clearTimeout(timer);
}

/**
 * The signals that mean "stop": Ctrl+C (SIGINT), Stop on macOS and Linux
 * (SIGTERM), the window closing (SIGHUP; on Windows too), Ctrl+Break (SIGBREAK).
 */
export const STOP_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"];

/** Tidies up, then exits, on any of the stop signals. */
export function stopCleanlyOnSignals(exit: (code: number) => void = process.exit): void {
  let stopping = false;
  for (const signal of STOP_SIGNALS) {
    process.on(signal, () => {
      if (stopping) return exit(1); // asked twice: don't wait
      stopping = true;
      console.log(`Stopping (${signal}): tidying up first…`);
      void runShutdown().then(() => exit(0));
    });
  }
}
