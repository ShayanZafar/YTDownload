import { afterEach, describe, expect, it } from "vitest";
import { readdirSync, readFileSync, promises as fs } from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import {
  ABANDONED_AFTER_MS,
  isAbandoned,
  isPlaywrightProfile,
  isTestLeftover,
  isViteConfigCopy,
  removeAbandonedLeftovers,
} from "../../scripts/leftovers";

/**
 * scripts/clean.ts (`npm run clean`) removes what test runs leave in the temp folder. It finds
 * the tests' files by name, so every name a test gives a temp file must be one it recognises —
 * and never the app's own.
 */
const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
const tests = fileURLToPath(new URL("../../tests", import.meta.url));
const testFiles = readdirSync(tests, { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".ts"))
  .map((file) => readFileSync(path.join(tests, file), "utf8"));

// What the tests pass to fs.mkdtemp(), which adds six random characters.
const mkdtempPrefixes = testFiles.flatMap((text) =>
  [...text.matchAll(/mkdtemp\(\s*path\.join\(\s*os\.tmpdir\(\),\s*"([^"]+)"\s*\)/g)].map(
    (m) => m[1],
  ),
);
// The Playwright test server's files, named after the run's process id.
const playwrightNames = [
  ...read("../browser/test-server-files.ts").matchAll(/os\.tmpdir\(\),\s*`([^`]+)`/g),
].map((m) => m[1].replace("${process.pid}", "13128"));

describe("npm run clean", () => {
  it("finds the names the tests use", () => {
    expect(mkdtempPrefixes.length).toBeGreaterThan(10);
    expect(playwrightNames).toHaveLength(5);
  });

  it("recognises every temp folder a test makes", () => {
    for (const prefix of mkdtempPrefixes) {
      expect(isTestLeftover(`${prefix}aB3xQ9`), `"${prefix}" must start with "yt-audio-"`).toBe(
        true,
      );
      expect(isTestLeftover(`${prefix}000000`)).toBe(true);
    }
  });

  it("recognises the Playwright test server's history, settings, health report, player cache and trim backups", () => {
    expect(playwrightNames).toEqual([
      "yt-audio-e2e-history-13128.json",
      "yt-audio-e2e-settings-13128.json",
      "yt-audio-e2e-health-13128.json",
      "yt-audio-e2e-player-13128",
      "yt-audio-e2e-backups-13128",
    ]);
    for (const name of playwrightNames) expect(isTestLeftover(name)).toBe(true);
  });

  it("leaves the app's own files and anything else alone", () => {
    for (const name of [
      "yt-audio-player", // the music player's cache
      "yt-audio-player-cache",
      "yt-audio-",
      "yt-audio-test-", // a prefix without mkdtemp's characters
      "yt-audio-test-aB3x", // too short
      "yt-audio-test-aB3xQ9.tmp",
      "my-yt-audio-test-aB3xQ9",
      "history.json",
      "playwright-transform-cache",
    ]) {
      expect(isTestLeftover(name), name).toBe(false);
      expect(isPlaywrightProfile(name), name).toBe(false);
    }
  });

  it("recognises Playwright's leftover browser profiles", () => {
    expect(isPlaywrightProfile("playwright_chromiumdev_profile-gaQRCL")).toBe(true);
    expect(isPlaywrightProfile("playwright_firefoxdev_profile-FksisF")).toBe(true);
    expect(isPlaywrightProfile("playwright_chromiumdev_profile-")).toBe(false);
  });

  it("recognises the config copies Vite leaves behind", () => {
    expect(isViteConfigCopy("vite.config.ts.timestamp-1759590000000-2a9c1e5b0f3d4.mjs")).toBe(true);
    expect(isViteConfigCopy("vite.config.ts")).toBe(false);
    expect(isViteConfigCopy("deps")).toBe(false);
  });
});

describe("a test run, as it starts", () => {
  const now = Date.now();
  const dayOld = now - ABANDONED_AFTER_MS - 60_000;
  const running = (pid: number) => pid === 4242;

  it("deletes a Playwright run's test server files once that run is over", () => {
    for (const name of [
      "yt-audio-e2e-history-1000.json",
      "yt-audio-e2e-settings-1000.json",
      "yt-audio-e2e-player-1000",
      "yt-audio-e2e-player-123456", // also looks like an mkdtemp name: its run decides
    ]) {
      expect(isAbandoned(name, now, now, running), name).toBe(true);
    }
  });

  it("never touches a run still going, its own files, or the app's", () => {
    expect(isAbandoned("yt-audio-e2e-history-4242.json", dayOld, now, running)).toBe(false);
    expect(isAbandoned(`yt-audio-e2e-player-${process.pid}`, dayOld, now, () => false)).toBe(false);
    expect(isAbandoned("yt-audio-player", dayOld, now, running)).toBe(false);
    expect(isAbandoned("playwright_chromiumdev_profile-gaQRCL", dayOld, now, running)).toBe(false);
  });

  it("deletes the tests' temp folders only once they're a day old", () => {
    expect(isAbandoned("yt-audio-save-to-aB3xQ9", now - 60 * 60 * 1000, now, running)).toBe(false);
    expect(isAbandoned("yt-audio-save-to-aB3xQ9", dayOld, now, running)).toBe(true);
  });

  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("removes those from the temp folder, and leaves the rest", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-leftovers-"));
    const old = new Date(dayOld);
    const make = async (name: string, modified?: Date) => {
      await fs.mkdir(path.join(dir!, name));
      await fs.writeFile(path.join(dir!, name, "file.mp3"), "");
      if (modified) await fs.utimes(path.join(dir!, name), modified, modified);
    };
    await make("yt-audio-save-to-Old123", old);
    await make("yt-audio-save-to-New123");
    await make("yt-audio-e2e-player-999999999"); // no such process
    await make(`yt-audio-e2e-player-${process.pid}`);
    await make("yt-audio-player", old);
    await make("Music", old);

    expect((await removeAbandonedLeftovers(dir)).sort()).toEqual([
      "yt-audio-e2e-player-999999999",
      "yt-audio-save-to-Old123",
    ]);
    expect((await fs.readdir(dir)).sort()).toEqual([
      "Music",
      `yt-audio-e2e-player-${process.pid}`,
      "yt-audio-player",
      "yt-audio-save-to-New123",
    ]);
  });
});
