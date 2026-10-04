import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { isPlaywrightProfile, isTestLeftover, isViteConfigCopy } from "../../scripts/clean";

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
// The test server's files, named after the Playwright run's process id.
const playwrightNames = [
  ...read("../../playwright.config.ts").matchAll(/os\.tmpdir\(\),\s*`([^`]+)`/g),
].map((m) => m[1].replace("${process.pid}", "13128"));

describe("npm run clean", () => {
  it("finds the names the tests use", () => {
    expect(mkdtempPrefixes.length).toBeGreaterThan(10);
    expect(playwrightNames).toHaveLength(3);
  });

  it("recognises every temp folder a test makes", () => {
    for (const prefix of mkdtempPrefixes) {
      expect(isTestLeftover(`${prefix}aB3xQ9`), `"${prefix}" must start with "yt-audio-"`).toBe(
        true,
      );
      expect(isTestLeftover(`${prefix}000000`)).toBe(true);
    }
  });

  it("recognises the Playwright test server's history, settings and player cache", () => {
    expect(playwrightNames).toEqual([
      "yt-audio-e2e-history-13128.json",
      "yt-audio-e2e-settings-13128.json",
      "yt-audio-e2e-player-13128",
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
