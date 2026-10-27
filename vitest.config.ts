import { defineConfig } from "vitest/config";
import os from "os";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@": path.resolve(import.meta.dirname, "client/src"),
    },
  },
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/api/**/*.test.ts"],
    globals: true,
    environment: "node",
    // The app keeps the songs' tags it read in data/song-tags.json; the tests keep
    // them nowhere, but for the test of that copy (tests/unit/song-tags.test.ts).
    // Nor do they read the owner's settings (data/settings.json): a bot check in a
    // test must never be answered with the owner's Firefox sign-in.
    env: {
      SONG_TAGS_FILE: "",
      SETTINGS_FILE: path.join(os.tmpdir(), "yt-audio-tests-no-settings.json"),
    },
    // Deletes what earlier runs that were stopped part-way left in the temp folder.
    globalSetup: "./scripts/leftovers.ts",
    testTimeout: 90_000,
    hookTimeout: 30_000,
    reporters: ["verbose"],
  },
});
