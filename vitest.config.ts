import { defineConfig } from "vitest/config";
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
    // Deletes what earlier runs that were stopped part-way left in the temp folder.
    globalSetup: "./scripts/leftovers.ts",
    testTimeout: 90_000,
    hookTimeout: 30_000,
    reporters: ["verbose"],
  },
});
