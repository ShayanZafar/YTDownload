import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { BUILD_SOURCES, BUILT_FILE, needsBuild } from "../../scripts/needs-build.mjs";

/**
 * scripts/needs-build.mjs, which the start scripts ask before running a copy of the source
 * code's build: build again when there's none, or the code changed since it was made.
 */
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const BUILT_AT = new Date("2026-10-26T12:00:00Z");
const BEFORE = new Date("2026-10-26T11:00:00Z");
const AFTER = new Date("2026-10-26T13:00:00Z");

let dir: string;
let made: string[] = [];

/** Writes `file` in the copy, last changed at `when`. */
async function put(file: string, when: Date) {
  const at = path.join(dir, file);
  await fs.mkdir(path.dirname(at), { recursive: true });
  await fs.writeFile(at, "x");
  await fs.utimes(at, when, when);
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-needs-build-"));
  made.push(dir);
  // A copy of the source, built after its code last changed.
  await put("client/src/main.tsx", BEFORE);
  await put("server/index.ts", BEFORE);
  await put("shared/schema.ts", BEFORE);
  await put("package-lock.json", BEFORE);
  await put(BUILT_FILE, BUILT_AT);
});

afterAll(async () => {
  for (const d of made) await fs.rm(d, { recursive: true, force: true });
  made = [];
});

describe("needsBuild", () => {
  it("is false when the build is newer than all the code", async () => {
    expect(await needsBuild(dir)).toBe(false);
  });

  it("is true when there's no build yet", async () => {
    await fs.rm(path.join(dir, BUILT_FILE));
    expect(await needsBuild(dir)).toBe(true);
  });

  it.each([
    "client/src/components/deep/inside/panel.tsx",
    "server/library.ts",
    "shared/routes.ts",
    "client/index.html",
    ...BUILD_SOURCES.files,
  ])("is true when %s changed after the build", async (file) => {
    await put(file, AFTER);
    expect(await needsBuild(dir)).toBe(true);
  });

  it("isn't fooled by files the build isn't made from", async () => {
    await put("data/history.json", AFTER);
    await put("tests/unit/some.test.ts", AFTER);
    await put("README.md", AFTER);
    await put("client/node_modules/.vite/deps/chunk.js", AFTER);
    expect(await needsBuild(dir)).toBe(false);
  });

  it("covers every config file this repository builds with", async () => {
    for (const file of BUILD_SOURCES.files) {
      await expect(fs.stat(path.join(ROOT, file)), file).resolves.toBeTruthy();
    }
    for (const folder of BUILD_SOURCES.folders) {
      expect((await fs.stat(path.join(ROOT, folder))).isDirectory()).toBe(true);
    }
  });
});

describe("node scripts/needs-build.mjs", () => {
  it("answers with its exit code: 0 to build, 1 when the build is up to date", async () => {
    // A copy of the script in the test copy, so it judges that copy (it looks at its own folder's parent).
    await fs.mkdir(path.join(dir, "scripts"), { recursive: true });
    await fs.copyFile(
      path.join(ROOT, "scripts", "needs-build.mjs"),
      path.join(dir, "scripts", "needs-build.mjs"),
    );
    await fs.utimes(path.join(dir, "scripts", "needs-build.mjs"), BEFORE, BEFORE);
    const run = () => {
      try {
        execFileSync(process.execPath, [path.join(dir, "scripts", "needs-build.mjs")], {
          env: { ...process.env, VITEST: "" },
          stdio: "ignore",
        });
        return 0;
      } catch (err) {
        return (err as { status: number }).status;
      }
    };
    expect(run()).toBe(1);
    await put("server/index.ts", AFTER);
    expect(run()).toBe(0);
  });
});
