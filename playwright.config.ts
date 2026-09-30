import { defineConfig, devices } from "@playwright/test";
import os from "os";
import path from "path";

// The browser tests start their own copy of the app on a separate port with a
// throwaway history and settings, so they never touch the app you actually
// use (which may be running on port 5000 at the same time).
// Set E2E_BASE_URL to run them against an already-running server instead.
const PORT = process.env.E2E_PORT ?? "5099";
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;
const HISTORY_FILE = path.join(os.tmpdir(), `yt-audio-e2e-history-${process.pid}.json`);
const SETTINGS_FILE = path.join(os.tmpdir(), `yt-audio-e2e-settings-${process.pid}.json`);

// Which browser engines to test in: your installed Chrome (Blink) and WebKit
// (the engine behind Safari) unless E2E_BROWSERS says otherwise. Firefox
// (Gecko) is opt-in — E2E_BROWSERS=chrome,webkit,firefox — because on some
// Windows 10 PCs Playwright's Firefox build, like its Chromium, won't start
// ("side-by-side configuration is incorrect").
const BROWSERS = (process.env.E2E_BROWSERS ?? "chrome,webkit").split(",").map((b) => b.trim());

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: 1,
  workers: 1,
  reporter: "list",

  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    actionTimeout: 30_000,
    navigationTimeout: 30_000,
  },

  // Every test runs in each browser engine listed in E2E_BROWSERS (see above).
  projects: [
    {
      // Your installed Google Chrome (in headless mode) — the browser the app
      // is used in. No Chrome? `npx playwright install chrome`.
      name: "chrome",
      use: { ...devices["Desktop Chrome"], channel: "chrome" },
    },
    {
      // Playwright's own builds: `npx playwright install webkit firefox`.
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
    },
  ].filter((project) => BROWSERS.includes(project.name)),

  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "npm run dev",
        url: BASE_URL,
        reuseExistingServer: false,
        timeout: 60_000,
        env: { PORT, HISTORY_FILE, SETTINGS_FILE },
        stdout: "pipe",
        stderr: "pipe",
      },
});
