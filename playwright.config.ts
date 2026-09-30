import { defineConfig, devices } from "@playwright/test";
import os from "os";
import path from "path";

// The browser tests start their own copy of the app on a separate port with a
// throwaway history file, so they never add entries to the app you actually
// use (which may be running on port 5000 at the same time).
// Set E2E_BASE_URL to run them against an already-running server instead.
const PORT = process.env.E2E_PORT ?? "5099";
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;
const HISTORY_FILE = path.join(os.tmpdir(), `yt-audio-e2e-history-${process.pid}.json`);

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

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "npm run dev",
        url: BASE_URL,
        reuseExistingServer: false,
        timeout: 60_000,
        env: { PORT, HISTORY_FILE },
        stdout: "pipe",
        stderr: "pipe",
      },
});
