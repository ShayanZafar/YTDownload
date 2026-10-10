import { readdir, rm, stat } from "fs/promises";
import os from "os";
import path from "path";

/**
 * What test runs leave in the system's temp folder, by name. `npm run clean` (scripts/clean.ts)
 * removes all of it; each test run removes, as it starts, what earlier runs that were stopped
 * part-way left behind (removeAbandonedLeftovers()).
 */

/**
 * A name the tests give their temp files: "yt-audio-<what>-" and fs.mkdtemp()'s six random
 * characters, or the id of the Playwright run (tests/browser/test-server-files.ts names the
 * test server's history, settings and player cache that way, and deletes them when the run
 * ends — unless it's stopped first). The app's own "yt-audio-player" has neither.
 */
export function isTestLeftover(name: string): boolean {
  return runOf(name) !== undefined || /^yt-audio-[a-z0-9-]+-[A-Za-z0-9]{6}$/.test(name);
}

/** The process id of the Playwright run a test server file belongs to, if it is one. */
export function runOf(name: string): number | undefined {
  const match = /^yt-audio-e2e-[a-z]+-(\d+)(\.json)?$/.exec(name);
  return match ? Number(match[1]) : undefined;
}

/** The browser profile Playwright makes for each run; it's deleted when the browser closes. */
export function isPlaywrightProfile(name: string): boolean {
  return /^playwright_[a-z]+dev_profile-[A-Za-z0-9]{6}$/.test(name);
}

/** Vite's bundled copy of vite.config.ts, deleted once the config is loaded. */
export function isViteConfigCopy(name: string): boolean {
  return /^vite\.config\.ts\.timestamp-.+\.mjs$/.test(name);
}

/** No test runs this long, so a test's temp folder older than this was left by a stopped run. */
export const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 sends nothing: it only asks whether the process exists
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"; // exists, but isn't ours
  }
}

/**
 * Whether a test leftover was certainly left by a run that's over: a Playwright run's test
 * server files once that run's process is gone, anything else once it's a day old. A run going
 * at the same time is never touched.
 */
export function isAbandoned(
  name: string,
  modifiedMs: number,
  now = Date.now(),
  running: (pid: number) => boolean = isRunning,
): boolean {
  const run = runOf(name);
  if (run !== undefined) return run !== process.pid && !running(run);
  return isTestLeftover(name) && now - modifiedMs > ABANDONED_AFTER_MS;
}

/**
 * Deletes what earlier test runs that were stopped part-way left in the temp folder (see
 * isAbandoned()); each vitest and Playwright run does as it starts (globalSetup below). Quiet, and never fails the run:
 * what it can't delete (Windows refuses files still open) `npm run clean` will.
 */
export async function removeAbandonedLeftovers(tmp = os.tmpdir()): Promise<string[]> {
  const removed: string[] = [];
  let names: string[];
  try {
    names = (await readdir(tmp)).filter(isTestLeftover);
  } catch {
    return removed;
  }
  for (const name of names) {
    const file = path.join(tmp, name);
    try {
      if (!isAbandoned(name, (await stat(file)).mtimeMs)) continue;
      await rm(file, { recursive: true, force: true, maxRetries: 2 });
      removed.push(name);
    } catch {
      // gone already, or still in use
    }
  }
  return removed;
}

/** vitest's and Playwright's globalSetup (both pass arguments it has no use for). */
export default async function globalSetup() {
  await removeAbandonedLeftovers();
}
