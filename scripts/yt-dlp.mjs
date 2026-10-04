/**
 * yt-dlp for this computer. On Windows, youtube-dl-exec's installer downloads
 * yt-dlp.exe, which runs on its own. On macOS and Linux it downloads the
 * Python version of yt-dlp, which needs Python 3.10 or newer — that a Mac
 * doesn't have (or has 3.9, which yt-dlp no longer runs on). So this swaps it
 * for yt-dlp's standalone build for the system, which needs nothing else. It
 * runs after every `npm install` / `npm ci` (the package's postinstall).
 *
 *   node scripts/yt-dlp.mjs            make sure it's the standalone build
 *   node scripts/yt-dlp.mjs --update   get the newest yt-dlp (npm run update-yt-dlp)
 *
 * Plain JavaScript with no packages of its own, so it runs straight after an
 * install — in a copy of the source and in the ready-to-run build alike.
 */
import { spawnSync } from "child_process";
import { chmod, open, rename, rm, writeFile } from "fs/promises";
import { createRequire } from "module";

const DOWNLOADS = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/";

/**
 * The name of yt-dlp's standalone build for a system, or undefined where
 * youtube-dl-exec's own download is the one to use (Windows), or there's no
 * standalone build (32-bit ARM, say).
 */
export function standaloneBuild(platform, arch, glibc) {
  if (platform === "darwin") return "yt-dlp_macos"; // one build for Intel and Apple silicon
  if (platform !== "linux") return undefined;
  // Alpine and friends use musl instead of glibc.
  const linux = glibc ? "yt-dlp_linux" : "yt-dlp_musllinux";
  if (arch === "x64") return linux;
  if (arch === "arm64") return `${linux}_aarch64`;
  return undefined;
}

/**
 * Is this file the Python version of yt-dlp? That's a script ("#!/usr/bin/env
 * python3" and a zip); the standalone builds are programs (ELF, Mach-O).
 */
export function isPythonScript(firstBytes) {
  return firstBytes.length >= 2 && firstBytes[0] === 0x23 && firstBytes[1] === 0x21; // "#!"
}

/** The first bytes of a file, or undefined if there's no such file. */
async function readStart(file) {
  let handle;
  try {
    handle = await open(file, "r");
  } catch {
    return undefined;
  }
  try {
    const bytes = Buffer.alloc(4);
    const { bytesRead } = await handle.read(bytes, 0, 4, 0);
    return bytes.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Where the app runs yt-dlp from (youtube-dl-exec's bin folder). */
function ytDlpPath() {
  const require = createRequire(import.meta.url);
  return require("youtube-dl-exec/src/constants").YOUTUBE_DL_PATH;
}

/** Makes sure the standalone yt-dlp is in place. Never fails an install: it says what went wrong. */
async function ensureStandalone(file) {
  const glibc = Boolean(process.report?.getReport?.().header?.glibcVersionRuntime);
  const build = standaloneBuild(process.platform, process.arch, glibc);
  if (!build || process.env.YOUTUBE_DL_SKIP_DOWNLOAD) return;
  const start = await readStart(file);
  if (start && !isPythonScript(start)) return; // the standalone build already

  console.log(`yt-dlp: getting the standalone build for this computer (${build})...`);
  const part = `${file}.download`;
  try {
    const res = await fetch(DOWNLOADS + build);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await writeFile(part, Buffer.from(await res.arrayBuffer()));
    await chmod(part, 0o755);
    await rename(part, file);
    console.log(`yt-dlp: ${build} installed.`);
  } catch (err) {
    await rm(part, { force: true });
    console.warn(
      `yt-dlp: couldn't download ${build} (${err instanceof Error ? err.message : err}).`,
      start
        ? "The Python version stays, which needs Python 3.10 or newer."
        : "Run `npm run update-yt-dlp` once you're online.",
    );
  }
}

async function main() {
  const file = ytDlpPath();
  await ensureStandalone(file);
  if (process.argv.includes("--update")) {
    // yt-dlp updates itself in place, to the newest version of the same build.
    const { status } = spawnSync(file, ["-U"], { stdio: "inherit" });
    process.exitCode = status ?? 1;
  }
}

// Run, unless a test is importing it for the functions above.
if (!process.env.VITEST) await main();
