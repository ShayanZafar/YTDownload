/**
 * Whether a copy of the source code needs `npm run build` before it starts:
 * the start scripts (scripts/windows/app.ps1, scripts/unix/app.sh) run the
 * built app, which loads quicker than the development server, and build it
 * first when there's no build yet or any of the code it's made from changed
 * since (a git pull, or an edit). `node scripts/needs-build.mjs` exits 0 when
 * a build is needed, 1 when the build is up to date.
 *
 * Plain JavaScript with no packages of its own, like scripts/yt-dlp.mjs.
 */
import { readdir, stat } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

/** What the build is made from: these folders (all through) and files. */
export const BUILD_SOURCES = {
  folders: ["client", "server", "shared"],
  files: [
    "package.json",
    "package-lock.json",
    "vite.config.ts",
    "tsconfig.json",
    "components.json",
    "scripts/build.ts",
  ],
};

/** The file the build writes last (scripts/build.ts): there's a whole build when it's there. */
export const BUILT_FILE = "dist/index.cjs";

/** When `file` last changed, or undefined if it isn't there. */
const changedAt = (file) =>
  stat(file).then(
    (s) => s.mtimeMs,
    () => undefined,
  );

/** The newest change to any file under `dir` (0 if none, or it isn't there). */
async function newestIn(dir) {
  const items = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const times = await Promise.all(
    items.map((item) => {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) return item.name === "node_modules" ? 0 : newestIn(file);
      return item.isFile() ? changedAt(file) : 0;
    }),
  );
  return Math.max(0, ...times.map((t) => t ?? 0));
}

/** True when `root` has no build, or code changed after its build was made. */
export async function needsBuild(root) {
  const built = await changedAt(path.join(root, BUILT_FILE));
  if (built === undefined) return true;
  const times = await Promise.all([
    ...BUILD_SOURCES.folders.map((dir) => newestIn(path.join(root, dir))),
    ...BUILD_SOURCES.files.map((file) => changedAt(path.join(root, file))),
  ]);
  return times.some((t) => t !== undefined && t > built);
}

async function main() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  // Can't tell (an error reading the folder): build, to be safe.
  const needed = await needsBuild(root).catch(() => true);
  process.exit(needed ? 0 : 1);
}

if (!process.env.VITEST) await main();
