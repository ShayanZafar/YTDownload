import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import { createServer } from "http";
import request from "supertest";
import { existsSync, mkdirSync, rmdirSync, rmSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { isFileLoadingAllowed, normalizePath, type ViteDevServer } from "vite";
import { setupVite } from "../../server/vite";

/**
 * The development server (npm run dev) sends files by their path on disk —
 * /@fs/<path> — to anyone who can reach the app: with HOST=0.0.0.0, every
 * device on the network. It must send what the page loads (client/, shared/,
 * Vite's pre-bundled packages) and nothing else: not data/ (the history and
 * settings), dotfiles or the rest of the project. vite.config.ts has the
 * rules; server/vite.ts must apply them.
 */
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
/** A project file's absolute path, the way Vite writes it ("C:/…" on Windows). */
const file = (name: string) => normalizePath(path.join(ROOT, name));
/** Where the dev server would send a project file. */
const fsUrl = (name: string) => encodeURI(`/@fs/${file(name).replace(/^\//, "")}`);

// A file in data/, where the app keeps the history and settings: this test's
// own, so the real ones are never touched.
const DATA_FOLDER = path.join(ROOT, "data");
const DATA_FILE = `data/dev-server-test-${process.pid}.json`;
const madeDataFolder = !existsSync(DATA_FOLDER);

let app: express.Express;
let vite: ViteDevServer;

beforeAll(async () => {
  // As in npm run dev: Vite keys its cache of pre-bundled packages
  // (node_modules/.vite) on NODE_ENV, and Vitest's "test" would rebuild it.
  vi.stubEnv("NODE_ENV", "development");
  mkdirSync(DATA_FOLDER, { recursive: true });
  writeFileSync(path.join(ROOT, DATA_FILE), "[]");

  app = express();
  vite = await setupVite(createServer(app), app);
}, 60_000);

afterAll(async () => {
  await vite?.close();
  vi.unstubAllEnvs();
  rmSync(path.join(ROOT, DATA_FILE), { force: true });
  if (madeDataFolder) {
    try {
      rmdirSync(DATA_FOLDER);
    } catch {
      // Not empty: the app saved something there meanwhile.
    }
  }
});

describe("the development server", () => {
  it("sends the page, its code, shared/ and the pre-bundled packages", async () => {
    const page = await request(app).get("/");
    expect(page.status).toBe(200);
    expect(page.text).toContain("/src/main.tsx");

    // main.tsx imports React from Vite's pre-bundled packages (node_modules/.vite/deps),
    // and Vite's code for the page (/@vite/client) imports the rest from node_modules/vite.
    const main = await request(app).get("/src/main.tsx");
    expect(main.status).toBe(200);
    const preBundled = main.text.match(/"(\/@fs\/[^"]+\/node_modules\/\.vite\/deps\/[^"]+)"/);
    expect(preBundled).not.toBeNull();
    const viteClient = await request(app).get("/@vite/client");
    expect(viteClient.status).toBe(200);
    const viteClientImport = viteClient.text.match(/"(\/@fs\/[^"]+\/node_modules\/vite\/[^"]+)"/);
    expect(viteClientImport).not.toBeNull();

    for (const url of [preBundled![1], viteClientImport![1], fsUrl("shared/routes.ts")]) {
      const res = await request(app).get(url);
      expect(res.status, url).toBe(200);
      expect(res.headers["content-type"], url).toMatch(/javascript/);
    }
  });

  describe("refuses", () => {
    // Vite logs every file it refuses; here that's expected.
    beforeEach(() => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it.each([
      { what: "a dotfile", name: ".prettierrc" },
      { what: "a dotfile among the packages", name: "node_modules/.package-lock.json" },
      { what: "data/ (the history and settings)", name: DATA_FILE },
      { what: "the project's other files", name: "package.json" },
      { what: "the server's code", name: "server/routes.ts" },
    ])("$what", async ({ name }) => {
      // As a file, and as the modules Vite would make of it.
      for (const query of ["", "?import", "?raw", "?url"]) {
        const res = await request(app).get(fsUrl(name) + query);
        expect(res.status, name + query).toBe(403);
      }
    });
  });

  it("keeps the history, the settings and other private files to itself", () => {
    // Whether or not they exist (a file that doesn't gets the page instead).
    const allowed = (name: string) => isFileLoadingAllowed(vite.config, file(name));
    for (const name of [
      "data/history.json",
      "data/settings.json",
      ".env",
      ".git/config",
      ".claude/settings.local.json",
      // Vite's own rules, even in the folders the page loads from.
      "client/.env",
      "client/.env.local",
      "client/.npmrc",
      "client/src/key.pem",
      "node_modules/some-package/.git/config",
    ]) {
      expect(allowed(name), name).toBe(false);
    }
    for (const name of [
      "client/src/main.tsx",
      "shared/schema.ts",
      "node_modules/.vite/deps/react.js",
    ]) {
      expect(allowed(name), name).toBe(true);
    }
  });
});
