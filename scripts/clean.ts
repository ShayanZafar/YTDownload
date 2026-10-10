import { readdir, rm } from "fs/promises";
import os from "os";
import path from "path";
import { isPlaywrightProfile, isTestLeftover, isViteConfigCopy } from "./leftovers";

/**
 * `npm run clean` removes what test runs leave behind (`-- --dry-run` only lists it):
 *  - in the system's temp folder: the tests' own files and folders (isTestLeftover() in
 *    scripts/leftovers.ts; a test run also deletes those of runs stopped part-way as it starts,
 *    once they're certainly over),
 *    and the browser profiles of Playwright runs that were stopped before they could tidy up;
 *  - here: Playwright's test-results/ and playwright-report/, and the config files Vite
 *    leaves in node_modules/.vite-temp when the dev server is killed while starting.
 * Never your history and settings (data/), the build (dist/), the music player's cache
 * ("yt-audio-player" in the temp folder) or a Save to folder. Run it when no tests are running.
 */

const ROOT = path.resolve(import.meta.dirname, "..");

async function namesIn(folder: string): Promise<string[]> {
  try {
    return await readdir(folder);
  } catch {
    return []; // no such folder: nothing to clean there
  }
}

/** Every leftover, by the folder it's in. */
async function findLeftovers(): Promise<Map<string, string[]>> {
  const tmp = os.tmpdir();
  const viteTemp = path.join(ROOT, "node_modules", ".vite-temp");
  const here = new Set(await namesIn(ROOT));
  return new Map([
    [tmp, (await namesIn(tmp)).filter((n) => isTestLeftover(n) || isPlaywrightProfile(n))],
    [ROOT, ["test-results", "playwright-report"].filter((n) => here.has(n))],
    [viteTemp, (await namesIn(viteTemp)).filter(isViteConfigCopy)],
  ]);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  let removed = 0;
  let failed = 0;
  for (const [folder, names] of await findLeftovers()) {
    if (!names.length) continue;
    console.log(`${dryRun ? "Would remove" : "Removing"}, in ${folder}:`);
    for (const name of names.sort()) {
      if (dryRun) {
        console.log(`  ${name}`);
        removed++;
        continue;
      }
      try {
        await rm(path.join(folder, name), { recursive: true, force: true, maxRetries: 2 });
        console.log(`  ${name}`);
        removed++;
      } catch (err) {
        // On Windows a file a running test or browser still has open can't be deleted.
        console.warn(
          `  ${name}: couldn't remove it (${(err as NodeJS.ErrnoException).code ?? err}) — still in use?`,
        );
        failed++;
      }
    }
  }
  if (!removed && !failed) console.log("Nothing to clean.");
  else if (dryRun) console.log(`${removed} to remove. Run \`npm run clean\` to remove them.`);
  else console.log(`Removed ${removed}.${failed ? ` ${failed} couldn't be removed.` : ""}`);
  if (failed) process.exitCode = 1;
}

await main();
