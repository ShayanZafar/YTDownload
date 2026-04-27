import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "shared"),
      "@": path.resolve(__dirname, "client/src"),
    },
  },
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/api/**/*.test.ts"],
    globals: true,
    environment: "node",
    testTimeout: 90_000,
    hookTimeout: 30_000,
    reporters: ["verbose"],
  },
});
